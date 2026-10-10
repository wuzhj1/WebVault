/**
 * vault store（Pinia）：笔记元数据、派生索引（文件树/双链/标签/卡片）与 OPFS 正文读写的唯一入口。
 *
 * 职责边界：正文永远写文件层（opfs），索引永远写 Dexie 并由 datafiles 落成 `.webvault` 数据文件
 * （文件为真相源、IndexedDB 只是缓存），正文与索引的最终一致由 reconcile 保证；
 * links/tags/cards 等派生数据随时可清空重建，不承载用户唯一内容。
 *
 * 硬约束/注意事项：
 * - NoteMeta 的 dirty/removedLocal 脏标记与墓碑语义直接被同步引擎（core/sync/engine.ts）消费，
 *   改动须与那边对齐；墓碑只在「远端曾有该文件」时才立（needsRemoteDelete）。
 * - 正文写入必须经过 saveBody 或 reindexContent 这条漏斗，否则链接/卡片索引会漂移。
 * - 重命名会改写全库入链并为旧路径留下远端删除墓碑，不能只动文件名。
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { db, putSetting, type CardRow, type LinkRow, type NoteMeta, type TagRow } from '@/core/db.ts'
import { dateOfDaily } from '@/core/daily.ts'
import { flushToFiles, hydrateFromFiles } from '@/core/vault/datafiles.ts'
// 键名只在 core/vault/config-layout.ts 声明一次，那里同时决定它落进 .webvault/workspace.json。
import { SETTING_KEYS } from '@/core/vault/config-layout.ts'
import { gitBlobSha } from '@/core/vault/hash.ts'
import * as opfs from '@/core/vault/opfs.ts'
import {
  dirOf,
  ensureMdExt,
  isNotePath,
  joinPath,
  normalizePath,
  titleOf,
} from '@/core/vault/paths.ts'
import { parseFrontmatter } from '@/core/parse/frontmatter.ts'
import { parseNote } from '@/core/parse/links.ts'
import { rewriteWikilinks } from '@/core/parse/rewrite.ts'
import {
  buildResolver,
  isAttachmentTarget,
  preferredLinkText,
  resolveTarget,
  resolverEquivalent,
  type Resolver,
} from '@/core/index/resolve.ts'
import { cardFromBody, frontmatterTagRows, isZid } from '@/core/zettel/card.ts'
import { needsRemoteDelete } from '@/core/sync/remote-diff.ts'
import { useUiStore } from '@/stores/ui.ts'

/** 文件树的一层节点：目录或笔记。 */
export interface TreeNode {
  name: string
  path: string
  kind: 'dir' | 'note'
  children: TreeNode[]
}

/** 反链面板的一条：谁链到了当前笔记。 */
export interface BacklinkEntry {
  path: string
  title: string
  line: number
  context: string
  embed: boolean
}

/** 出链面板的一条：当前笔记链去了哪里。 */
export interface OutgoingEntry {
  target: string
  targetPath: string | null
  alias: string | null
  heading: string | null
  embed: boolean
  line: number
  attachment: boolean
}

/** 生成一条全零的初始 NoteMeta，代表「从未同步过的新笔记」。 */
function newMeta(path: string): NoteMeta {
  return {
    path,
    title: titleOf(path),
    baseSha: null,
    localSha: null,
    remoteSha: null,
    mtime: Date.now(),
    fileMtime: null,
    size: 0,
    dirty: 0,
    cached: 0,
    removedLocal: 0,
    removedRemote: 0,
  }
}

/** 两条元数据是否逐字段相同 —— 内容没变就不该惊动响应式（见 reloadNotes）。 */
function sameMeta(a: NoteMeta, b: NoteMeta): boolean {
  return (
    a.path === b.path &&
    a.title === b.title &&
    a.baseSha === b.baseSha &&
    a.localSha === b.localSha &&
    a.remoteSha === b.remoteSha &&
    a.mtime === b.mtime &&
    a.fileMtime === b.fileMtime &&
    a.size === b.size &&
    a.dirty === b.dirty &&
    a.cached === b.cached &&
    a.removedLocal === b.removedLocal &&
    a.removedRemote === b.removedRemote
  )
}

/** 两张元数据列表是否逐条相同（含顺序）：reloadNotes 据此决定要不要替换 `notes.value`。 */
function sameNotes(a: readonly NoteMeta[], b: readonly NoteMeta[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!sameMeta(a[i], b[i])) return false
  }
  return true
}

/** 逐元素相等判断：让「重建出来的结果和现在一样」的那次重建不触发响应式失效。 */
function sameList<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!eq(a[i], b[i])) return false
  }
  return true
}

/** 「上次打开路径」落盘的防抖定时器，避免频繁写设置。 */
let lastOpenTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 把一条元数据换进内存列表（不存在则追加），避免每次保存都 `db.notes.toArray()` 全表重读。
 * 单条写入必然对应单条内存更新——DB 里那行就是刚 put 的 `meta`，两边不会不同步。
 */
function replaceMeta(list: readonly NoteMeta[], meta: NoteMeta): NoteMeta[] {
  const i = list.findIndex((n) => n.path === meta.path)
  if (i === -1) return [...list, meta]
  const next = list.slice()
  next[i] = meta
  return next
}

/** 浏览器不支持 OPFS 时的启动失败文案；init 与「改用内置存储」两条路径共用。 */
const OPFS_UNSUPPORTED_MSG =
  '当前浏览器不支持 OPFS(源私有文件系统),无法在本地保存笔记。请使用较新的 Chrome / Edge / Safari,并通过 HTTPS 或 localhost 访问。'

