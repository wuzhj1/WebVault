/**
 * `.webvault/` 数据文件层：把 IndexedDB 里的全部业务数据（笔记元数据、链接/标签/卡片索引、
 * 设置、同步日志）以 JSON 文件落到 **vault 根** —— 绑定的正文目录；未绑定时是 OPFS 根。
 * 目录名与「表 → 文件」的分流规则都收在 config-layout.ts（纯模块，由验证脚本钉住），
 * 这里只负责 IO：读、写、留证与簿记。文件为真相源，IndexedDB 降级为运行时缓存：
 * - 启动与每次后端切换（绑定 / 换目录 / 授权 / 解绑）先 `hydrateFromFiles()`：以文件覆盖 Dexie
 *   表；文件缺失、损坏或读不出来才回退浏览器里现成的数据，随后回写修复 —— 被删掉的 `.webvault`
 *   就此重建。搬进一个装着旧版文件的目录时，还会顺手把 `.config/` 一次性迁过来。
 * - 运行期给六张表注册 Dexie hooks，任何写入防抖 300ms 后全量落盘；页面隐藏或关闭时强刷一次。
 *
 * settings 是唯一「一表多文件」的表：按职责拆成 sync / app / hotkeys / workspace 四个文件
 * （对标 Obsidian 的配置目录形状），行归哪个文件由 config-layout 的 `settingsFileOf` 决定。
 * 拆开的好处是敏感配置单独成文件（共享整个库前只清 `sync.json`），且高频变动的 `workspace.json`
 * 与静态配置分开；代价是 hydrate / flush 要按档处理 —— 三条规则见 hydrateFromFiles 与 doFlush。
 *
 * 两个例外与已知取舍：
 * - 目录句柄（config 表）是浏览器私有对象，存不进文件，只能留在 IndexedDB；
 * - `sync.json` 里的 Gitee token 是明文 —— 浏览器里本来也是明文，但备份、共享整个文件夹时
 *   会一并带走（设置页有提醒，导出 zip 会先把它抹空）；崩溃时最多丢最后一个防抖窗口内的表更新，
 *   正文文件不受影响，下次 reconcile 按「文件为准」对账。
 *
 * 反向的两条护栏（「文件为真相源」的例外，见 hydrateFromFiles / doFlush）：
 * - 读文件失败或本地还有未落盘写入时，浏览器数据优先，不许被文件覆盖、也不许回写盖掉文件；
 * - 落盘失败通过 onFlushError 抛给界面 —— 静默失败会让「文件是真相源」这句话在用户不知情时失效。
 *
 * 硬约束：只用相对导入；读写全经 opfs 模块，后端分发会自动路由到当前绑定的根，
 * 未授权（blocked）时 IO 失败被静默跳过而不是退回 OPFS —— 两个来源混读正是要防的事。
 */
import { db } from '../db.ts'
import {
  CONFIG_DIR,
  LEGACY_CONFIG_DIR,
  LEGACY_SETTINGS_FILE,
  TABLE_FILES,
  fileOfRow,
  filesOf,
  parseRows,
  partitionRows,
} from './config-layout.ts'
import { createFlushState } from './flush-state.ts'
import {
  currentBackend,
  deleteNote,
  existsNote,
  listTopDir,
  readNote,
  removeTopDir,
  writeNote,
} from './opfs.ts'

/** hydrate 进行中：装载时的 clear + 灌入不得再触发「表变了」→ 落盘。 */
let hydrating = false
/**
 * 落盘簿记（哪些表脏了 / 写到第几代 / 失败有没有报过），逻辑在 flush-state.ts ——
 * 那里是纯状态机，竞态用例由 scripts/verify-flush-state.mts 钉住；本文件只管 IO。
 */
const state = createFlushState()
/**
 * 本轮 hydrate 里读文件抛错（IO 毛刺，不是「文件不存在」）的表。
 * 这类表既不许被文件覆盖（文件内容没读到，不能假定它对），也不许参与尾部的 force 回写
 * —— 否则一次瞬时读失败就会把浏览器里可能过期的数据盖到一个其实是好的文件上。
 * 只在 hydrate 的尾部 flush 期间生效，hydrate 结束即清空，之后的正常落盘不受影响。
 */
let skipForce = new Set<string>()
/** 防抖计时器。 */
let timer: ReturnType<typeof setTimeout> | null = null
/** 落盘串行链：并发 flush 排队执行，同一文件不会交叉写。 */
let chain: Promise<void> = Promise.resolve()
/** hooks 与页面事件只注册一次（后端切换会反复调 hydrate）。 */
let persistStarted = false

