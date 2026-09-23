/**
 * Gitee API v5 客户端，从浏览器直接调用。
 *
 * 已对线上端点验证：响应带 `Access-Control-Allow-Origin: *`，OPTIONS preflight 返回 200，因此不需要代理。
 * 两条约束决定了本层的写法：
 *  - `Access-Control-Expose-Headers` 只列出 `Etag, total_count, total_page`，JS 读不到 `X-RateLimit-*`。
 *    限流只能被动应对（撞 403/429 后指数退避），无法事前按配额预算。
 *  - token 走 `access_token` query 参数（v5 文档推荐用法），避免依赖 `Authorization` 触发的 preflight。
 *
 * 硬约束：全程使用浏览器 API（fetch / atob / btoa / TextDecoder），不可在 node 下直跑；
 * 对外只暴露类型与函数，供 engine.ts 编排；引用同层用相对导入，无 `@/` 别名。
 */

/** Gitee API v5 根地址，所有端点都在其下拼接。 */
const API_ROOT = 'https://gitee.com/api/v5'

/** 一个仓库的一条分支即可定位同步目标；token 由用户在设置里填，仅存本地。 */
export interface GiteeConfig {
  token: string
  owner: string
  repo: string
  branch: string
}

/**
 * 用户常把地址栏内容（`https://gitee.com/owner/repo/tree/main`）整条粘进 owner 或 repo 输入框，
 * 用这个裸串拼出的 API 路径必然 404。这里把它拆回各段，让「直接粘贴仓库地址」可用。
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

/** 逐字段套用 parseRepoUrl，并去掉多余的 `/` 与 `.git` 后缀，得到能直接拼进 URL 的配置。 */
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

/** 文件树里的一条 blob。`sha` 即 git blob sha，是整层比对内容的唯一凭据。 */
export interface TreeEntry {
  path: string
  sha: string
  type: 'blob' | 'tree' | 'commit'
  size: number
}

/** 一次多文件提交里的单条动作。`move` 只是类型占位：引擎目前不产出它，降级路径也会跳过。 */
export type CommitAction =
  | { action: 'create' | 'update'; path: string; content: string }
  | { action: 'delete'; path: string }
  | { action: 'move'; path: string; previousPath: string }

/** 统一封装 Gitee 的失败。`retryable` 是上层 withRetry 决定退避还是直接抛的唯一依据。 */
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

/** 404 单独判定：读远端文件/祖先 blob 时「不存在」是正常结果，不该冒成错误。 */
export function isNotFound(err: unknown): boolean {
  return err instanceof GiteeError && err.status === 404
}

