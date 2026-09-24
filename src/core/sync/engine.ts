/**
 * 同步引擎：先索引后正文的拉取、按需正文下载、分批推送、三方合并。
 *
 * 整套设计只为压低请求数：Gitee 的限流响应头跨域读不到，配额多少只有撞了才知道。
 * 一次 `trees?recursive=1` 就能描述整个 vault；正文只在用户打开笔记或后台预取时才下载。
 *
 * 硬约束/注意事项：
 * - 拉取只更新索引：远端新增笔记仅落 `cached: 0` 的索引 stub，正文由 ensureCached/preheat 按需补。
 * - 推送按 MAX_ACTIONS_PER_COMMIT 分批提交；多文件提交接口回 404/405/406 时
 *   降级为逐文件 contents API（见 commitBatch 与 multiCommitBroken）。
 * - 冲突绝不静默覆盖：本地文本原样保留并推送，远端文本另存同目录
 *   `.conflict-<时间戳>.md` 副本一起上传，任何一侧都不丢。
 * - 失败重试仅对 GiteeError.retryable 为真的错误做指数退避（withRetry）。
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

/** 单次多文件提交最多塞多少条动作——Gitee 对 body 体积敏感，分批把失败半径限制在一批内。 */
const MAX_ACTIONS_PER_COMMIT = 40
/** withRetry 的最大重试次数（不含首次），与指数退避配合使用。 */
const MAX_RETRY = 4

/** 同步所处阶段，驱动进度条与状态文案：idle 空闲 / index 拉索引 / bodies 下载正文 / merge 三方合并 / push 推送 / done 完成 / error 失败。 */
export type SyncPhase = 'idle' | 'index' | 'bodies' | 'merge' | 'push' | 'done' | 'error'

/** 一次进度回调：阶段 + 可读文案 + current/total（total 为 0 表示总量未知）。 */
export interface SyncProgress {
  phase: SyncPhase
  message: string
  current: number
  total: number
}

/** 进度回调类型；不关心进度的调用方走默认的 noop。 */
export type ProgressSink = (p: SyncProgress) => void

/** 一条冲突记录：原笔记路径与另存的冲突副本路径。 */
export interface ConflictRecord {
  path: string
  conflictPath: string
}

/**
 * 一轮 syncAll 的汇总，供 UI 与日志展示。
 * remoteFiles 远端 .md 总数；newStubs 本轮新建的索引 stub 数；pulled 拉回本地的正文数；
 * pushed 上传成功的非删除动作数；deletedRemote/deletedLocal 远端/本地删除数；
 * autoMerged 自动合并成功数；conflicts 冲突副本列表；errors 错误与告警文案。
 */
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

/** 不关心进度时的默认 sink。 */
const noop: ProgressSink = () => {}

/** 全零汇总，作为每轮同步的起点。 */
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

/**
 * 指数退避重试：只重试 GiteeError.retryable 为真的错误（网络抖动、429、5xx、限流类 403），
 * 其余（如 401 令牌失效、404 配置错误）立即抛出——那些越重试越糟。
 * 退避 1s→2s→4s→8s，封顶 60s，最多重试 MAX_RETRY 次；每次等待都经 sink 播报进度。
 */
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

/** 纯等待，供退避使用。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 刷新远端索引。对本地尚无的笔记只建索引 stub（`cached: 0`），对 sha 变化的更新 remoteSha，
 * 对远端已消失的标记 removedRemote。本函数完全不下载正文——这是省请求的关键。
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
      // 远端独有的新笔记：只登记索引（localSha 为 null 的 stub），正文按需再取。
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
    // 本地删除墓碑还在等推送：跳过，别让索引刷新把删除状态冲掉。
    if (existing.removedLocal) continue
    if (existing.remoteSha !== sha) {
      toPut.push({ ...existing, remoteSha: sha })
    }
  }

  // 远端曾经有、现在的文件树里不再列出的那些（即远端删除判定）。
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

/**
 * 按需下载单篇正文。成功返回文本；无 meta、无远端 sha 或远端不存在时返回 null。
 */