/** vault 主 store：元数据索引、派生状态与正文读写的集中入口。 */
export const useVaultStore = defineStore('vault', () => {
  /** 「最近打开」的记账人：ui store 只存本机书签，不反向依赖 vault，无循环引用。 */
  const ui = useUiStore()
  /** 元数据索引的内存镜像（Dexie notes 表全量）；shallowRef：整表替换而非逐项响应。 */
  const notes = shallowRef<NoteMeta[]>([])
  /** 初始化（OPFS 探测 + reconcile）完成后置真。 */
  const ready = ref(false)
  /** 当前打开笔记的路径；null = 没有打开。 */
  const activePath = ref<string | null>(null)
  /** 致命错误（如浏览器不支持 OPFS）；非 null 时应用应展示全屏错误并不再初始化。 */
  const fatal = ref<string | null>(null)
  /** OPFS 被清空、而元数据索引里仍有笔记时置位；sync store 据此触发从远端恢复正文。 */
  const storageWasWiped = ref(false)
  /** 存储后端：'opfs' 内置 / 'dir' 用户目录 / 'blocked' 目录待授权（授权前不置 ready）。 */
  const storageBackend = ref<opfs.StorageBackend>('opfs')
  /** 绑定的目录名；'dir' / 'blocked' 时非 null，授权屏与设置页展示用。 */
  const storageDirName = ref<string | null>(null)
  /** 指向当前笔记的反链列表。 */
  const inbound = shallowRef<BacklinkEntry[]>([])
  /** 当前笔记发出的出链列表。 */
  const outgoing = shallowRef<OutgoingEntry[]>([])
  /** 尚无对应笔记的链接目标，按出现次数倒序（附件目标除外）。 */
  const unresolvedTargets = shallowRef<string[]>([])
  /** 全库标签及计数，按次数倒序，供标签面板使用。 */
  const allTags = shallowRef<{ tag: string; count: number }[]>([])
  /**
   * 按日期分组的日记：`YYYY-MM-DD` → 该日所有日记路径（按 `titleOf` 排序）。
   * 供主区日历视图的格子列标题、侧栏 rail 徽标、打点共用这一份真相。
   * 直接从路径形状算出来（core/daily.ts），不新增 frontmatter 字段或 Dexie 列：
   * 新建/删除/改名都换掉 notes 数组，本 computed 自然跟着走，无需差额维护。
   */
  const dailyByDate = computed<ReadonlyMap<string, string[]>>(() => {
    const out = new Map<string, string[]>()
    for (const n of notes.value) {
      if (n.removedLocal) continue
      const d = dateOfDaily(n.path)
      if (!d) continue
      const list = out.get(d)
      if (list) list.push(n.path)
      else out.set(d, [n.path])
    }
    // 同一天的多篇按标题排序，而不是按数组顺序：后写入的排在后面会让格子里的列表
    // 每次重建都可能换位，用户刚看到的行转眼就跳走了。
    for (const list of out.values()) list.sort((a, b) => titleOf(a).localeCompare(titleOf(b)))
    return out
  })
  /**
   * 未解析目标 → 出现次数的**内存镜像**，与 `db.links` 始终同步：
   * `reindexContent` 在每次正文写入时按差额调整，`refreshDerived` 全量重建收口。
   * 有了它，保存路径刷新标签/未解析面板不必每次全表读 links/tags。
   */
  const unresolvedCount = new Map<string, number>()
  /** 标签 → 出现次数的内存镜像，与 `db.tags` 同步维护，维护点同上。 */
  const tagCount = new Map<string, number>()
  /**
   * 上一次漂移全量扫描完成时的 resolver。两次扫描之间它保持等价（`resolverEquivalent`），
   * 任何链接的 targetPath 都不可能改指，`refreshDerived` 即可跳过整段扫描与全表读。
   * null = 还没扫过（含清库），强制下一次全量。
   */
  let scannedResolver: Resolver | null = null
  /** 从 frontmatter 镜像出的卡片索引；纯派生数据，随时可从 OPFS 重建。 */
  const cards = shallowRef<CardRow[]>([])
  /** 同步引擎改写当前打开笔记的正文时自增，编辑器据此重新加载内容。 */
  const bodyRevision = ref(0)
  /**
   * 编辑器落盘状态：idle=没有待写内容、dirty=有未落盘的修改、saving=写入中、
   * saved=已写进 OPFS、error=写失败（内容还挂在 pendingValue 上等重试）。
   * 状态归编辑器写、顶栏读 —— 700ms 防抖窗口内用户完全看不出"改了到底存没存"，
   * 这是唯一能让那段时间可见的地方。error 不自动回落：下一次成功保存才翻回 saved。
   */
  const saveState = ref<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle')
  /** 最近一次成功落盘的时刻；顶栏显示「已保存 14:03」用，null = 本会话还没保存过。 */
  const savedAt = ref<number | null>(null)
  /**
   * 当前这篇的正文是否已在本机就位 —— 归编辑器写、顶栏读，与 `saveState` 同款分工。
   *
   * `readBody` 拿不到正文（`cached=0`，本机只有云端 stub）时编辑器会停在 loading，
   * 而 `applyEditable()` 见 `state !== 'ready'` 会把解锁原样丢掉。此时顶栏那把锁若照常翻转，
   * 徽标就会显示「编辑中」而正文一个字也打不进去 —— 这是「解锁了却不能编辑」的唯一来源。
   * 顶栏据此禁用锁、并把原因写进 title。
   */
  const bodyReady = ref(false)
  /**
   * 当前这篇是否已解锁可编辑 —— **库默认只读**，打开已有笔记一律上锁。
   *
   * 只有两条路能置真：`createNote` 刚真正写出的新笔记（走 `unlockOnOpen`）、用户在顶栏手动解锁。
   * 它是单篇状态：换文即上锁，不持久化、不同步、刷新页面回到只读 —— 一次手滑最多只碰坏一篇。
   * 写路径（saveBody / 同步 / 重命名）不认识这个开关，它只约束「编辑器是否可输入」。
   */
  const editable = ref(false)
  /** `createNote` 刚真正建出的路径；下一次 `openNote` 命中它才放行，否则按默认只读上锁。 */
  let unlockOnOpen: string | null = null

  /** path/标题/zid → 笔记的解析器，随 notes/cards 变化重建。 */
  const resolver = computed<Resolver>(() => buildResolver(notes.value, cards.value))
  /** path → NoteMeta 查表。 */
  const byPath = computed(() => new Map(notes.value.map((n) => [n.path, n])))
  /** path → CardRow 查表。 */
  const cardByPath = computed(() => new Map(cards.value.map((c) => [c.path, c])))

  /**
   * 内容版本号的廉价替代：任何一次保存都会改笔记的 mtime，进而改变这个累加和。
   * 搜索索引与相关卡片排序共用它——若各自算一份，会互相把模块级 MiniSearch 缓存打失效。
   */
  const revision = computed(() => {
    let r = 0
    for (const n of notes.value) r = (r * 31 + n.mtime + n.path.length) % 2147483647
    return r
  })

  /**
   * 侧边栏文件树：按路径推导，目录在前、同级按中文自然排序；已删（removedLocal）笔记不出现。
   * 目录节点按需逐级创建，父目录缺失时向上递归补齐。
   */
  const tree = computed<TreeNode[]>(() => {
    const root: TreeNode[] = []
    const dirs = new Map<string, TreeNode>()

    const ensureDir = (dirPath: string): TreeNode[] => {
      if (dirPath === '') return root
      const existing = dirs.get(dirPath)
      if (existing) return existing.children
      const node: TreeNode = {
        name: dirPath.slice(dirPath.lastIndexOf('/') + 1),
        path: dirPath,
        kind: 'dir',
        children: [],
      }
      dirs.set(dirPath, node)
      ensureDir(dirOf(dirPath)).push(node)
      return node.children
    }

    for (const n of notes.value) {
      if (n.removedLocal) continue
      ensureDir(dirOf(n.path)).push({
        name: n.title,
        path: n.path,
        kind: 'note',
        children: [],
      })
    }

    const sortNodes = (list: TreeNode[]): void => {
      list.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
      })
      for (const n of list) if (n.kind === 'dir') sortNodes(n.children)
    }
    sortNodes(root)
    return root
  })

  /** 当前打开笔记的元数据；没有打开或路径已失效时为 null。 */
  const activeNote = computed(() =>
    activePath.value ? byPath.value.get(activePath.value) ?? null : null,
  )
  /**
   * 待上传条数，驱动同步角标与「清空本机正文」的前置拦截。
   *
   * 只数**真正会被推上 Gitee** 的行：有本地改动的活笔记，加上「远端曾有过」的墓碑。
   * `remoteSha === null` 的墓碑不算 —— 引擎对它做的是本地清除（engine.push 直接删行），
   * 不是上传；算进来会让「删除一篇从未同步过的笔记」顶出一个永远推不出去的角标。
   */
  const pendingUpload = computed(
    () =>
      notes.value.filter((n) => (n.dirty && !n.removedLocal) || (n.removedLocal && n.remoteSha !== null)).length,
  )
  /** 已知存在于远端、但本地还没有正文（未缓存）的笔记，预取与按需下载都从这里取活。 */
  const uncached = computed(() => notes.value.filter((n) => !n.cached && !n.removedLocal))

  /** 启动入口：解析存储后端 →（内置时）申请持久化存储 → reconcile；任何一步失败都写入 fatal。 */
  async function init(): Promise<void> {
    try {
      storageBackend.value = await opfs.currentBackend()
      storageDirName.value = await opfs.dirName()
      // 目录待授权：授权屏接管、不置 ready —— 续期或改回内置存储后由对应动作补跑 reconcile。
      if (storageBackend.value === 'blocked') return
      if (storageBackend.value === 'opfs') {
        if (!opfs.isOpfsSupported()) {
          fatal.value = OPFS_UNSUPPORTED_MSG
          return
        }
        await opfs.persistedStorageGranted()
      }
      // `.webvault` 数据文件 → Dexie：文件为真相源，必须先于 reconcile 与一切设置读取跑。
      await hydrateFromFiles()
      await reconcile()
      ready.value = true
    } catch (err) {
      fatal.value = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * 让 OPFS 与元数据索引重新对齐。覆盖三种真实场景：应用之外新建的文件、
   * 应用之外删除的笔记，以及 Safari ITP 清空 OPFS 而 IndexedDB 幸存下来的情况。
   */
  async function reconcile(): Promise<void> {
    const stored = await db.notes.toArray()

    /**
     * 墓碑 = 「这个路径的本地正文不该存在」。先清正文，再决定墓碑留不留。
     * 顺序反过来的话，同一次对账就会把这个残留文件当成「索引外的新笔记」收养回来 ——
     * 删除或移动的旧路径就此复活，而且是带着 `dirty=1` 排进上传队列的复活。
     * 这正是「先删文件、后改索引」那条老路径中途崩溃时留下的现场。
     */
    for (const n of stored) {
      if (!n.removedLocal) continue
      try {
        await opfs.deleteNote(n.path)
      } catch {
        // 删不掉就留到下一轮：索引这侧已经是对的，一个孤儿文件不影响任何读写。
      }
    }

    const onDisk = new Set(await opfs.listNotePaths())

    // 远端从未有过的文件的墓碑永远推不出去；不清理的话它会一直挂在待上传计数里。
    const stale = new Set(
      stored.filter((n) => n.removedLocal && n.remoteSha === null).map((n) => n.path),
    )
    if (stale.size > 0) await db.notes.bulkDelete([...stale])
    const known = stored.filter((n) => !stale.has(n.path))

    // 墓碑不算「活笔记」：库里只剩待推的删除、盘上一份不剩，是用户把笔记全删光的正常状态。
    // 拿它判定「浏览器清空了缓存」会触发整库重新下载，把刚删掉的笔记原样拉回来。
    const live = known.filter((n) => !n.removedLocal)
    if (live.length > 0 && onDisk.size === 0) {
      storageWasWiped.value = true
      // 保留索引：sync store 会用 remoteSha 从 Gitee 把正文重新拉回来。
      const reset = live.map((n) => ({ ...n, cached: 0 as const }))
      await db.notes.bulkPut(reset)
      // 重新读全表而不是直接塞 reset —— 后者只装了活笔记，会把还没推的墓碑从内存里抹掉。
      notes.value = await db.notes.toArray()
      await refreshDerived()
      return
    }
    storageWasWiped.value = false

    const storedPaths = new Set(known.map((n) => n.path))
    const adopted: NoteMeta[] = []
    for (const path of onDisk) {
      if (storedPaths.has(path)) continue
      const content = (await opfs.readNote(path)) ?? ''
      const meta = newMeta(path)
      meta.localSha = await gitBlobSha(content)
      meta.baseSha = meta.localSha
      meta.size = content.length
      meta.cached = 1
      // 从未推送过，因此要随第一次同步一起上传。
      meta.dirty = 1
      adopted.push(meta)
      // 批量收养：循环里不刷内存 cards（每篇一次 = O(N²)），下面统一 refreshDerived 收口。
      await reindexContent(path, content, { deferCards: true })
    }
    if (adopted.length > 0) await db.notes.bulkPut(adopted)

    // 索引说已缓存、磁盘上却不见了的笔记：把 cached 打回 0，等按需重新下载；
    // 已是墓碑的不动（它本来就不该有正文）。
    const lost: NoteMeta[] = []
    for (const n of known) {
      if (n.removedLocal || onDisk.has(n.path)) continue
      lost.push(n.cached ? { ...n, cached: 0 } : n)
    }
    if (lost.length > 0) await db.notes.bulkPut(lost)

    // 文件在盘上而索引与之不符时，一律以文件为准重索引并标脏。两种后端的触发面不同：
    // 绑定目录后外部编辑器（VS Code 等）可能改过任何文件，故逐篇核对；内置 OPFS 没有
    // 外部写入者，只有「清空后又被恢复」会留下 cached=0 却在盘的行 —— 只查这些行，
    // 正常启动不必整库读正文。核对本身先用 fileMtime 做廉价判定（见循环内注释）。
    const dirBackend = (await opfs.currentBackend()) === 'dir'
    const suspects: NoteMeta[] = []
    for (const n of known) {
      if (n.removedLocal || !onDisk.has(n.path)) continue
      if (dirBackend || !n.cached) suspects.push(n)
    }
    if (suspects.length > 0) {
      const drift: NoteMeta[] = []
      for (const n of suspects) {
        // 廉价判定先行：先 stat 一次拿 lastModified，与索引里记下的一致就整篇不读。
        // 绑定目录后原本每次启动都要逐篇读正文 + 算 sha —— 大库等于启动即读完整个语料；
        // 而外部编辑器（VS Code 等）必然更新 lastModified，所以这一步把「核对」从
        // 「读全库 + 全量哈希」降成「一轮 stat」。stat 拿不到就照旧整篇读（安全分支）。
        const fm = await opfs.fileMtimeOf(n.path)
        if (n.cached && fm !== null && n.fileMtime === fm) continue
        const content = await opfs.readNote(n.path)
        if (content === null) continue
        const sha = await gitBlobSha(content)
        if (sha === n.localSha) {
          if (!n.cached) {
            // 文件在盘上、索引却标着没下载：顺手纠正，否则 readBody 会一直按 stub 拒绝。
            drift.push({ ...n, cached: 1, fileMtime: fm })
          } else if (fm !== null && n.fileMtime !== fm) {
            // 内容没变，只是索引里还没记下文件的修改时间（本机刚保存过 / 旧版 notes.json）：
            // 记下来，下一轮启动就走 stat 短路，不再整篇读。
            drift.push({ ...n, fileMtime: fm })
          }
          continue
        }
        await reindexContent(n.path, content, { deferCards: true })
        drift.push({
          ...n,
          localSha: sha,
          size: content.length,
          mtime: Date.now(),
          cached: 1,
          dirty: 1,
          fileMtime: fm,
        })
      }
      if (drift.length > 0) await db.notes.bulkPut(drift)
    }

    if ((await db.notes.count()) === 0 && onDisk.size === 0) {
      await db.links.clear()
      await db.tags.clear()
      await db.cards.clear()
      // 镜像计数与扫描基线一并作废：下面的 refreshDerived 会强制全量重建。
      unresolvedCount.clear()
      tagCount.clear()
      scannedResolver = null
    }

    notes.value = await db.notes.toArray()
    await refreshDerived()
  }

  /**
   * 设置页「选择目录」的编排：选择 → 把现有文件迁移进目录 → 落库绑定 → 对账。
   * 迁移先行、绑定落库在后：中途失败时后端仍停在 OPFS，不留「已绑定但没迁完」的半状态。
   * 用户在选择器里取消（AbortError）直接冒泡，由设置页按「无操作」处理。
   */
  async function bindDirectoryFlow(): Promise<opfs.MigrateResult> {
    // 迁移前先落盘：表里可能有还没进防抖窗口的更新，复制进新目录的 .webvault 必须是最新的。
    await flushToFiles(true)
    const handle = await opfs.pickDirectory()
    const result = await opfs.migrateOpfsTo(handle)
    await opfs.bindDirectory(handle)
    const kind = await opfs.currentBackend()
    if (kind !== 'dir') {
      // 选择器已按 readwrite 授权却仍拿不到权限的异常情况：回滚绑定，不停在不可用的后端上。
      await opfs.unbindDirectory()
      throw new Error('未能取得目录的读写权限,绑定已取消。')
    }
    storageBackend.value = kind
    storageDirName.value = await opfs.dirName()
    // 换了根就换真相源：新目录的 .webvault（迁移时复制过去的）覆盖表，再对账。
    await hydrateFromFiles()
    await reconcile()
    ready.value = true
    return result
  }

  /** 授权屏「重新授权」：用户手势内续期；成功后照常对账并进入 ready。 */
  async function grantDirAccess(): Promise<boolean> {
    const ok = await opfs.requestDirectoryPermission()
    if (!ok) return false
    storageBackend.value = 'dir'
    try {
      // 授权屏期间没能读文件（IO 阻断），续期后先以目录里的 .webvault 刷新表再对账。
      await hydrateFromFiles()
      await reconcile()
      ready.value = true
    } catch (err) {
      fatal.value = err instanceof Error ? err.message : String(err)
    }
    return true
  }

  /**
   * 「改用浏览器内置存储」：尽力把目录内容回写进 OPFS（无授权则跳过、文件原样留在目录里），
   * 再解除绑定并重新对账。回写失败不阻断解除 —— 解除本身不依赖读到目录内容。
   */
  async function unbindDirectoryFlow(): Promise<void> {
    // 回迁前先落盘：镜像进 OPFS 的 .webvault 才是最新状态。
    await flushToFiles(true)
    try {
      await opfs.migrateDirToOpfs()
    } catch {
      // 回迁尽力而为：OPFS 根不可用等极端情况仍要能解除绑定，由随后的对账如实反映本机状态。
    }
    await opfs.unbindDirectory()
    storageBackend.value = 'opfs'
    storageDirName.value = null
    if (!opfs.isOpfsSupported()) {
      fatal.value = OPFS_UNSUPPORTED_MSG
      return
    }
    try {
      // 根换回 OPFS（.webvault 已随镜像回到 OPFS 根）：装载后再对账。
      await hydrateFromFiles()
      await reconcile()
      ready.value = true
    } catch (err) {
      fatal.value = err instanceof Error ? err.message : String(err)
    }
  }

  /** 某行链接当前是否算「未解析」——空目标与附件目标不计，与漂移扫描后的汇总同一判据。 */
  function unresolvedRow(l: { target: string; targetPath: string | null }): boolean {
    return l.targetPath === null && l.target !== '' && !isAttachmentTarget(l.target)
  }

  /** 镜像计数增减；减到 0 不落表，返回「表是否真的变了」（决定要不要重排 ref）。 */
  function bumpCount(map: Map<string, number>, key: string, delta: number): boolean {
    const prev = map.get(key) ?? 0
    const next = prev + delta
    if (next > 0) {
      map.set(key, next)
      return next !== prev
    }
    if (prev !== 0) {
      map.delete(key)
      return true
    }
    return false
  }

  /**
   * unresolvedCount → unresolvedTargets（按次数倒序）。
   * 结果与当前值相等时不赋值：这两个 ref 每次 refreshDerived 都会被重建，
   * 无条件赋值等于每次同步都把侧栏对应面板重画一遍。
   */
  function rebuildUnresolvedRef(): void {
    const next = [...unresolvedCount.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t]) => t)
    if (!sameList(unresolvedTargets.value, next, (a, b) => a === b)) unresolvedTargets.value = next
  }

  /** tagCount → allTags（按次数倒序）；同样只在内容真的变了时才赋值。 */
  function rebuildTagRef(): void {
    const next = [...tagCount.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag, count]) => ({ tag, count }))
    if (!sameList(allTags.value, next, (a, b) => a.tag === b.tag && a.count === b.count)) allTags.value = next
  }

  /**
   * 刷新全部派生状态，顺序有讲究：先清理卡片表并重载 cards——下面的 resolver 要重新解析所有链接，
   * 而 `[[id]]` 形式的链接只有在 id 索引到位后才能解析；随后修正链接 targetPath 漂移、
   * 汇总未解析目标、统计标签计数，最后刷新当前笔记的双链面板。
   *
   * 漂移部分按「自上次扫描以来 resolver 是否等价」增量跳过：等价意味着没有任何 target 可能改指，
   * 两次扫描之间的计数差额已由 `reindexContent` 逐篇维护。不等价才全表读，且只回写真正漂了的行。
   */
  async function refreshDerived(): Promise<void> {
    // 必须先刷 cards：resolver 随后要重新解析所有链接，`[[id]]` 链接只有拿到 id 索引才解析得出。
    const cardRows = await db.cards.toArray()
    const live = new Set(notes.value.filter((n) => !n.removedLocal).map((n) => n.path))
    const staleCards = cardRows.filter((c) => !live.has(c.path))
    if (staleCards.length > 0) await db.cards.bulkDelete(staleCards.map((c) => c.path))
    cards.value = cardRows.filter((c) => live.has(c.path))

    const r = buildResolver(notes.value, cards.value)

    // 只有「从未扫过」或「与上次扫描时不等价」才需要动链接表：等价 ⇒ 任何 target 的答案
    // 都不可能变 ⇒ 逐篇差额维护着的未解析计数也一定准，整段扫描（全表读 + 回写）可跳过。
    if (scannedResolver === null || !resolverEquivalent(scannedResolver, r)) {
      const links = await db.links.toArray()
      const changed: LinkRow[] = []
      unresolvedCount.clear()
      for (const l of links) {
        const resolved = resolveTarget(r, l.target)
        if (resolved !== l.targetPath) {
          l.targetPath = resolved
          changed.push(l)
        }
        if (unresolvedRow(l)) bumpCount(unresolvedCount, l.target, 1)
      }
      // 只回写真正漂了的行：原先一次漂移就把整张 links 表 bulkPut 回去。
      if (changed.length > 0) await db.links.bulkPut(changed)
      scannedResolver = r
      rebuildUnresolvedRef()
    }

    // 标签表小得多，且这里是权威自愈点（外部直写的兜底），每次照旧全量重建。
    const tags = await db.tags.toArray()
    tagCount.clear()
    for (const t of tags) bumpCount(tagCount, t.tag, 1)
    rebuildTagRef()

    await refreshActiveLinks()
  }

  /** 重算当前笔记的入链/出链两个面板数据；没有激活笔记时清空两者。 */
  async function refreshActiveLinks(): Promise<void> {
    const path = activePath.value
    if (!path) {
      inbound.value = []
      outgoing.value = []
      return
    }
    const inRows = await db.links.where('targetPath').equals(path).toArray()
    inbound.value = inRows
      .filter((l) => l.src !== path)
      .sort((a, b) => a.src.localeCompare(b.src) || a.line - b.line)
      .map((l) => ({
        path: l.src,
        title: titleOf(l.src),
        line: l.line,
        context: l.context,
        embed: l.embed === 1,
      }))

    const outRows = await db.links.where('src').equals(path).toArray()
    outgoing.value = outRows
      .sort((a, b) => a.line - b.line)
      .map((l) => ({
        target: l.target,
        targetPath: l.targetPath,
        alias: l.alias,
        heading: l.heading,
        embed: l.embed === 1,
        line: l.line,
        attachment: isAttachmentTarget(l.target),
      }))
  }

  /**
   * 所有正文写入都要经过的漏斗，因此卡片索引与两个计数镜像的维护也只需放在这一处：
   * 事务内先读出该笔记的旧行、再删旧建新地重建链接/标签行并写入卡片；事务提交后按
   * 新旧行的差额调整未解析/标签计数——保存路径由此不必全表读也能刷新侧栏两个面板。
   *
   * @returns 该笔记的永久 id 出现、变化或消失时为 true——其他笔记的 `[[id]]` 链接可能因此改指，
   * 只有全量漂移扫描（refreshDerived）能发现这种情况。
   *
   * @param opts.deferCards 批量重建（reconcile 收养外部文件、设置页重索引、后台预取）时置真：
   *   循环内不回写内存 cards —— cards 一变，由它派生的 resolver 就重建一次，N 篇笔记循环
   *   就是 O(N²)；Dexie 侧照常写入，调用方收尾时统一 refreshDerived 一次性收口。
   */
  async function reindexContent(
    path: string,
    content: string,
    opts?: { deferCards?: boolean },
  ): Promise<boolean> {
    // 三个解析结果在这一次算齐、往下传：此前每保存一篇要 2×parseNote + 2×parseFrontmatter。
    const { links, tags } = parseNote(content)
    const fm = parseFrontmatter(content)
    const r = resolver.value

    const linkRows: LinkRow[] = links.map((l) => ({
      src: path,
      target: l.target,
      targetPath: resolveTarget(r, l.target),
      alias: l.alias,
      heading: l.heading,
      blockRef: l.blockRef,
      embed: l.embed ? 1 : 0,
      line: l.line,
      context: l.context,
    }))
    const tagRows: TagRow[] = [
      ...tags.map((t) => ({ tag: t.tag, path, line: t.line })),
      ...frontmatterTagRows(path, content, tags, fm),
    ]
    const card = cardFromBody(path, content, fm, tags)
    const zidChanged = (cardByPath.value.get(path)?.zid ?? '') !== card.zid

    let oldLinks: LinkRow[] = []
    let oldTags: TagRow[] = []
    await db.transaction('rw', db.links, db.tags, db.cards, async () => {
      // 差额的「旧值」必须与删除在同一事务里读出：库走到哪，内存计数就跟到哪。
      oldLinks = await db.links.where('src').equals(path).toArray()
      oldTags = await db.tags.where('path').equals(path).toArray()
      await db.links.where('src').equals(path).delete()
      await db.tags.where('path').equals(path).delete()
      if (linkRows.length) await db.links.bulkAdd(linkRows)
      if (tagRows.length) await db.tags.bulkAdd(tagRows)
      await db.cards.put(card)
    })
    // 事务提交后才动内存：中途抛出会直接跳过这里，镜像计数保持与库一致。
    let linksTouched = false
    for (const l of oldLinks) {
      if (unresolvedRow(l)) linksTouched = bumpCount(unresolvedCount, l.target, -1) || linksTouched
    }
    for (const l of linkRows) {
      if (unresolvedRow(l)) linksTouched = bumpCount(unresolvedCount, l.target, 1) || linksTouched
    }
    if (linksTouched) rebuildUnresolvedRef()
    let tagsTouched = false
    for (const t of oldTags) tagsTouched = bumpCount(tagCount, t.tag, -1) || tagsTouched
    for (const t of tagRows) tagsTouched = bumpCount(tagCount, t.tag, 1) || tagsTouched
    if (tagsTouched) rebuildTagRef()

    if (!opts?.deferCards) cards.value = [...cards.value.filter((c) => c.path !== path), card]
    return zidChanged
  }

  /** 读正文；stub（cached 为 0）直接返回 null，由调用方触发按需下载。 */
  async function readBody(path: string): Promise<string | null> {
    const meta = byPath.value.get(path)
    if (meta && !meta.cached) return null
    return opfs.readNote(path)
  }

  /** 打开笔记：切换 activePath、刷新双链，并防抖 400ms 落盘「上次打开路径」。 */
  async function openNote(path: string): Promise<void> {
    // 默认只读：换文一律上锁，只有刚 createNote 出来的那篇（unlockOnOpen 命中）按「新建即可编辑」放行。
    // 同一篇重复打开不改变锁态 —— 正编辑着误点了侧栏同一行，不该被打断回只读。
    const fresh = unlockOnOpen === path
    unlockOnOpen = null
    if (path !== activePath.value) editable.value = fresh
    else if (fresh) editable.value = true
    activePath.value = path
    // 所有打开入口（侧栏/搜索/图谱/右栏/启动定位）都汇到这里，「最近打开」只在此记一次账。
    ui.addRecent(path)
    await refreshActiveLinks()
    if (lastOpenTimer) clearTimeout(lastOpenTimer)
    lastOpenTimer = setTimeout(() => {
      lastOpenTimer = null
      void putSetting(SETTING_KEYS.lastOpenPath, path)
    }, 400)
  }

  /**
   * 同步引擎在我们背后改了元数据索引后，重新读取并刷新派生状态。
   *
   * 收敛点：一轮 syncAll 会调 4~8 次，其中多数什么都没改（索引没变、只是走个流程）。
   * 原先每次都无条件替换 `notes.value`，于是 byPath / tree / revision / pendingUpload
   * 一整串 computed 全部重算，侧栏整棵树跟着重新 patch —— 同步期间白抖这么多次。
   * 逐字段比对后，内容没变就完全不惊动响应式。
   */
  async function reloadNotes(): Promise<void> {
    const rows = await db.notes.toArray()
    if (!sameNotes(notes.value, rows)) notes.value = rows
    await refreshDerived()
  }

  /**
   * 只把卡片索引拉回内存，不重新解析任何链接。回填任务是分块直写 Dexie 的，
   * 若每块都跑一遍 refreshDerived，等于每次都全量扫描链接表，代价不可接受。
   */
  async function reloadCards(): Promise<void> {
    const live = new Set(notes.value.filter((n) => !n.removedLocal).map((n) => n.path))
    cards.value = (await db.cards.toArray()).filter((c) => live.has(c.path))
  }

  /** 同步引擎从网络写入一篇正文后调用：重读索引，若改的正是当前打开的笔记则让编辑器重载。 */
  async function notifyBodyChanged(path: string): Promise<void> {
    await reloadNotes()
    if (activePath.value === path) bodyRevision.value++
  }

  /** 把正文写入 OPFS 并刷新所有由它派生的状态（元数据、链接、标签、卡片）。 */
  async function saveBody(path: string, content: string, markDirty = true): Promise<NoteMeta> {
    // writeNote 直接把写完后的 lastModified 带回来：对账的廉价判定据此短路，省掉随后一次 stat。
    const fileMtime = await opfs.writeNote(path, content)
    const sha = await gitBlobSha(content)
    const prev = byPath.value.get(path)
    const meta: NoteMeta = {
      ...(prev ?? newMeta(path)),
      path,
      title: titleOf(path),
      localSha: sha,
      size: content.length,
      mtime: Date.now(),
      fileMtime,
      cached: 1,
      dirty: markDirty ? 1 : (prev?.dirty ?? 0),
      removedLocal: 0,
    }
    await db.notes.put(meta)
    const zidChanged = await reindexContent(path, content)
    // 只把这一条换进内存：原先每次保存都 db.notes.toArray() 全表重读，是一次多余的 O(n) IDB 往返。
    notes.value = replaceMeta(notes.value, meta)
    // 刚出现的 id、刚复活的墓碑都会让其他笔记里的链接改指，只有全量漂移扫描能发现 → 整套刷新；
    // 普通保存只刷当前笔记的双链——未解析/标签计数已由 reindexContent 的差额同步维护。
    if (activePath.value === path && !zidChanged && !prev?.removedLocal) await refreshActiveLinks()
    else await refreshDerived()
    return meta
  }

  /** 某路径是否已被**在用**的笔记占用：墓碑不算 —— 删完/移走后立刻同名重建是正常操作。 */
  function occupiedBy(path: string): boolean {
    const row = byPath.value.get(path)
    return row !== undefined && row.removedLocal === 0
  }

  /** 新建笔记：路径归一化并补 .md 后缀；路径非 .md 抛错，已存在则原样返回该路径（幂等）。 */
  async function createNote(rawPath: string, content = ''): Promise<string> {
    const path = normalizePath(ensureMdExt(rawPath))
    if (!isNotePath(path)) throw new Error('只能创建 .md 笔记')
    // 占用判定用 occupiedBy：路径上留着墓碑时必须放行并写正文，
    // 否则 createNote 会在「已有同名行」处早退，返回一个根本没有文件的路径。
    if (occupiedBy(path)) return path

    const fileMtime = await opfs.writeNote(path, content)
    const sha = await gitBlobSha(content)
    const meta: NoteMeta = {
      ...newMeta(path),
      localSha: sha,
      baseSha: sha,
      size: content.length,
      fileMtime,
      cached: 1,
      dirty: 1,
    }
    await db.notes.put(meta)
    await reindexContent(path, content)
    notes.value = replaceMeta(notes.value, meta)
    await refreshDerived()
    // 新建即可编辑：这次是真正写出的文件，紧随其后的 openNote 据此放行。
    // 走到「路径已被占用」早退分支的不算新建，那里不设这个标记。
    unlockOnOpen = path
    return path
  }

  /**
   * 重命名/移动笔记：搬正文、迁元数据与派生索引，并改写全库所有入链 `[[link]]`，
   * 避免静默变成悬空引用。目标已存在时抛错。
   */
  async function renameNote(from: string, rawTo: string): Promise<string> {
    const to = normalizePath(ensureMdExt(rawTo))
    if (from === to) return from
    if (occupiedBy(to)) throw new Error(`已存在同名笔记: ${to}`)

    const body = (await opfs.readNote(from)) ?? ''
    // 先把新路径写成：正文落盘是这一步唯一的硬失败点，失败时旧路径原封不动、索引还没动。
    const toMtime = await opfs.writeNote(to, body)

    const prev = byPath.value.get(from) ?? newMeta(from)
    await db.notes.delete(from)
    const meta: NoteMeta = {
      ...prev,
      path: to,
      title: titleOf(to),
      mtime: Date.now(),
      // 必须覆盖掉从旧路径继承来的 fileMtime：那是 `from` 文件的 mtime，对 `to` 是错的。
      fileMtime: toMtime,
      dirty: 1,
      cached: 1,
      removedLocal: 0,
    }
    await db.notes.put(meta)

    // git 记录移动就是「旧路径删除 + 新路径新增」，所以旧路径必须留一条墓碑排队推删除 ——
    // 但只有曾经上过远端（needsRemoteDelete）的才带 remoteSha，否则墓碑永远推不出去。
    // 从未上过远端的也照样留一条临时墓碑：它标记「这个路径不该再有正文」，
    // 让中途失败留下的旧文件能被下次对账清掉，而不是被当成新笔记收养回来（见 reconcile）。
    const remote = needsRemoteDelete(prev)
    const tombstone: NoteMeta = {
      ...newMeta(from),
      baseSha: remote ? prev.baseSha : null,
      remoteSha: remote ? prev.remoteSha : null,
      localSha: remote ? prev.localSha : null,
      cached: 0,
      dirty: 0,
      removedLocal: 1,
    }
    await db.notes.put(tombstone)

    await db.transaction('rw', db.links, db.tags, db.cards, async () => {
      const ownLinks = await db.links.where('src').equals(from).toArray()
      const ownTags = await db.tags.where('path').equals(from).toArray()
      const ownCard = await db.cards.get(from)
      await db.links.where('src').equals(from).delete()
      await db.tags.where('path').equals(from).delete()
      await db.cards.delete(from)
      if (ownLinks.length) await db.links.bulkAdd(ownLinks.map((l) => ({ ...l, src: to })))
      if (ownTags.length) await db.tags.bulkAdd(ownTags.map((t) => ({ ...t, path: to })))
      // id 存在文件里而非文件名里，因此随卡片原样迁移，zid 不变。
      if (ownCard) await db.cards.put({ ...ownCard, path: to })
    })

    await rewriteInboundLinks(from, to)
    if (activePath.value === from) activePath.value = to

    // 旧正文最后删：此时新正文已落盘、入链也改写完了，删失败只留下孤儿文件，
    // 由下次对账按墓碑清掉。这一步早先放在最前面 —— 一旦后续任何一步抛错，
    // 用户看到的是「重命名失败」，而盘上已经躺着两份、索引还指着旧路径。
    let fileGone = false
    try {
      await opfs.deleteNote(from)
      fileGone = true
    } catch (err) {
      console.error(`重命名后清理旧文件失败,临时墓碑留着让下次对账重试: ${from}`, err)
    }
    // 从未上过远端的临时墓碑：旧正文已经没了，它就到此为止 —— 留着只会让「待上传」
    // 多出一个永远推不出去的计数。远端有过的那条必须留着排队推删除。
    if (!remote && fileGone) await db.notes.delete(from)

    notes.value = await db.notes.toArray()
    await refreshDerived()
    return to
  }

  /** 把每篇其他笔记里的 `[[旧]]` 改写为 `[[新]]`，保留别名/标题锚点；返回改动篇数。 */
  async function rewriteInboundLinks(oldPath: string, newPath: string): Promise<number> {
    const oldTitle = titleOf(oldPath)
    const inboundRows = await db.links.where('targetPath').equals(oldPath).toArray()
    const sources = [...new Set(inboundRows.map((l) => l.src))].filter((s) => s !== newPath)

    const nextNotes = await db.notes.toArray()
    const futureResolver = buildResolver(
      nextNotes.map((n) => (n.path === oldPath ? { ...n, path: newPath, title: titleOf(newPath) } : n)),
    )
    const newText = preferredLinkText(futureResolver, newPath)

    let touched = 0
    for (const src of sources) {
      const body = await opfs.readNote(src)
      if (body === null) continue
      const { text, changed } = rewriteWikilinks(body, {
        shouldRewrite: (target) => {
          const t = target.trim()
          return (
            t === oldPath ||
            stripMd(t) === stripMd(oldPath) ||
            t.toLowerCase() === oldTitle.toLowerCase()
          )
        },
        replacement: () => newText,
      })
      if (changed === 0 || text === body) continue
      await opfs.writeNote(src, text)
      const sha = await gitBlobSha(text)
      const meta = byPath.value.get(src)
      if (meta) {
        await db.notes.put({ ...meta, localSha: sha, size: text.length, mtime: Date.now(), dirty: 1 })
      }
      // 批量改链：renameNote 收尾会统一 refreshDerived，循环里不必每篇刷一次内存 cards。
      await reindexContent(src, text, { deferCards: true })
      touched++
    }
    return touched
  }

  /**
   * 删除笔记：索引先行、正文随后。顺序反了（先删文件）的话，中途任何一次失败都会留下
   * 「索引说还在、盘上没有」的行，还没推送过的笔记连副本都找不回来。
   *
   * 所以即使远端从没有过这篇，也先落一条临时墓碑（remoteSha=null）：它把「这条路径应当没有
   * 正文」这一意图记进索引，万一正文没删掉，下次对账会按墓碑再删一次，而不是把残留文件当成
   * 新笔记收养回来。正文删成功后这条临时墓碑就地撤掉，不会一直挂在待上传计数里。
   */
  async function deleteNote(path: string): Promise<void> {
    const meta = byPath.value.get(path)
    // 只有「远端曾经有过这篇」才需要一条真正排队推删除的墓碑；
    // 其余情况的墓碑只是删除意图的临时记录，正文删掉就该就地撤掉。
    const pushDelete = meta !== undefined && needsRemoteDelete(meta)
    await db.notes.put(
      pushDelete
        ? { ...meta!, cached: 0, removedLocal: 1, dirty: 0, localSha: null }
        : { ...newMeta(path), cached: 0, removedLocal: 1, dirty: 0 },
    )
    await db.transaction('rw', db.links, db.tags, async () => {
      await db.links.where('src').equals(path).delete()
      await db.tags.where('path').equals(path).delete()
    })
    if (activePath.value === path) activePath.value = null

    // 正文随后删：索引已经记下意图，删失败也只是留下一个孤儿文件，下次对账按墓碑再清一次；
    // 顺序反过来的话，一次失败丢的就是再也补不回来的正文。这里不跨 store 弹提示（vault → sync
    // 会成环），失败现场留在控制台。
    let fileGone = false
    try {
      await opfs.deleteNote(path)
      fileGone = true
    } catch (err) {
      console.error(`删除正文文件失败,临时墓碑留着让下次对账重试: ${path}`, err)
    }

    if (!pushDelete && fileGone) {
      // 临时墓碑到此完成使命：留着会让「待上传」多出一个永远推不出去的计数，
      // 而正文已经没了，它唯一能防的「孤儿文件被收养回来」也不存在了。
      await db.notes.delete(path)
    }
    notes.value = await db.notes.toArray()
    await refreshDerived()
  }

  /** 从未解析的 `[[link]]` 创建新笔记时，新文件该落在哪里：带路径用其本身，否则放在当前笔记同目录。 */
  function pathForNewNote(target: string): string {
    const t = target.trim().replace(/^\.\//, '')
    const base = activePath.value ? dirOf(activePath.value) : ''
    return normalizePath(t.includes('/') ? ensureMdExt(t) : joinPath(base, ensureMdExt(t)))
  }

  /** 点击未解析的链接时调用：已能解析就跳过去，附件类型抛错，否则按链接目标新建笔记。 */
  async function createFromLink(target: string): Promise<string> {
    if (isAttachmentTarget(target)) throw new Error('附件类型暂不支持创建')
    const resolved = resolveTarget(resolver.value, target)
    if (resolved) return resolved
    return createNote(pathForNewNote(target))
  }

  /**
   * `[[` 自动补全弹层的链接建议：按 标题/id 前缀 > 标题/id 包含 > 路径包含 的打分排序，
   * 取前 30 条；查询本身无法解析时额外插一条「创建」项。
   */
  function suggestLinks(query: string): { html: string; value: string }[] {
    const q = query.trim().toLowerCase()
    const typed = query.trim()
    const pool = notes.value.filter((n) => !n.removedLocal)
    const scored = pool
      .map((n) => {
        const title = n.title.toLowerCase()
        const path = n.path.toLowerCase()
        const card = cardByPath.value.get(n.path)
        let score = -1
        if (q === '') score = 0
        else if (title.startsWith(q) || (card?.zid ?? '').startsWith(q)) score = 1
        else if (title.includes(q) || card?.aliases.some((a) => a.toLowerCase().includes(q))) score = 2
        else if (path.includes(q)) score = 3
        return { n, score }
      })
      .filter((s) => s.score >= 0)
      .sort((a, b) => a.score - b.score || a.n.title.localeCompare(b.n.title, 'zh-Hans-CN'))
      .slice(0, 30)

    // 用户完整敲出的 id 就是他想写的链接；这里若替换标题，等于悄悄改写用户意图。
    const idHit = isZid(typed) ? resolveTarget(resolver.value, typed) : null
    const items = scored.map(({ n }) => ({
      html: `<span class="hint-title">${escapeHtml(n.title)}</span><span class="hint-path">${escapeHtml(
        dirOf(n.path),
      )}</span>`,
      value: idHit !== null && idHit === n.path ? typed : preferredLinkText(resolver.value, n.path),
    }))

    if (q !== '' && resolveTarget(resolver.value, query) === null && !isAttachmentTarget(query)) {
      items.unshift({
        html: `<span class="hint-title">创建 “${escapeHtml(query.trim())}”</span><span class="hint-path">新笔记</span>`,
        value: query.trim(),
      })
    }
    return items
  }

  return {
    notes,
    ready,
    fatal,
    activePath,
    activeNote,
    storageWasWiped,
    storageBackend,
    storageDirName,
    tree,
    inbound,
    outgoing,
    unresolvedTargets,
    allTags,
    dailyByDate,
    cards,
    cardByPath,
    revision,
    pendingUpload,
    uncached,
    bodyRevision,
    saveState,
    savedAt,
    bodyReady,
    editable,
    resolver,
    byPath,
    init,
    reconcile,
    bindDirectoryFlow,
    grantDirAccess,
    unbindDirectoryFlow,
    openNote,
    notifyBodyChanged,
    reloadNotes,
    reloadCards,
    readBody,
    saveBody,
    createNote,
    renameNote,
    deleteNote,
    createFromLink,
    pathForNewNote,
    suggestLinks,
    reindexContent,
    refreshDerived,
  }
})

/** 去掉 `.md` 后缀（比较链接目标时用，大小写不敏感）。 */
function stripMd(p: string): string {
  return p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p
}

/** HTML 转义，供链接建议弹层拼 html 片段时防止标题里的标签被当真。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