function encodePath(path: string): string {
  // 空格保持为 %20：路径段里 `+` 是字面加号而非空格，交给 query 那套编码会把文件名弄错。
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/** v5 用 query 参数带 token，故每个 URL 出站前都要过一遍（含 GET）。 */
function withToken(url: URL, token: string): URL {
  url.searchParams.set('access_token', token)
  return url
}

/** owner/repo 在此统一 encodeURIComponent，避免中文或特殊字符仓库名拼坏路径。 */
function repoUrl(cfg: GiteeConfig, path: string): URL {
  return new URL(
    `${API_ROOT}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}${path}`,
  )
}

interface RequestOptions {
  method?: string
  body?: unknown
  etag?: string
  /** 声明需要回带 ETag（当前仅 getFile 传 true；实际 ETag 恒从响应头取，此标志未被消费）。 */
  wantEtag?: boolean
}

/** 已解析的响应。304（ETag 命中）与网络层失败都归一到这一个形状，调用方只认 status。 */
interface RawResponse {
  status: number
  etag: string | null
  data: unknown
}

/**
 * 所有请求的唯一出口：拼 token、发 fetch、把 HTTP/网络异常统一翻成 GiteeError。
 * fetch 抛错（断网等）归为 status 0 且 retryable；非 2xx 交由 describeError/isRetryable 定性。
 */
async function raw(
  cfg: GiteeConfig,
  url: URL,
  options: RequestOptions = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.etag) headers['If-None-Match'] = options.etag
  // 不带 Content-Type 时 Gitee 无法解析 JSON body，直接回 406；无 body 的 GET 一直是好的，
  // 这正是过去「只有 push 会挂」的根因，故仅对有 body 的请求补这个头。
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

/** 把状态码翻成给用户看的中文诊断；401/403/404 各自给出可操作的下一步提示。 */
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

/** 判定某次失败是否值得退避重试：网络抖动、429、5xx 恒可；403 要看是不是限流。 */
function isRetryable(status: number, data: unknown): boolean {
  if (status === 0 || status === 429) return true // status 0 = fetch 抛错（断网/DNS），稍后自愈
  if (status >= 500) return true // Gitee 侧故障，交由 withRetry 指数退避
  if (status === 403) {
    // 403 既可能是权限不足也可能是限流，只有 message 像限流的才重试，否则越试越糟。
    const msg = typeof data === 'object' && data !== null && 'message' in data
      ? String((data as { message: unknown }).message).toLowerCase()
      : ''
    return msg.includes('limit') || msg.includes('频率') || msg.includes('too many')
  }
  return false
}

/** 取配置分支的 head commit sha，作为拉取整棵文件树的入口。 */
export async function getBranchHead(cfg: GiteeConfig): Promise<string> {
  const url = repoUrl(cfg, `/branches/${encodeURIComponent(cfg.branch)}`)
  const { data } = await raw(cfg, url)
  const commit = (data as { commit?: { sha?: string } })?.commit
  if (!commit?.sha) throw new GiteeError(502, '无法解析分支 head commit', true)
  return commit.sha
}

/** `truncated` 为真时仓库文件过多、树被截断，本轮同步不完整，必须由上层显式告警而非静默采信。 */
export interface TreeResult {
  sha: string
  entries: TreeEntry[]
  truncated: boolean
}

/** 单次 `trees?recursive=1` 拿到整个 vault——这是「先索引、后按需取正文」这套廉价增量同步的支点。 */
export async function getTree(cfg: GiteeConfig, treeSha: string): Promise<TreeResult> {
  const url = repoUrl(cfg, `/git/trees/${encodeURIComponent(treeSha)}`)
  url.searchParams.set('recursive', '1')
  const { data } = await raw(cfg, url)
  const payload = data as { sha?: string; truncated?: boolean; tree?: unknown[] }
  const entries: TreeEntry[] = []
  for (const item of payload.tree ?? []) {
    const e = item as { path?: string; sha?: string; type?: string; size?: number }
    // 只收 blob：目录（tree）与子模块（commit）没有正文，不参与 sha 比对。
    if (!e.path || !e.sha || e.type !== 'blob') continue
    entries.push({ path: e.path, sha: e.sha, type: 'blob', size: e.size ?? 0 })
  }
  return { sha: payload.sha ?? treeSha, entries, truncated: payload.truncated === true }
}

/** `text` 已按 UTF-8 解好；`sha` 是远端 blob sha，用于比对；`etag` 供下次条件请求复用。 */
export interface FileContent {
  text: string
  sha: string
  etag: string | null
}

/** 取单篇正文。远端不存在该文件时返回 `file: null`（不抛错）；带 etag 命中则 `notModified: true`。 */
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
 * 按 sha 取一个 blob。用于在三方合并时找回共同祖先——祖先仍作为旧 commit 的一部分留在仓库里，
 * 因此本地无须另存影子副本。blob 已不可达（被 gc / force push 抹掉）时返回 null。
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
 * 一次提交多个文件。Gitee 在此仿照 GitLab 的 `actions` 数组，这正是批量推送便宜的前提；
 * 但 gitee.com 自身会拒绝这种 body 形状（406），此时引擎里的 `commitBatch`
 * 降级为每个动作一次 contents API 请求。返回本次 commit 的 sha。
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

/**
 * 逐文件写入（单文件 contents API）。`existingSha` 非空走 PUT 更新且必须带 sha 做乐观锁，
 * 为空走 POST 新建——这是多文件提交不可用时的降级写入路径。
 * 返回所在 commit 的 sha；解析不到时退化为 ''。
 */
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

/**
 * 删除远端单个文件。`blobSha` 即本地记下的 remoteSha，Gitee 用它确认删的是同一版本
 * （乐观锁）：不匹配会拒绝，宁可失败也不删掉别人刚推上去的内容。
 */
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

/** 供设置对话框使用的轻量检查：连通性 + 令牌有效性 + 仓库是否存在，返回 head sha 与文件总数。 */
export async function testConnection(cfg: GiteeConfig): Promise<{ head: string; files: number }> {
  const head = await getBranchHead(cfg)
  const tree = await getTree(cfg, head)
  return { head, files: tree.entries.length }
}

/** base64 → UTF-8 文本：先剥掉 Gitee 折进 body 的换行空白再 atob，末按 UTF-8 解字节（容错不抛）。 */
export function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64.replace(/[\s\r\n]/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/** UTF-8 文本 → base64：按 32KB 分块转二进制，避免展开参数超出调用栈上限。 */
export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
