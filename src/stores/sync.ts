import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { db, logSync, type SyncLogRow } from '@/core/db.ts'
import type { SyncProgress, SyncSummary } from '@/core/sync/engine.ts'
import * as engine from '@/core/sync/engine.ts'
import { GiteeError, testConnection } from '@/core/sync/gitee.ts'
import { useSettingsStore } from './settings.ts'
import { useVaultStore } from './vault.ts'

const PREHEAT_BATCH = 25
/** Routine confirmations fade on their own; warnings and errors wait for the user. */
const INFO_NOTICE_MS = 6_000

export interface Notice {
  id: number
  kind: 'info' | 'warn' | 'error'
  text: string
}

export const useSyncStore = defineStore('sync', () => {
  const syncing = ref(false)
  const progress = ref<SyncProgress>({ phase: 'idle', message: '', current: 0, total: 0 })
  const lastSummary = ref<SyncSummary | null>(null)
  const lastSyncAt = ref<number | null>(null)
  const lastError = ref<string | null>(null)
  const online = ref(typeof navigator === 'undefined' ? true : navigator.onLine)
  const log = ref<SyncLogRow[]>([])
  const notices = ref<Notice[]>([])
  const connectionInfo = ref<string | null>(null)

  let pushTimer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<SyncSummary> | null = null
  let preheating = false
  let noticeSeq = 0
  const noticeTimers = new Map<number, ReturnType<typeof setTimeout>>()

  const available = computed(() => useSettingsStore().configured && online.value)
  const statusText = computed(() => {
    if (syncing.value) return progress.value.message || '同步中…'
    if (!useSettingsStore().configured) return '未配置同步'
    if (!online.value) return '离线'
    if (lastError.value) return `上次同步失败`
    if (lastSyncAt.value) return `已同步 ${formatAgo(lastSyncAt.value)}`
    return '待同步'
  })

  function notify(kind: Notice['kind'], text: string): void {
    // A failing auto-sync repeats the same message every push delay; show it once.
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

  function dismissNotice(id: number): void {
    const timer = noticeTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      noticeTimers.delete(id)
    }
    notices.value = notices.value.filter((n) => n.id !== id)
  }

  async function init(): Promise<void> {
    await useSettingsStore().load()
    await refreshLog()

    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline)
      window.addEventListener('offline', onOffline)
      document.addEventListener('visibilitychange', onVisibility)
    }

    // Opening a note that is only an index stub triggers an on-demand body download.
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

  function onOnline(): void {
    online.value = true
    void syncNow({ quiet: true })
  }

  function onOffline(): void {
    online.value = false
  }

  function onVisibility(): void {
    if (document.visibilityState === 'visible' && available.value) {
      void syncNow({ quiet: true })
      void startPreheat()
    }
  }

  /** Safari's ITP can empty OPFS while IndexedDB survives; re-pull every known body. */
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

  async function startPreheat(): Promise<void> {
    const settings = useSettingsStore()
    // Every tab-return fires this; overlapping loops would re-download the same bodies
    // and burn quota we cannot measure (the rate-limit headers are unreadable).
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

  function report(p: SyncProgress): void {
    progress.value = p
  }

  /** Serialize syncs: one at a time, and callers join the in-flight run. */
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

  /** Debounced push triggered by local edits. */
  function schedulePush(): void {
    const settings = useSettingsStore()
    if (!settings.settings.autoSync || !settings.configured) return
    if (pushTimer) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = null
      if (useVaultStore().pendingUpload > 0) void syncNow({ quiet: true })
    }, settings.settings.pushDelayMs)
  }

  function cancelScheduledPush(): void {
    if (pushTimer) {
      clearTimeout(pushTimer)
      pushTimer = null
    }
  }

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

  async function refreshLog(): Promise<void> {
    log.value = await db.syncLog.orderBy('at').reverse().limit(120).toArray()
  }

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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

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
