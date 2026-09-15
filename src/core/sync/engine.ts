/**
 * Sync engine: index-first pull, lazy body fetch, batched push, three-way merge.
 *
 * The whole design exists to keep request counts low, because Gitee's rate-limit
 * headers are not readable cross-origin and the authenticated quota is unknown until
 * you hit it. One `trees?recursive=1` call describes the entire vault; bodies are only
 * fetched when a note is opened or preheated in the background.
 */
import { db, logSync, type NoteMeta } from '@/core/db.ts'
import { conflictStamp, gitBlobSha } from '@/core/vault/hash.ts'
import * as opfs from '@/core/vault/opfs.ts'
import { dirOf, normalizePath, titleOf } from '@/core/vault/paths.ts'
import { useVaultStore } from '@/stores/vault.ts'
import type { CommitAction, GiteeConfig } from './gitee.ts'
import * as gitee from './gitee.ts'
import { threeWayMerge } from './merge.ts'
import { findRemoteDeletions } from './remote-diff.ts'

const MAX_ACTIONS_PER_COMMIT = 40
const MAX_RETRY = 4

export type SyncPhase = 'idle' | 'index' | 'bodies' | 'merge' | 'push' | 'done' | 'error'

export interface SyncProgress {
  phase: SyncPhase
  message: string
  current: number
  total: number
}

export type ProgressSink = (p: SyncProgress) => void

export interface ConflictRecord {
  path: string
  conflictPath: string
}

export interface SyncSummary {
  remoteFiles: number
  newStubs: number
  pulled: number
  pushed: number
  deletedRemote: number
  deletedLocal: number
  autoMerged: number
  conflicts: ConflictRecord[]
  errors: string[]
}

const noop: ProgressSink = () => {}

function emptySummary(): SyncSummary {
  return {
    remoteFiles: 0,
    newStubs: 0,
    pulled: 0,
    pushed: 0,
    deletedRemote: 0,
    deletedLocal: 0,
    autoMerged: 0,
    conflicts: [],
    errors: [],
  }
}