/** flush 失败的监听器：core 层不 import 任何 store，报错出口由 App.vue 注册进来。 */
const flushListeners = new Set<(file: string, err: unknown) => void>()

/**
 * 订阅 `.webvault` 落盘失败，返回退订函数。只在「首次失败」时回调（见 flush-state 的 settleFail），
 * 否则页面隐藏时的强刷会把同一条错误刷成一串提示。
 */
export function onFlushError(cb: (file: string, err: unknown) => void): () => void {
  flushListeners.add(cb)
  return () => flushListeners.delete(cb)
}

/** 触发所有订阅者；监听器自身抛错不影响落盘流程。 */
function reportFlushError(file: string, err: unknown): void {
  for (const cb of flushListeners) {
    try {
      cb(file, err)
    } catch {
      // 订阅方的 bug 不该把落盘链路带崩
    }
  }
}

/**
 * 旧版 `.config/` → `.webvault/` 一次性搬迁，顺带把旧版挤在一个 `settings.json` 里的设置
 * 按职责拆成 sync / app / hotkeys / workspace 四个文件。
 *
 * 每次 hydrate 都先跑一遍：没有旧目录时只花一次 `getDirectoryHandle` 就返回；反过来，用户换到
 * 一个装着旧版文件的目录时它会自动补做 —— 迁移不依赖「数据装在哪台机器、哪次启动」。
 * 三条纪律：
 * - **目标已存在的文件绝不覆盖**（新版数据优先），但旧的那份照样算「已有归宿」才删；
 * - **先写新、后删旧**：中途崩溃最多留下两份，绝不会哪边都没有；
 * - **不递归删**：旧目录里没认领的文件（用户自己放的）一律不动，整个目录删不掉就整个留着。
 */
async function migrateLegacyConfigDir(): Promise<void> {
  const legacy = await listTopDir(LEGACY_CONFIG_DIR)
  if (legacy.length === 0) return
  const moved: string[] = []
  for (const name of legacy) {
    const text = await readNote(`${LEGACY_CONFIG_DIR}/${name}`)
    // 读不出来（并发删除、权限毛刺）就原样留着，下轮 hydrate 再来。
    if (text === null) continue
    if (await placeLegacy(name, text)) moved.push(name)
  }
  for (const name of moved) {
    try {
      await deleteNote(`${LEGACY_CONFIG_DIR}/${name}`)
    } catch {
      // 删不掉就留着：下轮只会空转一次「目标已存在」的判定，不影响正确性。
    }
  }
  await removeTopDir(LEGACY_CONFIG_DIR)
}

/**
 * 把一份旧文件放到新位置，返回「已有归宿」。
 * `settings.json` 要按职责拆成四份、四份都就位才算归宿；其余（含 `*.corrupt` 留证）原样搬一份。
 * 解析不了的 `settings.json` 也走原样搬 —— 它是坏的，但照样是用户那台机器上仅有的那份。
 */
async function placeLegacy(name: string, text: string): Promise<boolean> {
  if (name !== LEGACY_SETTINGS_FILE) return putIfAbsent(`${CONFIG_DIR}/${name}`, text)
  const rows = parseRows(text)
  if (rows === null) return putIfAbsent(`${CONFIG_DIR}/${name}`, text)

  const files = filesOf('settings')
  const groups = partitionRows('settings', files, rows)
  let ok = true
  for (const file of files) {
    const body = JSON.stringify(groups.get(file) ?? [], null, 1)
    // 有意不写成 `ok &&= await ...`：短路会让后面几档压根不写，半套搬迁反而更难收敛。
    const placed = await putIfAbsent(`${CONFIG_DIR}/${file}`, body)
    ok = placed && ok
  }
  return ok
}

/**
 * 目标已存在就不写（新版数据优先）；返回这份旧文件是否「已有归宿」——
 * 要么刚写进去，要么目标早就在。写失败返回 false，旧的那份原样留着等下一轮。
 */
async function putIfAbsent(to: string, text: string): Promise<boolean> {
  try {
    if (await existsNote(to)) return true
    await writeNote(to, text)
    return true
  } catch {
    return false
  }
}