export async function ensureCached(
  cfg: GiteeConfig,
  path: string,
  sink: ProgressSink = noop,
  opts: { reload?: boolean } = {},
): Promise<string | null> {
  const meta = await db.notes.get(path)
  if (!meta) return null
  if (meta.cached) return opfs.readNote(path)
  if (!meta.remoteSha) return null

  sink({ phase: 'bodies', message: `下载 ${titleOf(path)}`, current: 0, total: 1 })
  const { file } = await withRetry(`下载 ${path}`, () => gitee.getFile(cfg, path), sink)
  if (!file) return null

  await opfs.writeNote(path, file.text)
  const sha = await gitBlobSha(file.text)
  // 下载即视为与远端一致：三个 sha 对齐、清脏标记，并同步派生索引。
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
  // reload: false 供批量下载（preheat）使用：每篇一次 reloadNotes 就是每篇一次全表读 +
  // 全量派生刷新，25 篇的预取会变成 25 次全库扫描；批量方在循环结束统一 reload 一次。
  await useVaultStore().reindexContent(path, file.text, { deferCards: opts.reload === false })
  if (opts.reload !== false) await useVaultStore().reloadNotes()
  return file.text
}

/** 后台批量补正文：索引里有、却还没下载的笔记逐篇拉取，返回本次成功篇数。 */
export async function preheat(cfg: GiteeConfig, limit: number, sink: ProgressSink = noop): Promise<number> {
  const pending = (await db.notes.toArray())
    .filter((n) => !n.cached && !n.removedLocal && n.remoteSha)
    .slice(0, limit)

  let done = 0
  for (const note of pending) {
    try {
      const text = await ensureCached(cfg, note.path, sink, { reload: false })
      if (text !== null) done++
      sink({ phase: 'bodies', message: `后台预取 ${done}/${pending.length}`, current: done, total: pending.length })
    } catch (err) {
      await logSync('warn', `预取 ${note.path} 失败: ${describe(err)}`)
      break // 多半是被限流了；就此停下，别继续烧配额
    }
  }
  // 整批下载完只收口一次：这一次 reload 同时把上面 defer 掉的内存 cards 一起补齐。
  if (done > 0) await useVaultStore().reloadNotes()
  return done
}

