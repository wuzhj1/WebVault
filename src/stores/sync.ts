/**
 * sync store（Pinia）：同步的调度与状态呈现。
 *
 * 职责：串行化 syncAll、防抖推送、后台预取（preheat）、按需正文下载、通知与同步日志；
 * 真正的同步算法全部在 core/sync/engine.ts，本层只负责触发、合并调用与把结果转成 UI 状态。
 *
 * 硬约束/注意事项：
 * - 同一时刻只允许一轮同步：running 复用同一个 Promise，后来的调用直接 await 它。
 * - 预取有 preheating 单飞保护：Gitee 限流头跨域读不到，重叠循环会白白烧掉不可度量的配额。
 * - quiet 触发不弹「未配置/离线」提示，只有用户显式操作才打扰。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { db, logSync, type SyncLogRow } from '@/core/db.ts'
import type { SyncProgress, SyncSummary } from '@/core/sync/engine.ts'
import * as engine from '@/core/sync/engine.ts'
import { GiteeError, testConnection } from '@/core/sync/gitee.ts'
import { useSettingsStore } from './settings.ts'
import { useVaultStore } from './vault.ts'

/** 单轮后台预取最多下载多少篇正文。 */
const PREHEAT_BATCH = 25
/** 常规提示到点自动淡出；警告与错误停在列表里等用户手动关闭。 */
const INFO_NOTICE_MS = 6_000

/** 一条通知：id 供关闭定位，kind 决定样式以及是否自动消失。 */
export interface Notice {
  id: number
  kind: 'info' | 'warn' | 'error'
  text: string
}