/**
 * 以 `.webvault` 文件覆盖 Dexie 表。文件为真相源；逐表独立处理，
 * 一个文件缺失/损坏不影响其余表。尾部回写：兜底数据落成文件、损坏文件被修复
 * （唯一例外是「压根没读到」的表，见 skipForce —— 那时文件究竟是不是好的无从判断）。
 *
 * settings 一表四档，读的纪律按**整张表**而不是按档：一档坏就整张表按坏处理。
 * 理由是半份覆盖更危险 —— 表被 clear 成「三档的并集」，坏掉那档里的设置会被另外三档顶掉，
 * 而且尾部回写会把这半份固化下来；整张表跳过则最坏也就是什么都不变。
 *
 * 「文件为真相源」不等于「无条件覆盖」，三种情况必须让浏览器数据赢：
 * - 读文件抛错（IO 毛刺）：文件内容根本没读到，既不能拿来覆盖表，也不能让尾部回写盖掉它；
 * - 本地还有没落盘的写入（dirty）：那几行比文件新，覆盖等于把它们抹掉；
 * - 行与表结构不符（事务回滚）：表里现成的数据是可用的，文件才是坏的那一个。
 *
 * 一档缺失时只保那**一档**的行：文件没读到 ≠ 用户删了它，与单文件时代「缺失即兜底、
 * 尾部回写重建」的语义一档一档地对齐（删掉 `workspace.json` 不会让最近/置顶从表里蒸发）。
 */
export async function hydrateFromFiles(): Promise<void> {
  hydrating = true
  skipForce = new Set<string>()
  try {
    // 搬迁必须先于一切读取：接下来读的全是新目录，旧目录里的那份还躺着就该先挪过来。
    try {
      await migrateLegacyConfigDir()
    } catch (err) {
      // 搬迁失败不该拖死启动：按新目录继续，浏览器数据仍是可用兜底，下轮 hydrate 会重试。
      console.error('配置目录搬迁失败,本次按新目录继续:', err)
    }

    for (const [table, files] of TABLE_FILES) {
      // 读失败（存储瞬时不可用、权限毛刺）一律按「整张表没读到」回退浏览器数据，不拖死启动；
      // 存储真不可用会在随后的 reconcile 如实暴露成 fatal，不会静默装作没事。
      // 但这种表要挂进 skipForce：压根没读到内容，既不能拿它覆盖表，也不能让尾部回写反过来盖掉它。
      const texts: { file: string; text: string }[] = []
      let readFailed = false
      for (const file of files) {
        let text: string | null = null
        try {
          text = await readNote(`${CONFIG_DIR}/${file}`)
        } catch {
          readFailed = true
          break
        }
        // 文件不存在 → 不算「读到」，由下面的 texts 为空 / 缺档逻辑处理。
        if (text !== null) texts.push({ file, text })
      }
      if (readFailed) {
        skipForce.add(table)
        continue
      }
      // 一档都没有 → 保持浏览器里现成的数据（兜底），由尾部 flush 写回文件。
      if (texts.length === 0) continue

      // 解析一遍并顺手找坏档：一档坏就整张表回退浏览器数据，尾部回写会把它修好；修复即销毁，先留证。
      const rows: unknown[] = []
      let corrupt: { file: string; text: string } | null = null
      for (const { file, text } of texts) {
        const parsed = parseRows(text)
        if (parsed === null) {
          corrupt = { file, text }
          break
        }
        rows.push(...parsed)
      }
      if (corrupt) {
        await keepCorruptEvidence(corrupt.file, corrupt.text)
        continue
      }
      // 本地有未落盘的写入：表比文件新，保留表，由尾部回写把新数据写成文件。
      if (state.isDirty(table)) continue

      const present = new Set(texts.map((t) => t.file))
      try {
        // 读现成的行、clear、灌入放同一事务：行形状对不上时整体回滚，表不会停在被清空的状态。
        await db.transaction('rw', db.table(table), async () => {
          const t = db.table(table)
          // 缺档时把「归那几档」的行留下；全档齐备就没人要留，省掉一次整表序列化。
          const existing = present.size < files.length ? await t.toArray() : []
          await t.clear()
          const kept = existing.filter((row) => !present.has(fileOfRow(table, files, row)))
          const all = rows.concat(kept)
          if (all.length > 0) await t.bulkPut(all as never)
        })
      } catch {
        // 行与表结构不符 = 这份文件对该表同样是坏的：留证、保留浏览器数据，尾部回写负责修复。
        const first = texts[0]
        if (first) await keepCorruptEvidence(first.file, first.text)
      }
    }
  } finally {
    hydrating = false
  }
  startFilePersist()
  try {
    await flushToFiles(true)
  } finally {
    // 必须在尾部回写结束后才摘：跳过清单只护着这一轮，之后的正常落盘不该受影响。
    skipForce = new Set<string>()
  }
}