/** 应用远端删除；其间本地编辑过的笔记会被「复活」而不是删掉。 */
export async function applyRemoteDeletions(summary: SyncSummary): Promise<void> {
  const flagged = (await db.notes.toArray()).filter((n) => n.removedRemote)
  for (const meta of flagged) {
    const editedLocally = meta.dirty === 1 || (meta.localSha !== null && meta.localSha !== meta.baseSha)
    if (editedLocally) {
      // 远端删了但本地有未推送的修改：保留本地版本，置脏重新发布。
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
 * 推送本地变更。两侧都动过的笔记按 sha 取回共同祖先 blob 做三方合并；合不拢的保留本地文本，
 * 把远端文本溢写成同目录 `.conflict-时间戳.md` 副本，绝不静默覆盖任何一侧。
 * 结果按 MAX_ACTIONS_PER_COMMIT 分批提交，每批落地后由 settle 对齐三个 sha。
 */
export async function push(cfg: GiteeConfig, summary: SyncSummary, sink: ProgressSink = noop): Promise<void> {
  const all = await db.notes.toArray()
  const tombstones = all.filter((n) => n.removedLocal)
  const dirty = all.filter((n) => n.dirty === 1 && !n.removedLocal)
  if (tombstones.length === 0 && dirty.length === 0) return

  /** 每篇被触及的笔记一条记录：要上传什么，以及落地后如何对账。 */
  const jobs: PushJob[] = []
  const total = tombstones.length + dirty.length

  for (const meta of tombstones) {
    // 远端从未有过的删除无须上传，直接本地清除；否则排一条 delete 动作。
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
      // OPFS 读不到正文（如被外部清掉）：退回索引 stub 等按需重新下载，本轮不推。
      await db.notes.put({ ...meta, cached: 0, dirty: 0 })
      continue
    }

    const localSha = await gitBlobSha(local)
    // 远端相对共同祖先也动了 = 双改，需要三方合并；否则只有本地改动，直接推。
    const remoteChanged = meta.remoteSha !== null && meta.remoteSha !== meta.baseSha

    // 纯本地改动（或全新笔记）：排队直接上传。
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

    // 两侧都改过：按共同祖先做三方合并。
    sink({ phase: 'merge', message: `合并 ${titleOf(meta.path)}`, current: i, total })
    const outcome = await mergeWithRemote(cfg, meta, local)
    if (outcome.status === 'merged') {
      summary.autoMerged++
      await opfs.writeNote(meta.path, outcome.text)
      // 合并阶段是逐篇循环、结尾统一 reloadNotes：循环内不刷内存 cards（O(N²)）。
      await useVaultStore().reindexContent(meta.path, outcome.text, { deferCards: true })
      jobs.push({
        action: { action: 'update', path: meta.path, content: outcome.text },
        path: meta.path,
        content: outcome.text,
      })
      continue
    }
    if (outcome.status === 'remote-wins') {
      // 无须上传：远端版本直接成为本地版本，三方 sha 对齐、清脏。
      summary.pulled++
      await opfs.writeNote(meta.path, outcome.text)
      await useVaultStore().reindexContent(meta.path, outcome.text, { deferCards: true })
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

    // 合不拢：本地文本原样保留并推送，远端文本另存冲突副本，两边一起推，谁也不丢。
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

  // 冲突副本就是普通新笔记，排进同一次推送。
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
  // 按 MAX_ACTIONS_PER_COMMIT 切片分批提交：一批失败只影响该批，重试交给 withRetry；
  // 批内若全是待对账（action 为 null）的记录，则只做本地 settle 不发请求。
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

/** 推送队列里的一条：既带上传动作，也带落地后对账所需的信息。 */
interface PushJob {
  /** 为 null 表示无须上传，但元数据仍要在落地后对账。 */
  action: CommitAction | null
  path: string
  /** 删除动作为 null。 */
  content: string | null
}

/**
 * mergeWithRemote 的三种结论：
 * - `merged`：合并结果可直接作为新正文推送；
 * - `remote-wins`：本地相对祖先其实没动，采用远端文本，无须上传；
 * - `conflict`：无法自动合并，text 留本地、remoteText 供另存冲突副本。
 */
type MergeDecision =
  | { status: 'merged'; text: string }
  | { status: 'remote-wins'; text: string }
  | { status: 'conflict'; text: string; remoteText: string }

/**
 * 拉取远端当前文本与共同祖先 blob，交给 threeWayMerge 判定。
 * 远端文件已不存在 → 视为纯本地改动（merged）；祖先 blob 取不到（force push / gc）时无法安全合并：
 * 文本恰好相同按 merged，不同按 conflict。
 */
async function mergeWithRemote(
  cfg: GiteeConfig,
  meta: NoteMeta,
  local: string,
): Promise<MergeDecision> {
  const { file } = await gitee.getFile(cfg, meta.path)
  if (!file) return { status: 'merged', text: local }

  const base = meta.baseSha ? await gitee.getBlob(cfg, meta.baseSha) : null
  if (base === null) {
    // 共同祖先取不到（force push / gc），无法安全合并。
    await logSync('warn', `无法取得 ${meta.path} 的共同祖先,按冲突处理`)
    return local === file.text
      ? { status: 'merged', text: local }
      : { status: 'conflict', text: local, remoteText: file.text }
  }

  const outcome = threeWayMerge(local, base, file.text)
  if (outcome.status === 'conflict') {
    return { status: 'conflict', text: local, remoteText: outcome.remoteText ?? file.text }
  }
  // 结果恰等于本地 → 推本地即可；恰等于远端 → 采用远端；否则是真正合成的新文本。
  if (outcome.text === local) return { status: 'merged', text: local }
  if (outcome.text === file.text) return { status: 'remote-wins', text: outcome.text }
  return { status: 'merged', text: outcome.text }
}

/**
 * Gitee 仿照 GitLab 的多文件提交端点，但 gitee.com 会拒绝本客户端的 JSON body 形状（406）。
 * 404/405/406 任意一个都意味着「这里没有可用的批量提交」，此时降级为逐文件 contents API，
 * 而不是让整轮同步失败。该结论用模块级布尔记住，避免每批都先撞一次再降级。
 */
let multiCommitBroken = false

/**
 * 提交一批动作：优先走多文件提交；接口不可用（404/405/406）则记下 multiCommitBroken，
 * 之后逐个动作 PUT/DELETE。删除必须带上当前 remoteSha；move 目前引擎不产出，直接跳过。
 */
async function commitBatch(cfg: GiteeConfig, message: string, batch: CommitAction[]): Promise<void> {
  if (!multiCommitBroken) {
    try {
      await gitee.commitFiles(cfg, message, batch)
      return
    } catch (err) {
      const status = err instanceof gitee.GiteeError ? err.status : 0
      if (status === 404 || status === 405 || status === 406) {
        multiCommitBroken = true
        await logSync('warn', `Gitee 多文件提交接口不可用(${status}),已降级为逐文件提交`)
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

/** 提交落地后，base/local/remote 三方重新对齐：三个 sha 同值、清掉全部标志位。 */
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

/**
 * 把无法合并的远端文本另存为 `<标题>.conflict-<时间戳>.md` 同目录副本，并登记为一篇
 * 全新的脏笔记（dirty: 1），随本轮推送一起上传，保证远端版本在仓库里留痕。
 * 时间戳按秒递增最多试 50 次以避开重名（OPFS 与索引双查重）；50 次全撞上时退回
 * `-2`、`-3`… 序号后缀继续找 —— 无论如何都不覆盖已有的冲突副本。
 */
async function writeConflictCopy(path: string, remoteText: string): Promise<string> {
  const dir = dirOf(path)
  const title = titleOf(path)
  /** 已确认空闲的候选路径；保持空串即还没找到，两条查找循环都以它为终止条件。 */
  let candidate = ''
  const taken = async (p: string): Promise<boolean> =>
    (await opfs.existsNote(p)) || (await db.notes.get(p)) !== undefined

  for (let i = 0; i < 50 && candidate === ''; i++) {
    const name = `${title}.conflict-${conflictStamp(new Date(Date.now() + i * 1000))}.md`
    const p = normalizePath(dir === '' ? name : `${dir}/${name}`)
    if (!(await taken(p))) candidate = p
  }
  // 兜底：50 个秒级时间戳都被占用（同一秒内堆出 50 个副本才可能发生）。序号后缀与时间戳
  // 后缀的形状互不相交，名字空间不会撞，一直试到真空闲为止。
  for (let n = 2; candidate === ''; n++) {
    const name = `${title}.conflict-${conflictStamp()}-${n}.md`
    const p = normalizePath(dir === '' ? name : `${dir}/${name}`)
    if (!(await taken(p))) candidate = p
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
  await useVaultStore().reindexContent(candidate, remoteText, { deferCards: true })
  await logSync('warn', `冲突: ${path} 的远端版本已另存为 ${candidate}`)
  return candidate
}

/** 生成可读的提交信息，形如 `vault: 新增 2, 更新 5 (含 1 个冲突副本) @ 2026-01-01 00:00:00`。 */
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

/** 把任意抛出物转成一行可展示文案。 */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 一轮完整同步：拉索引 → 应用远端删除 → 推送（含三方合并与冲突副本）→ 再拉一次索引收尾。
 * 任何一步抛错都收进 summary.errors 并落日志，不向上抛——调用方拿到的永远是 summary。
 */
export async function syncAll(cfg: GiteeConfig, sink: ProgressSink = noop): Promise<SyncSummary> {
  const summary = emptySummary()
  try {
    await pullIndex(cfg, summary, sink)
    await applyRemoteDeletions(summary)
    await push(cfg, summary, sink)
    // 再读一次索引，让 base/remote sha 反映推送后的现实，也覆盖这期间的并发改动。
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
