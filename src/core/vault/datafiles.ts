/**
 * `.config/` 数据文件层：把 IndexedDB 里的全部业务数据（笔记元数据、链接/标签/卡片索引、
 * 设置、同步日志）以 JSON 文件落到 **vault 根** —— 绑定的正文目录；未绑定时是 OPFS 根。
 * 文件为真相源，IndexedDB 降级为运行时缓存：
 * - 启动与每次后端切换（绑定 / 换目录 / 授权 / 解绑）先 `hydrateFromFiles()`：以文件覆盖 Dexie
 *   表；文件缺失或损坏才回退浏览器里现成的数据，随后立即回写修复 —— 被删掉的 `.config` 就此重建。
 * - 运行期给六张表注册 Dexie hooks，任何写入防抖 300ms 后全量落盘；页面隐藏或关闭时强刷一次。
 *
 * 两个例外与已知取舍：
 * - 目录句柄（config 表）是浏览器私有对象，存不进文件，只能留在 IndexedDB；
 * - settings.json 里的 Gitee token 是明文 —— 浏览器里本来也是明文，但备份、共享整个文件夹时
 *   会一并带走（设置页有提醒）；崩溃时最多丢最后一个防抖窗口内的表更新，正文文件不受影响，
 *   下次 reconcile 按「文件为准」对账。
 *
 * 硬约束：只用相对导入；读写全经 opfs 模块，后端分发会自动路由到当前绑定的根，
 * 未授权（blocked）时 IO 失败被静默跳过而不是退回 OPFS —— 两个来源混读正是要防的事。
 */
import { db } from '../db.ts'
import { CONFIG_DIR, currentBackend, readNote, writeNote } from './opfs.ts'

/**
 * 六张业务表 → 文件名。config 表存目录句柄，不进文件（见文件头）。
 * 统一是「行数组」形状：`JSON.parse` 出来的必须是数组，否则按损坏回退。
 */
const TABLE_FILES = [
  ['notes', 'notes.json'],
  ['links', 'links.json'],
  ['tags', 'tags.json'],
  ['cards', 'cards.json'],
  ['settings', 'settings.json'],
  ['syncLog', 'sync-log.json'],
] as const

/** hydrate 进行中：装载时的 clear + 灌入不得再触发「表变了」→ 落盘。 */
let hydrating = false
/** 写过后还没落盘的表；flush 成功才摘掉，失败留着下一轮重试。 */
const dirty = new Set<string>()
/** 防抖计时器。 */
let timer: ReturnType<typeof setTimeout> | null = null
/** 落盘串行链：并发 flush 排队执行，同一文件不会交叉写。 */
let chain: Promise<void> = Promise.resolve()
/** hooks 与页面事件只注册一次（后端切换会反复调 hydrate）。 */
let persistStarted = false

/**
 * 以 `.config` 文件覆盖 Dexie 表。文件为真相源；逐表独立处理，
 * 一个文件缺失/损坏不影响其余表。尾部无条件全量回写：兜底数据落成文件、损坏文件被修复。
 */
export async function hydrateFromFiles(): Promise<void> {
  hydrating = true
  try {
    for (const [table, file] of TABLE_FILES) {
      // 读失败（存储瞬时不可用、权限毛刺）一律按「文件缺失」回退浏览器数据，不拖死启动；
      // 存储真不可用会在随后的 reconcile 如实暴露成 fatal，不会静默装作没事。
      let text: string | null = null
      try {
        text = await readNote(`${CONFIG_DIR}/${file}`)
      } catch {
        continue
      }
      // 文件不存在 → 保持浏览器里现成的数据（兜底），由尾部 flush 写回文件。
      if (text === null) continue
      let rows: unknown
      try {
        rows = JSON.parse(text)
      } catch {
        continue // 文件损坏 → 同样回退浏览器数据，尾部 flush 顺手覆盖修复。
      }
      if (!Array.isArray(rows)) continue
      try {
        // clear 与灌入放同一事务：行形状对不上时整体回滚，表不会停在被清空的状态。
        await db.transaction('rw', db.table(table), async () => {
          const t = db.table(table)
          await t.clear()
          if (rows.length > 0) await t.bulkPut(rows as never)
        })
      } catch {
        continue // 行与表结构不符 → 事务已回滚，浏览器数据原样保留。
      }
    }
  } finally {
    hydrating = false
  }
  startFilePersist()
  await flushToFiles(true)
}

/** 注册六张表的写监听与页面生命周期强刷；幂等，只有第一次生效。 */
function startFilePersist(): void {
  if (persistStarted) return
  persistStarted = true
  for (const [table] of TABLE_FILES) {
    const onWrite = (): void => {
      if (hydrating) return
      dirty.add(table)
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
    window.addEventListener('pagehide', () => void flushToFiles(true))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushToFiles(true)
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
 * 把表写成 `.config` 文件。force = 无视 dirty 集合全量写（hydrate 尾部与页面隐藏时用）。
 * 返回的 Promise 永不 reject：串行排队，失败逐表捕获并留在 dirty 里等下一轮。
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
  for (const [table, file] of TABLE_FILES) {
    if (!force && !dirty.has(table)) continue
    try {
      const rows = await db.table(table).toArray()
      await writeNote(`${CONFIG_DIR}/${file}`, JSON.stringify(rows, null, 1))
      dirty.delete(table)
    } catch (err) {
      dirty.add(table)
      console.error(`写入 .config/${file} 失败:`, err)
    }
  }
}