/**
 * 损坏的数据文件留一份原样副本再让覆盖式回写把它修好 —— 修复即销毁，
 * 没有这份副本就再也查不出「里面原本是什么、是怎么坏的」。
 * 写副本失败只当没这回事：留证是加分项，不能反过来挡住修复。
 */
async function keepCorruptEvidence(file: string, text: string): Promise<void> {
  try {
    await writeNote(`${CONFIG_DIR}/${file}.corrupt`, text)
  } catch {
    // 见上：留证失败不影响主流程
  }
}

/** 注册六张表的写监听与页面生命周期强刷；幂等，只有第一次生效。 */
function startFilePersist(): void {
  if (persistStarted) return
  persistStarted = true
  for (const [table] of TABLE_FILES) {
    const onWrite = (): void => {
      if (hydrating) return
      state.markWrite(table)
      schedule()
    }
    const t = db.table(table)
    // Dexie 的 creating/updating/deleting 对 put、bulkPut、clear、modify 一视同仁，
    // 覆盖所有写入路径而不用挨个业务调用点双写。
    t.hook('creating', onWrite)
    t.hook('updating', onWrite)
    t.hook('deleting', onWrite)
  }
  if (typeof window !== 'undefined') {
    // 页面隐藏/关闭只需把「改过而没存」的表推下去，而脏标就是那份清单 —— force（全量）
    // 留给 hydrate 尾部：那里表没脏，但文件可能缺失或损坏，必须照表写一遍才能补上。
    // 原先这里也用 force，等于每次切标签页都把六张表全量序列化一遍，大库上白烧。
    window.addEventListener('pagehide', () => void flushToFiles())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushToFiles()
    })
  }
}

/** 防抖 300ms：合并连续写入（reconcile 一次能触发几十次 hook），窗口内页面隐藏则立即强刷。 */
function schedule(): void {
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void flushToFiles()
  }, 300)
}

/**
 * 把表写成 `.webvault` 文件。force = 无视脏标全量写，**只给「文件本身可能不对」的场合**用：
 * hydrate 尾部（文件缺失/损坏要照表补上）与换后端前的落盘（迁移要拷到完整的一份）。
 * 日常落盘一律传 false —— 脏标加代次已经能准确圈出真正需要写的表。
 * 返回的 Promise 永不 reject：串行排队，失败逐表捕获并留在脏标里等下一轮。
 */
export function flushToFiles(force = false): Promise<void> {
  chain = chain.then(
    () => doFlush(force),
    () => doFlush(force),
  )
  return chain
}

async function doFlush(force: boolean): Promise<void> {
  // 目录未授权：文件 IO 必须阻断而不是退回 OPFS，静默跳过即可 —— 数据仍在浏览器缓存里。
  if ((await currentBackend()) === 'blocked') return
  for (const [table, files] of TABLE_FILES) {
    if (!force && !state.isDirty(table)) continue
    // hydrate 刚读失败的表：文件内容没读到，尾部回写会把一个其实是好的文件盖掉。
    if (force && skipForce.has(table)) continue
    // 落笔前先记下代次：写文件期间若有新写入，代次会变，脏标就不能摘（见 flush-state）。
    const gen = state.gen(table)
    // 报错时要能指名道姓是哪一档炸了；进来就设成首档，兜底也不会报出空路径。
    let current = files[0] ?? ''
    try {
      const rows = await db.table(table).toArray()
      const groups = partitionRows(table, files, rows)
      // 分流的硬不变量：每一行都得有桶。对不上说明键名注册表和行结构脱节了 ——
      // 与其写出去半份、下一轮再把错的固化，不如整表判失败、留在脏标里并惊动用户。
      let placed = 0
      for (const bucket of groups.values()) placed += bucket.length
      if (placed !== rows.length) {
        throw new Error(`分流把 ${rows.length} 行安排进了 ${placed} 个桶,拒绝落盘`)
      }
      for (const file of files) {
        current = file
        await writeNote(`${CONFIG_DIR}/${file}`, JSON.stringify(groups.get(file) ?? [], null, 1))
      }
      state.settleOk(table, gen)
    } catch (err) {
      // 返回 true = 这是该表当前这一轮的首次失败，才值得惊动用户。
      if (state.settleFail(table)) reportFlushError(current, err)
      console.error(`写入 ${CONFIG_DIR}/${current} 失败:`, err)
    }
  }
}
