/**
 * Gitee API v5 client, called straight from the browser.
 *
 * Verified against the live endpoint: `Access-Control-Allow-Origin: *` and OPTIONS
 * preflight returns 200, so no proxy is needed. Two constraints shape this module:
 *
 *  - `Access-Control-Expose-Headers` only lists `Etag, total_count, total_page`, so
 *    `X-RateLimit-*` is unreadable from JS. Throttling has to be reactive (403/429 +
 *    backoff), never budgeted up front.
 *  - The token goes in the `access_token` query parameter, the documented v5 method,
 *    which keeps requests simple instead of relying on an `Authorization` preflight.
 */

const API_ROOT = 'https://gitee.com/api/v5'

export interface GiteeConfig {
  token: string
  owner: string
  repo: string
  branch: string
}

/**
 * People paste the address bar (`https://gitee.com/owner/repo/tree/main`) into the owner or
 * repo field, and the API path built from that bare string then 404s. Split such a value back
 * into segments so pasting the repo address just works.
 */
export function parseRepoUrl(value: string): Partial<Pick<GiteeConfig, 'owner' | 'repo' | 'branch'>> | null {
  const text = value.trim()
  const url = text.match(
    /^(?:https?:\/\/)?(?:www\.)?gitee\.com\/([^/?#\s]+)(?:\/([^/?#\s]+?))?(?:\.git)?(?:\/tree\/([^/?#\s]+))?\/?(?:[?#].*)?$/i,
  )
  if (url) return { owner: url[1], repo: url[2] || undefined, branch: url[3] || undefined }
  const bare = text.match(/^([^/\s]+)\/([^/\s]+)$/)
  return bare ? { owner: bare[1], repo: bare[2] } : null
}

export function normalizeGiteeConfig(cfg: GiteeConfig): GiteeConfig {
  const next = { ...cfg }
  for (const field of ['owner', 'repo'] as const) {
    const parsed = parseRepoUrl(next[field])
    if (!parsed) continue
    if (parsed.owner) next.owner = parsed.owner
    if (parsed.repo) next.repo = parsed.repo
    if (parsed.branch) next.branch = parsed.branch
  }
  next.owner = next.owner.trim().replace(/\/+$/, '')
  next.repo = next.repo.trim().replace(/\.git$/i, '').replace(/\/+$/, '')
  next.branch = next.branch.trim().replace(/\/+$/, '')
  return next
}

export interface TreeEntry {
  path: string
  sha: string
  type: 'blob' | 'tree' | 'commit'
  size: number
}

export type CommitAction =
  | { action: 'create' | 'update'; path: string; content: string }
  | { action: 'delete'; path: string }
  | { action: 'move'; path: string; previousPath: string }

export class GiteeError extends Error {
  readonly status: number
  readonly retryable: boolean

  constructor(status: number, message: string, retryable: boolean) {
    super(message)
    this.name = 'GiteeError'
    this.status = status
    this.retryable = retryable
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof GiteeError && err.status === 404
}

function encodePath(path: string): string {
  // Spaces stay %20: inside a path segment '+' is a literal plus, not a space.
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function withToken(url: URL, token: string): URL {
  url.searchParams.set('access_token', token)
  return url
}

function repoUrl(cfg: GiteeConfig, path: string): URL {
  return new URL(
    `${API_ROOT}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}${path}`,
  )
}

interface RequestOptions {
  method?: string
  body?: unknown
  etag?: string
  /** Return the ETag alongside the payload. */
  wantEtag?: boolean
}

interface RawResponse {
  status: number
  etag: string | null
  data: unknown
}

async function raw(
  cfg: GiteeConfig,
  url: URL,
  options: RequestOptions = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.etag) headers['If-None-Match'] = options.etag
  // Without Content-Type Gitee cannot parse the JSON body and answers 406; bodyless GETs
  // worked fine, which is why only pushes failed.
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(withToken(url, cfg.token).toString(), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch (err) {
    throw new GiteeError(0, `网络请求失败: ${err instanceof Error ? err.message : String(err)}`, true)
  }

  if (response.status === 304) {
    return { status: 304, etag: response.headers.get('ETag'), data: null }
  }

  const text = await response.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { message: text.slice(0, 300) }
    }
  }

  if (!response.ok) {
    throw new GiteeError(response.status, describeError(response.status, data), isRetryable(response.status, data))
  }
  return { status: response.status, etag: response.headers.get('ETag'), data }
}

function describeError(status: number, data: unknown): string {
  const msg = typeof data === 'object' && data !== null && 'message' in data
    ? String((data as { message: unknown }).message)
    : ''
  switch (status) {
    case 401:
      return '私人令牌无效或已过期,请在设置中重新填写。'
    case 403:
      return msg.includes('limit') || msg.includes('频率')
        ? '触发 Gitee 接口频率限制,稍后会自动重试。'
        : `无权限访问该仓库(403)。${msg}`
    case 404:
      return `仓库、分支或文件不存在(404)。请核对 owner/repo/branch 与仓库地址 gitee.com/<owner>/<repo> 是否一致;私有仓库要求令牌勾选了 projects 权限;完全空的仓库没有分支,需先提交一个文件。${msg}`
    default:
      return msg || `Gitee 接口返回 ${status}`
  }
}

function isRetryable(status: number, data: unknown): boolean {
  if (status === 0 || status === 429) return true
  if (status >= 500) return true
  if (status === 403) {
    const msg = typeof data === 'object' && data !== null && 'message' in data
      ? String((data as { message: unknown }).message).toLowerCase()
      : ''
    return msg.includes('limit') || msg.includes('频率') || msg.includes('too many')
  }
  return false
}

/** Head commit sha of the configured branch. */
export async function getBranchHead(cfg: GiteeConfig): Promise<string> {
  const url = repoUrl(cfg, `/branches/${encodeURIComponent(cfg.branch)}`)
  const { data } = await raw(cfg, url)
  const commit = (data as { commit?: { sha?: string } })?.commit
  if (!commit?.sha) throw new GiteeError(502, '无法解析分支 head commit', true)
  return commit.sha
}

export interface TreeResult {
  sha: string
  entries: TreeEntry[]
  truncated: boolean
}

/** Whole vault in one request — the backbone of cheap incremental sync. */
export async function getTree(cfg: GiteeConfig, treeSha: string): Promise<TreeResult> {
  const url = repoUrl(cfg, `/git/trees/${encodeURIComponent(treeSha)}`)
  url.searchParams.set('recursive', '1')
  const { data } = await raw(cfg, url)
  const payload = data as { sha?: string; truncated?: boolean; tree?: unknown[] }
  const entries: TreeEntry[] = []
  for (const item of payload.tree ?? []) {
    const e = item as { path?: string; sha?: string; type?: string; size?: number }
    if (!e.path || !e.sha || e.type !== 'blob') continue
    entries.push({ path: e.path, sha: e.sha, type: 'blob', size: e.size ?? 0 })
  }
  return { sha: payload.sha ?? treeSha, entries, truncated: payload.truncated === true }
}

export interface FileContent {
  text: string
  sha: string
  etag: string | null
}

/** `null` when the file does not exist on the remote; `etag` reused for conditional GETs. */
export async function getFile(
  cfg: GiteeConfig,
  path: string,
  etag?: string,
): Promise<{ file: FileContent | null; notModified: boolean }> {
  const url = repoUrl(cfg, `/contents/${encodePath(path)}`)
  url.searchParams.set('ref', cfg.branch)
  try {
    const res = await raw(cfg, url, { etag, wantEtag: true })
    if (res.status === 304) return { file: null, notModified: true }
    const d = res.data as { content?: string; encoding?: string; sha?: string }
    if (typeof d.content !== 'string') {
      throw new GiteeError(502, `Gitee 返回的文件内容格式异常: ${path}`, true)
    }
    const text = d.encoding === 'base64' ? decodeBase64Utf8(d.content) : d.content
    return { file: { text, sha: d.sha ?? '', etag: res.etag }, notModified: false }
  } catch (err) {
    if (isNotFound(err)) return { file: null, notModified: false }
    throw err
  }
}

/**
 * Fetch a blob by sha. Used to recover the common ancestor for a three-way merge —
 * the ancestor still exists in the repo as part of an older commit, so there is no need
 * to keep shadow copies locally. `null` when the blob is no longer reachable.
 */
export async function getBlob(cfg: GiteeConfig, sha: string): Promise<string | null> {
  const url = repoUrl(cfg, `/git/blobs/${encodeURIComponent(sha)}`)
  try {
    const { data } = await raw(cfg, url)
    const d = data as { content?: string; encoding?: string }
    if (typeof d.content !== 'string') return null
    return d.encoding === 'base64' ? decodeBase64Utf8(d.content) : d.content
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

/**
 * Commit several files at once. Gitee mirrors GitLab's `actions` array here, which is
 * what makes batching cheap; gitee.com itself rejects this body shape (406), in which case
 * `commitBatch` in the engine degrades to one contents-API request per action.
 */
export async function commitFiles(
  cfg: GiteeConfig,
  message: string,
  actions: CommitAction[],
): Promise<string> {
  const url = repoUrl(cfg, '/commits')
  const { data } = await raw(cfg, url, {
    method: 'POST',
    body: {
      message,
      branch: cfg.branch,
      actions: actions.map((a) =>
        a.action === 'move'
          ? { action: 'move', path: a.path, previous_path: a.previousPath, encoding: 'text' }
          : a.action === 'delete'
            ? { action: 'delete', path: a.path }
            : { action: a.action, path: a.path, content: a.content, encoding: 'text' },
      ),
    },
  })
  const sha = (data as { sha?: string; commit?: { sha?: string } }).sha
    ?? (data as { commit?: { sha?: string } }).commit?.sha
  if (!sha) throw new GiteeError(502, 'Gitee 提交成功但未返回 commit sha', true)
  return sha
}

export async function putFile(
  cfg: GiteeConfig,
  path: string,
  content: string,
  message: string,
  existingSha: string | null,
): Promise<string> {
  const url = repoUrl(cfg, `/contents/${encodePath(path)}`)
  const body: Record<string, unknown> = {
    message,
    branch: cfg.branch,
    content: encodeBase64Utf8(content),
    encoding: 'base64',
  }
  if (existingSha) body.sha = existingSha
  const { data } = await raw(cfg, url, {
    method: existingSha ? 'PUT' : 'POST',
    body,
  })
  const commit = (data as { commit?: { sha?: string } }).commit
  return commit?.sha ?? ''
}

export async function deleteRemoteFile(
  cfg: GiteeConfig,
  path: string,
  blobSha: string,
  message: string,
): Promise<void> {
  const url = repoUrl(cfg, `/contents/${encodePath(path)}`)
  await raw(cfg, url, {
    method: 'DELETE',
    body: { message, branch: cfg.branch, sha: blobSha },
  })
}

/** Cheap connectivity + credential + repo-existence check used by the settings dialog. */
export async function testConnection(cfg: GiteeConfig): Promise<{ head: string; files: number }> {
  const head = await getBranchHead(cfg)
  const tree = await getTree(cfg, head)
  return { head, files: tree.entries.length }
}

export function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64.replace(/[\s\r\n]/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