/** sync store：同步调度、进度/结果状态、通知与日志。 */
export const useSyncStore = defineStore('sync', () => {
  /** 是否有同步正在进行（与 running 配套）。 */
  const syncing = ref(false)
  /** 引擎回传的最新进度，供进度条与状态栏渲染。 */
  const progress = ref<SyncProgress>({ phase: 'idle', message: '', current: 0, total: 0 })
  /** 最近一轮同步的汇总（含错误与冲突列表）。 */
  const lastSummary = ref<SyncSummary | null>(null)
  /** 最近一次同步完成的时间戳；null = 还没同步过。 */
  const lastSyncAt = ref<number | null>(null)
  /** 最近一次失败原因；新一轮成功后清空。 */
  const lastError = ref<string | null>(null)
  /** navigator.onLine 快照，随 online/offline 事件更新。 */
  const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine)
  /** 同步日志（最近 120 条，新在前）。 */
  const log = ref<SyncLogRow[]>([])
  /** 当前展示的通知列表。 */
  const notices = ref<Notice[]>([])
  /** 连接测试结果文案，供设置页展示；null = 尚未测试。 */
  const connectionInfo = ref<string | null>(null)

  /** schedulePush 的防抖定时器。 */
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  /** 进行中的同步 Promise，用于把并发调用合并进同一次运行。 */
  let running: Promise<SyncSummary> | null = null
  /** 预取单飞标志，防止多个触发源叠加下载。 */
  let preheating = false
  /** init 幂等标志：监听器与 watcher 只挂一次，重复调用直接返回（见 init 的注释）。 */
  let initialized = false
  /** 通知 id 自增器。 */
  let noticeSeq = 0
  /** info 通知自动消失的定时器，按通知 id 存放。 */
  const noticeTimers = new Map<number, ReturnType<typeof setTimeout>>()

  /** 同步入口是否可用：已配置且在线。 */
  const available = computed(() => useSettingsStore().configured && online.value)
  /** 状态栏文案优先级：同步中 > 未配置 > 离线 > 上次失败 > 已同步时间 > 待同步。 */
  const statusText = computed(() => {
    if (syncing.value) return progress.value.message || '同步中…'
    if (!useSettingsStore().configured) return '未配置同步'
    if (!online.value) return '离线'
    if (lastError.value) return `上次同步失败`
    if (lastSyncAt.value) return `已同步 ${formatAgo(lastSyncAt.value)}`
    return '待同步'
  })

  /** 追加一条通知；同 kind+text 去重，info 类型到点自动消失，warn/error 等用户手动关闭。 */
  function notify(kind: Notice['kind'], text: string): void {
    // 自动同步每次到点都会重试并抛出同样的报错，同一文案只展示一次，避免刷屏。
    if (notices.value.some((n) => n.kind === kind && n.text === text)) return
    const id = ++noticeSeq
    notices.value = [...notices.value, { id, kind, text }]
    if (kind === 'info') {
      noticeTimers.set(
        id,
        setTimeout(() => dismissNotice(id), INFO_NOTICE_MS),
      )
    }
  }

  /** 关闭一条通知并清掉它的自动消失定时器。 */
  function dismissNotice(id: number): void {
    const timer = noticeTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      noticeTimers.delete(id)
    }
    notices.value = notices.value.filter((n) => n.id !== id)
  }

  /**
   * 启动入口：装载设置与日志、挂网络/可见性监听；随后按条件触发首次同步、
   * 缓存恢复或后台预取。
   *
   * 幂等：重复调用直接返回——监听器与 activePath 的 watcher 只挂一次，
   * 否则每多调一次就会多注册一组监听、多触发一轮首同步。与 ui.load 的约定一致：
   * 首次调用尚未完成时的并发调用会提前返回，启动序列里应当只 await 一次（App.vue 的 onMounted）。
   */
  async function init(): Promise<void> {
    if (initialized) return
    initialized = true
    await useSettingsStore().load()
    await refreshLog()

    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline)
      window.addEventListener('offline', onOffline)
      document.addEventListener('visibilitychange', onVisibility)
    }

    // 打开一篇只有索引的 stub，会触发按需下载正文。
    watch(
      () => useVaultStore().activePath,
      (path) => {
        if (path) void fetchBody(path)
      },
    )

    if (useSettingsStore().configured && online.value) {
      if (useVaultStore().storageWasWiped) {
        notify('warn', '检测到浏览器清空了本地缓存,正在从 Gitee 恢复全部笔记…')
        void recoverFromWipe()
      } else {
        void syncNow({ quiet: true })
        void startPreheat()
      }
    }
  }

  /** 联网恢复：置在线并立即静默同步一轮。 */
  function onOnline(): void {
    online.value = true
    void syncNow({ quiet: true })
  }

  /** 断网：置离线，本地修改原样保留，联网后自动同步。 */
  function onOffline(): void {
    online.value = false
  }

  /** 标签页重新可见且同步可用时：静默同步一轮并继续后台预取。 */
  function onVisibility(): void {
    if (document.visibilityState === 'visible' && available.value) {
      void syncNow({ quiet: true })
      void startPreheat()
    }
  }

  /** Safari 的 ITP 可能清空 OPFS 而 IndexedDB 幸存：把已知笔记的正文从 Gitee 全部重拉一遍。 */
  async function recoverFromWipe(): Promise<void> {
    const settings = useSettingsStore()
    if (!settings.configured) {
      notify('error', '本地缓存已被浏览器清空,且未配置 Gitee 同步,无法恢复笔记内容。')
      return
    }
    await syncNow({ quiet: false })
    const vault = useVaultStore()
    let pulled = 0
    while (vault.uncached.length > 0 && pulled < 5000) {
      const got = await engine.preheat(settings.giteeConfig, PREHEAT_BATCH * 4, report)
      if (got === 0) break
      pulled += got
    }
    vault.storageWasWiped = false
    const left = vault.uncached.length
    notify(
      left === 0 ? 'info' : 'warn',
      left === 0
        ? `已从 Gitee 恢复 ${pulled} 篇笔记。`
        : `已恢复 ${pulled} 篇笔记,仍有 ${left} 篇待下载,将在后台继续。`,
    )
  }

  /**
   * 预取一批未缓存正文；单飞保护，重复触发直接返回，全部拉完或无活可干即收工。
   * 每次调用只取 PREHEAT_BATCH 篇，避免长时间占用配额。
   */
  async function startPreheat(): Promise<void> {
    const settings = useSettingsStore()
    // 每次标签页回前台都会触发它；重叠的循环会重复下载同一批正文，
    // 白白烧掉我们无法度量的配额（限流头跨域读不到）。
    if (!settings.configured || !online.value || preheating) return
    const vault = useVaultStore()
    if (vault.uncached.length === 0) return
    preheating = true
    try {
      await engine.preheat(settings.giteeConfig, PREHEAT_BATCH, report)
    } catch (err) {
      await logSync('warn', `预取中止: ${describe(err)}`)
    } finally {
      preheating = false
    }
  }

  /** 打开笔记时的按需下载：已有正文、未配置或离线都直接返回；失败弹通知但不中断同步。 */
  async function fetchBody(path: string): Promise<void> {
    const settings = useSettingsStore()
    const vault = useVaultStore()
    const meta = vault.byPath.get(path)
    if (!meta || meta.cached || !settings.configured || !online.value) return
    try {
      const text = await engine.ensureCached(settings.giteeConfig, path, report)
      if (text !== null) vault.notifyBodyChanged(path)
    } catch (err) {
      notify('error', `下载「${meta.title}」失败: ${describe(err)}`)
    }
  }

  /** 引擎进度回调 → 写入 progress 供 UI 渲染。 */
  function report(p: SyncProgress): void {
    progress.value = p
  }

  /**
   * 串行化同步：同一时刻只跑一轮，后来的调用直接复用进行中的 Promise。
   * quiet 为真时不弹「未配置/离线」提示（供自动触发使用），显式调用默认会提示。
   * 成功后把错误/冲突/自动合并转成通知，无论成败都复位 syncing 与 progress。
   */
  async function syncNow(opts: { quiet?: boolean } = {}): Promise<SyncSummary | null> {
    const settings = useSettingsStore()
    if (!settings.configured) {
      if (!opts.quiet) notify('warn', '尚未配置 Gitee 同步。')
      return null
    }
    if (!online.value) {
      if (!opts.quiet) notify('warn', '当前离线,已保留本地修改,联网后会自动同步。')
      return null
    }
    if (running) return running

    syncing.value = true
    lastError.value = null
    running = (async () => {
      const summary = await engine.syncAll(settings.giteeConfig, report)
      lastSummary.value = summary
      lastSyncAt.value = Date.now()
      if (summary.errors.length > 0) {
        lastError.value = summary.errors[0]
        for (const e of summary.errors) notify('warn', e)
      }
      for (const c of summary.conflicts) {
        notify(
          'warn',
          `「${c.path}」本地与远端都有修改且无法自动合并。已保留本地版本,远端版本另存为 ${c.conflictPath}。`,
        )
      }
      if (summary.autoMerged > 0) {
        notify('info', `已自动合并 ${summary.autoMerged} 处不冲突的改动。`)
      }
      return summary
    })()

    try {
      const summary = await running
      await refreshLog()
      return summary
    } catch (err) {
      lastError.value = describe(err)
      if (!opts.quiet) notify('error', `同步失败: ${describe(err)}`)
      return null
    } finally {
      running = null
      syncing.value = false
      progress.value = { phase: 'idle', message: '', current: 0, total: 0 }
    }
  }

  /**
   * 本地编辑触发的防抖推送：每次调用重置计时器，到点且确有待上传内容才真正同步。
   * autoSync 关闭或未配置时直接不排程。
   */
  function schedulePush(): void {
    const settings = useSettingsStore()
    if (!settings.settings.autoSync || !settings.configured) return
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = null
      if (useVaultStore().pendingUpload > 0) void syncNow({ quiet: true })
    }, settings.settings.pushDelayMs)
  }

  /** 取消防抖推送（例如用户关闭自动同步或退出编辑时）。 */
  function cancelScheduledPush(): void {
    if (pushTimer) {
      clearTimeout(pushTimer)
      pushTimer = null
    }
  }

  /** 用 testConnection 验证令牌/仓库/分支，成败文案都写入 connectionInfo，返回是否成功。 */
  async function checkConnection(): Promise<boolean> {
    const settings = useSettingsStore()
    if (!settings.configured) {
      connectionInfo.value = null
      return false
    }
    try {
      const info = await testConnection(settings.giteeConfig)
      connectionInfo.value = `连接成功: 分支 ${settings.settings.branch} @ ${info.head.slice(0, 7)},共 ${info.files} 个文件`
      return true
    } catch (err) {
      const detail = err instanceof GiteeError ? `${err.status} ${err.message}` : describe(err)
      connectionInfo.value = `连接失败: ${detail}`
      return false
    }
  }

  /** 重新拉取最近 120 条同步日志（新在前）。 */
  async function refreshLog(): Promise<void> {
    log.value = await db.syncLog.orderBy('at').reverse().limit(120).toArray()
  }

  /** 清空同步日志并同步清空内存。 */
  async function clearLog(): Promise<void> {
    await db.syncLog.clear()
    log.value = []
  }

  return {
    syncing,
    progress,
    lastSummary,
    lastSyncAt,
    lastError,
    online,
    log,
    notices,
    available,
    statusText,
    connectionInfo,
    init,
    syncNow,
    schedulePush,
    cancelScheduledPush,
    checkConnection,
    fetchBody,
    startPreheat,
    notify,
    dismissNotice,
    refreshLog,
    clearLog,
  }
})

/** 把任意抛出物转成一行可展示文案。 */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 把时间戳渲染成「刚刚 / n 秒前 / n 分钟前 / n 小时前」，超过一天则给具体日期时间。 */
function formatAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 10) return '刚刚'
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}