async function withRetry<T>(label: string, fn: () => Promise<T>, sink: ProgressSink = noop): Promise<T> {
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      const retryable = err instanceof gitee.GiteeError && err.retryable
      if (!retryable || attempt >= MAX_RETRY) throw err
      const wait = Math.min(60_000, 1000 * 2 ** attempt)
      attempt++
      sink({
        phase: 'index',
        message: `${label} 失败,${Math.round(wait / 1000)}s 后第 ${attempt} 次重试`,
        current: attempt,
        total: MAX_RETRY,
      })
      await sleep(wait)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Refresh the remote index. Creates index-only stubs (`cached: 0`) for notes we do not
 * have yet, and flags notes the remote has deleted.
 */
export async function pullIndex(cfg: GiteeConfig, summary: SyncSummary, sink: ProgressSink = noop): Promise<void> {
  sink({ phase: 'index', message: '读取分支…', current: 0, total: 0 })
  const head = await withRetry('读取分支', () => gitee.getBranchHead(cfg), sink)

  sink({ phase: 'index', message: '拉取文件树…', current: 0, total: 0 })
  const tree = await withRetry('拉取文件树', () => gitee.getTree(cfg, head), sink)
  if (tree.truncated) {
    const msg = 'Gitee 返回的文件树被截断(仓库文件过多),本次同步不完整。'
    summary.errors.push(msg)
    await logSync('warn', msg)
  }

  const remoteMd = new Map<string, string>()
  for (const entry of tree.entries) {
    if (!entry.path.toLowerCase().endsWith('.md')) continue
    let normalized: string
    try {
      normalized = normalizePath(entry.path)
    } catch {
      summary.errors.push(`跳过非法路径: ${entry.path}`)
      continue
    }
    remoteMd.set(normalized, entry.sha)
  }
  summary.remoteFiles = remoteMd.size

  const local = await db.notes.toArray()
  const localByPath = new Map(local.map((n) => [n.path, n]))
  const toPut: NoteMeta[] = []

  for (const [path, sha] of remoteMd) {
    const existing = localByPath.get(path)
    if (!existing) {
      toPut.push({
        path,
        title: titleOf(path),
        baseSha: null,
        localSha: null,
        remoteSha: sha,
        mtime: Date.now(),
        size: 0,
        dirty: 0,
        cached: 0,
        removedLocal: 0,
        removedRemote: 0,
      })
      summary.newStubs++
      continue
    }
    if (existing.removedLocal) continue
    if (existing.remoteSha !== sha) {
      toPut.push({ ...existing, remoteSha: sha })
    }
  }

  // Anything the remote used to have and no longer lists.
  for (const n of findRemoteDeletions(local, remoteMd)) {
    toPut.push({ ...n, removedRemote: 1 })
  }

  if (toPut.length > 0) await db.notes.bulkPut(toPut)
  await useVaultStore().reloadNotes()
  sink({
    phase: 'index',
    message: `索引完成,远端 ${remoteMd.size} 篇笔记`,
    current: remoteMd.size,
    total: remoteMd.size,
  })
}

/** Download one note body on demand. Returns the text, or null when unavailable. */
export async function ensureCached(cfg: GiteeConfig, path: string, sink: ProgressSink = noop): Promise<string | null> {
  const meta = await db.notes.get(path)
  if (!meta) return null
  if (meta.cached) return opfs.readNote(path)
  if (!meta.remoteSha) return null

  sink({ phase: 'bodies', message: `下载 ${titleOf(path)}`, current: 0, total: 1 })
  const { file } = await withRetry(`下载 ${path}`, () => gitee.getFile(cfg, path), sink)
  if (!file) return null

  await opfs.writeNote(path, file.text)
  const sha = await gitBlobSha(file.text)
  await db.notes.put({
    ...meta,
    localSha: sha,
    baseSha: sha,
    remoteSha: file.sha || meta.remoteSha,
    size: file.text.length,
    cached: 1,
    dirty: 0,
    mtime: Date.now(),
  })
  await useVaultStore().reindexContent(path, file.text)
  await useVaultStore().reloadNotes()
  return file.text
}

/** Background fill-in of notes that are indexed but not downloaded yet. */
export async function preheat(cfg: GiteeConfig, limit: number, sink: ProgressSink = noop): Promise<number> {
  const pending = (await db.notes.toArray())
    .filter((n) => !n.cached && !n.removedLocal && n.remoteSha)
    .slice(0, limit)

  let done = 0
  for (const note of pending) {
    try {
      const text = await ensureCached(cfg, note.path, sink)
      if (text !== null) done++
      sink({ phase: 'bodies', message: `后台预取 ${done}/${pending.length}`, current: done, total: pending.length })
    } catch (err) {
      await logSync('warn', `预取 ${note.path} 失败: ${describe(err)}`)
      break // most likely throttled; stop rather than burn the quota
    }
  }
  if (done > 0) await useVaultStore().reloadNotes()
  return done
}

/** Apply remote deletions, resurrecting notes that were edited locally in the meantime. */
export async function applyRemoteDeletions(summary: SyncSummary): Promise<void> {
  const flagged = (await db.notes.toArray()).filter((n) => n.removedRemote)
  for (const meta of flagged) {
    const editedLocally = meta.dirty === 1 || (meta.localSha !== null && meta.localSha !== meta.baseSha)
    if (editedLocally) {
      // Remote deleted it but we have unsent edits: keep ours and re-publish it.
      await db.notes.put({ ...meta, removedRemote: 0, dirty: 1 })
      summary.errors.push(`「${meta.title}」在远端被删除,但本地有未同步的修改,已保留本地版本并将重新上传。`)
      await logSync('warn', `保留本地修改并重新上传: ${meta.path}`)
      continue
    }
    await opfs.deleteNote(meta.path)
    await db.transaction('rw', db.links, db.tags, async () => {
      await db.links.where('src').equals(meta.path).delete()
      await db.tags.where('path').equals(meta.path).delete()
    })
    await db.notes.delete(meta.path)
    summary.deletedLocal++
  }
  if (flagged.length > 0) await useVaultStore().reloadNotes()
}

/**
 * Push local changes. Notes touched on both sides go through a three-way merge against
 * the ancestor blob fetched by sha; unresolvable ones keep the local text and spill the
 * remote text into a `.conflict-<stamp>.md` sibling so nothing is silently overwritten.
 */
export async function push(cfg: GiteeConfig, summary: SyncSummary, sink: ProgressSink = noop): Promise<void> {
  const all = await db.notes.toArray()
  const tombstones = all.filter((n) => n.removedLocal)
  const dirty = all.filter((n) => n.dirty === 1 && !n.removedLocal)
  if (tombstones.length === 0 && dirty.length === 0) return

  /** One record per touched note: what to upload, and what to reconcile once it lands. */
  const jobs: PushJob[] = []
  const total = tombstones.length + dirty.length

  for (const meta of tombstones) {
    if (meta.remoteSha) {
      jobs.push({ action: { action: 'delete', path: meta.path }, path: meta.path, content: null })
    } else {
      await db.notes.delete(meta.path)
    }
  }

  let i = 0
  for (const meta of dirty) {
    i++
    sink({ phase: 'push', message: `准备 ${titleOf(meta.path)} (${i}/${total})`, current: i, total })

    const local = await opfs.readNote(meta.path)
    if (local === null) {
      await db.notes.put({ ...meta, cached: 0, dirty: 0 })
      continue
    }

    const localSha = await gitBlobSha(local)
    const remoteChanged = meta.remoteSha !== null && meta.remoteSha !== meta.baseSha

    if (!remoteChanged) {
      const isNew = meta.remoteSha === null
      jobs.push({
        action: { action: isNew ? 'create' : 'update', path: meta.path, content: local },
        path: meta.path,
        content: local,
      })
      if (meta.localSha !== localSha) await db.notes.put({ ...meta, localSha })
      continue
    }

    // Both sides moved: three-way merge.
    sink({ phase: 'merge', message: `合并 ${titleOf(meta.path)}`, current: i, total })
    const outcome = await mergeWithRemote(cfg, meta, local)
    if (outcome.status === 'merged') {
      summary.autoMerged++
      await opfs.writeNote(meta.path, outcome.text)
      await useVaultStore().reindexContent(meta.path, outcome.text)
      jobs.push({
        action: { action: 'update', path: meta.path, content: outcome.text },
        path: meta.path,
        content: outcome.text,
      })
      continue
    }
    if (outcome.status === 'remote-wins') {
      // Nothing to upload; the remote version simply becomes the local one.
      summary.pulled++
      await opfs.writeNote(meta.path, outcome.text)
      await useVaultStore().reindexContent(meta.path, outcome.text)
      const sha = await gitBlobSha(outcome.text)
      await db.notes.put({
        ...meta,
        localSha: sha,
        baseSha: sha,
        remoteSha: sha,
        size: outcome.text.length,
        dirty: 0,
        cached: 1,
        mtime: Date.now(),
      })
      continue
    }

    // Unresolvable: keep local, preserve remote in a conflict copy, push both.
    summary.conflicts.push({
      path: meta.path,
      conflictPath: await writeConflictCopy(meta.path, outcome.remoteText),
    })
    jobs.push({
      action: { action: meta.remoteSha ? 'update' : 'create', path: meta.path, content: local },
      path: meta.path,
      content: local,
    })
  }

  // Conflict copies are ordinary new notes; queue them for the same push.
  for (const c of summary.conflicts) {
    const text = await opfs.readNote(c.conflictPath)
    if (text === null) continue
    jobs.push({
      action: { action: 'create', path: c.conflictPath, content: text },
      path: c.conflictPath,
      content: text,
    })
  }

  const uploadable = jobs.filter((j) => j.action !== null)
  if (uploadable.length === 0) {
    await settle(jobs.filter((j) => j.action === null))
    await useVaultStore().reloadNotes()
    return
  }

  const message = buildCommitMessage(
    uploadable.map((j) => j.action as CommitAction),
    summary.conflicts.length,
  )
  for (let start = 0; start < jobs.length; start += MAX_ACTIONS_PER_COMMIT) {
    const batch = jobs.slice(start, start + MAX_ACTIONS_PER_COMMIT)
    const withAction = batch.filter((j) => j.action !== null).map((j) => j.action as CommitAction)
    if (withAction.length === 0) {
      await settle(batch)
      continue
    }
    sink({
      phase: 'push',
      message: `上传 ${withAction.length} 个文件…`,
      current: Math.min(start + MAX_ACTIONS_PER_COMMIT, jobs.length),
      total: jobs.length,
    })
    await withRetry('提交', () => commitBatch(cfg, message, withAction), sink)
    await settle(batch)
    summary.pushed += withAction.filter((a) => a.action !== 'delete').length
    summary.deletedRemote += withAction.filter((a) => a.action === 'delete').length
  }

  await useVaultStore().reloadNotes()
}

interface PushJob {
  /** null when nothing needs uploading but metadata still has to be reconciled. */
  action: CommitAction | null
  path: string
  /** null for deletions. */
  content: string | null
}

type MergeDecision =
  | { status: 'merged'; text: string }
  | { status: 'remote-wins'; text: string }
  | { status: 'conflict'; text: string; remoteText: string }

async function mergeWithRemote(
  cfg: GiteeConfig,
  meta: NoteMeta,
  local: string,
): Promise<MergeDecision> {
  const { file } = await gitee.getFile(cfg, meta.path)
  if (!file) return { status: 'merged', text: local }

  const base = meta.baseSha ? await gitee.getBlob(cfg, meta.baseSha) : null
  if (base === null) {
    // Ancestor unreachable (force push / gc). Cannot merge safely.
    await logSync('warn', `无法取得 ${meta.path} 的共同祖先,按冲突处理`)
    return local === file.text
      ? { status: 'merged', text: local }
      : { status: 'conflict', text: local, remoteText: file.text }
  }

  const outcome = threeWayMerge(local, base, file.text)
  if (outcome.status === 'conflict') {
    return { status: 'conflict', text: local, remoteText: outcome.remoteText ?? file.text }
  }
  if (outcome.text === local) return { status: 'merged', text: local }
  if (outcome.text === file.text) return { status: 'remote-wins', text: outcome.text }
  return { status: 'merged', text: outcome.text }
}

/**
 * Gitee mirrors GitLab's multi-file commit endpoint. If a deployment does not expose it,
 * fall back to one request per file rather than failing the whole sync.
 */
let multiCommitBroken = false

async function commitBatch(cfg: GiteeConfig, message: string, batch: CommitAction[]): Promise<void> {
  if (!multiCommitBroken) {
    try {
      await gitee.commitFiles(cfg, message, batch)
      return
    } catch (err) {
      if (err instanceof gitee.GiteeError && (err.status === 404 || err.status === 405)) {
        multiCommitBroken = true
        await logSync('warn', 'Gitee 多文件提交接口不可用,已降级为逐文件提交')
      } else {
        throw err
      }
    }
  }

  for (const action of batch) {
    if (action.action === 'delete') {
      const meta = await db.notes.get(action.path)
      if (meta?.remoteSha) await gitee.deleteRemoteFile(cfg, action.path, meta.remoteSha, message)
      continue
    }
    if (action.action === 'move') continue
    const meta = await db.notes.get(action.path)
    await gitee.putFile(cfg, action.path, action.content, message, meta?.remoteSha ?? null)
  }
}

/** After a commit lands, base/local/remote all agree again. */
async function settle(batch: PushJob[]): Promise<void> {
  for (const job of batch) {
    if (job.content === null) {
      await db.notes.delete(job.path)
      continue
    }
    const sha = await gitBlobSha(job.content)
    const meta = await db.notes.get(job.path)
    if (!meta) continue
    await db.notes.put({
      ...meta,
      localSha: sha,
      baseSha: sha,
      remoteSha: sha,
      size: job.content.length,
      dirty: 0,
      cached: 1,
      removedLocal: 0,
      removedRemote: 0,
      mtime: Date.now(),
    })
  }
  await useVaultStore().reloadNotes()
}

async function writeConflictCopy(path: string, remoteText: string): Promise<string> {
  const dir = dirOf(path)
  const title = titleOf(path)
  let candidate = ''
  for (let i = 0; i < 50; i++) {
    const name = `${title}.conflict-${conflictStamp(new Date(Date.now() + i * 1000))}.md`
    candidate = normalizePath(dir === '' ? name : `${dir}/${name}`)
    if (!(await opfs.existsNote(candidate)) && !(await db.notes.get(candidate))) break
  }
  await opfs.writeNote(candidate, remoteText)
  const sha = await gitBlobSha(remoteText)
  await db.notes.put({
    path: candidate,
    title: titleOf(candidate),
    baseSha: null,
    localSha: sha,
    remoteSha: null,
    mtime: Date.now(),
    size: remoteText.length,
    dirty: 1,
    cached: 1,
    removedLocal: 0,
    removedRemote: 0,
  })
  await useVaultStore().reindexContent(candidate, remoteText)
  await logSync('warn', `冲突: ${path} 的远端版本已另存为 ${candidate}`)
  return candidate
}

function buildCommitMessage(actions: CommitAction[], conflictCount: number): string {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const created = actions.filter((a) => a.action === 'create').length
  const updated = actions.filter((a) => a.action === 'update').length
  const deleted = actions.filter((a) => a.action === 'delete').length
  const parts: string[] = []
  if (created) parts.push(`新增 ${created}`)
  if (updated) parts.push(`更新 ${updated}`)
  if (deleted) parts.push(`删除 ${deleted}`)
  const suffix = conflictCount > 0 ? ` (含 ${conflictCount} 个冲突副本)` : ''
  return `vault: ${parts.join(', ') || '同步'}${suffix} @ ${now}`
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function syncAll(cfg: GiteeConfig, sink: ProgressSink = noop): Promise<SyncSummary> {
  const summary = emptySummary()
  try {
    await pullIndex(cfg, summary, sink)
    await applyRemoteDeletions(summary)
    await push(cfg, summary, sink)
    // Re-read the index so base/remote shas reflect reality, including concurrent edits.
    await pullIndex(cfg, summary, sink)
    sink({ phase: 'done', message: '同步完成', current: 1, total: 1 })
    await logSync(
      'info',
      `同步完成: 上传 ${summary.pushed}, 下载 ${summary.pulled}, 自动合并 ${summary.autoMerged}, 冲突 ${summary.conflicts.length}`,
    )
  } catch (err) {
    summary.errors.push(describe(err))
    sink({ phase: 'error', message: describe(err), current: 0, total: 0 })
    await logSync('error', `同步失败: ${describe(err)}`)
  }
  return summary
}
