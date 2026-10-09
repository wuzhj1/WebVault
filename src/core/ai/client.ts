/**
 * AI 的 HTTP 层：浏览器直连 OpenAI 兼容的 `/chat/completions`（用户自填 baseUrl + apiKey，零后端）。
 *
 * 照抄 `core/sync/gitee.ts` 的两条模式，那边在本项目里已被验证过：
 * - 错误统一是带 `status` / `retryable` 的错误类（对应 `GiteeError`），调用方按可重试性决定
 *   「提示用户稍后再试」还是「改配置」，而不是到处 `String(err)`；
 * - 所有网络出口收在一个函数里，CORS / 网络 / 状态码的分类只写一次。
 *
 * 这一层自己补齐项目里一直缺的两件事（同步层至今没有，不顺手去改它，避免扩大改动面）：
 * - **AbortController**：停止按钮与超时都通过它生效，请求真正被中断而不是留着白跑；
 * - **空闲超时**：`IDLE_MS` 内一个字节都没收到就中止——供应商挂起时用户看到的是
 *   「超时」而不是转圈到天荒地老；每个 chunk 到达都重置计时，慢速长回复不受影响。
 *
 * 提供商预设只带 baseUrl 与模型名建议（`AI_PRESETS`）：模型名各家随时会换，UI 里永远可改。
 *
 * 硬约束：全程浏览器 API（fetch / TextDecoder / AbortController），不可在 node 下直跑；
 * 引用同层用相对导入，无 `@/` 别名。
 */

/** 一份可用的 AI 连接配置；同时是设置表 `ai-settings` 的 value 形状。 */
export interface AiConfig {
  /** OpenAI 兼容根地址，如 `https://api.deepseek.com/v1`（有无 `/v1` 都接受，见 `endpointOf`）。 */
  baseUrl: string
  /** 明文 API Key，只存本机、导出备份时被 redact 抹除。 */
  apiKey: string
  /** 模型 id，如 `deepseek-chat`。 */
  model: string
}

/** 供应商预设；点击只回填 baseUrl/模型名，是否可用仍以「测试连接」为准。 */
export interface AiPreset {
  name: string
  baseUrl: string
  /** 模型名只是建议值，各家模型迭代快，UI 里可改。 */
  model: string
}

export const AI_PRESETS: readonly AiPreset[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat' },
]

/** AI 请求失败的统一类型：`status` 是 HTTP 状态码（网络层失败为 0），`retryable` 指示「稍后重试是否有意义」。 */
export class AiError extends Error {
  readonly status: number
  readonly retryable: boolean

  constructor(status: number, message: string, retryable: boolean) {
    super(message)
    this.name = 'AiError'
    this.status = status
    this.retryable = retryable
  }
}

/**
 * 「是用户主动停的」的判定：中止原因统一是这条 `AiError`，
 * 调用方（stores/ai.ts）据此把停止当正常收尾——不上报错误、不弹通知。
 */
export function isAborted(err: unknown): boolean {
  return err instanceof AiError && err.status === 0 && err.message === '已停止'
}

/** 一条聊天消息；`system` 只由本层组装时插到最前。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 用户粘贴的地址五花八门（带尾斜杠、带 `/chat/completions`、没写协议），这里统一成可用根地址。 */
export function normalizeAiConfig(cfg: AiConfig): AiConfig {
  let baseUrl = cfg.baseUrl.trim()
  if (baseUrl !== '' && !/^https?:\/\//i.test(baseUrl)) baseUrl = `https://${baseUrl}`
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey: cfg.apiKey.trim(),
    model: cfg.model.trim(),
  }
}

/**
 * 拼出完整端点。用户把文档里的整条 `…/chat/completions` 粘进 baseUrl 也是常见操作，
 * 已带后缀就不再叠一层；`v1` 有无都接受（有的供应商根地址即 `/v1`，有的直接挂在根上）。
 */
export function endpointOf(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`
}

/** 空闲超时：这么久收不到任何字节就中止。首包与长回复的 chunk 都会重置它。 */
const IDLE_MS = 60_000

/** 测试连接用的短超时：一个 ping 不该让用户等一分钟。 */
const TEST_IDLE_MS = 20_000

/** 从错误响应体里尽量挖出供应商的 message；挖不到就截断原文（超长 HTML 没有意义）。 */
function detailOf(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  try {
    const json: unknown = JSON.parse(trimmed)
    const msg =
      (json as { error?: { message?: unknown } }).error?.message ??
      (json as { message?: unknown }).message
    if (typeof msg === 'string' && msg !== '') return `：${msg.slice(0, 300)}`
  } catch {
    /* 不是 JSON，落到下面按原文截断 */
  }
  return `：${trimmed.slice(0, 200)}`
}

/** 按状态码把失败翻译成能行动的中文提示；`retryable` 决定 UI 是给「稍后再试」还是「改配置」。 */
function classify(status: number, bodyText: string): AiError {
  const detail = detailOf(bodyText)
  if (status === 401 || status === 403)
    return new AiError(status, `API Key 无效或无权限（HTTP ${status}）${detail}`, false)
  if (status === 429)
    return new AiError(status, `请求过于频繁或配额用尽（HTTP 429）${detail}，稍后重试`, true)
  if (status === 404)
    return new AiError(status, `接口地址或模型不存在（HTTP 404）${detail}，检查 baseUrl 与模型名`, false)
  if (status === 400)
    return new AiError(status, `请求被拒绝（HTTP 400）${detail}`, false)
  if (status >= 500) return new AiError(status, `服务端错误（HTTP ${status}）${detail}，可重试`, true)
  return new AiError(status, `请求失败（HTTP ${status}）${detail}`, false)
}

/**
 * 一次请求的公共骨架：带空闲超时与外部中止的 fetch，失败统一翻成 `AiError`。
 * fetch 自身的 TypeError（CORS 被拒、DNS 挂、断网）在这里分类——浏览器不给原因，
 * 只能如实提示「跨域或网络」，这正是「换供应商/自建中转」该出现的时机。
 */
async function post(
  cfg: AiConfig,
  body: unknown,
  opts: { stream: boolean; idleMs: number; signal?: AbortSignal },
): Promise<Response> {
  const own = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const reset = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      own.abort()
    }, opts.idleMs)
  }
  const forward = () => own.abort()
  if (opts.signal) {
    if (opts.signal.aborted) own.abort()
    else opts.signal.addEventListener('abort', forward, { once: true })
  }
  reset()
  try {
    return await fetch(endpointOf(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: opts.stream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: own.signal,
    })
  } catch (err) {
    if (timedOut)
      throw new AiError(0, `请求超时：${Math.round(opts.idleMs / 1000)} 秒未收到任何响应`, true)
    if (opts.signal?.aborted) throw new AiError(0, '已停止', false)
    throw new AiError(
      0,
      `网络请求失败（${err instanceof Error ? err.message : String(err)}）：可能被供应商的 CORS 策略拒绝，或本机网络不通。可更换供应商或自建中转`,
      true,
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    opts.signal?.removeEventListener('abort', forward)
  }
}

/** 取响应正文做错误分类；读不出来（连接半途断）也给一句可行动的话。 */
async function fail(res: Response): Promise<never> {
  let text = ''
  try {
    text = await res.text()
  } catch {
    text = ''
  }
  throw classify(res.status, text)
}

/** 供应商在 SSE 里用 200 通道报的错（部分兼容网关这么干），按 400 处理、带原文。 */
function throwStreamError(data: unknown): never {
  const msg =
    (data as { error?: { message?: unknown } }).error?.message ??
    (data as { message?: unknown }).message
  throw new AiError(
    400,
    `流式响应返回错误：${typeof msg === 'string' ? msg.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`,
    false,
  )
}

/** `streamChat` 的入参。 */
export interface StreamChatOptions {
  cfg: AiConfig
  messages: readonly ChatMessage[]
  /** 外部中止信号（停止按钮）；与空闲超时共用同一个底层 controller。 */
  signal?: AbortSignal
  /** 每收到一段增量文本回调一次；流结束时 `streamChat` 的返回值是它的累计。 */
  onDelta?: (delta: string) => void
}

/**
 * 流式请求一轮对话，返回完整回复文本。
 *
 * 解析按 OpenAI SSE 约定（`data: {...}` 行 + `data: [DONE]` 终止），同时兼容两种现实偏差：
 * - 供应商忽略 `stream` 返回整段 JSON（`content-type: application/json`）——直接解析取
 *   `choices[0].message.content`，不该让用户因为「这家不支持流式」看到一个失败；
 * - chunk 边界切断了 SSE 行——按行缓冲，残行留到下一轮再拼。
 */
export async function streamChat(opts: StreamChatOptions): Promise<string> {
  const { cfg, messages, signal, onDelta } = opts
  const res = await post(
    cfg,
    { model: cfg.model, messages: [...messages], stream: true },
    { stream: true, idleMs: IDLE_MS, signal },
  )
  if (!res.ok) await fail(res)
  if (!res.body) throw new AiError(0, '响应没有正文流，无法读取回复', false)

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    let json: unknown
    try {
      json = JSON.parse(await res.text())
    } catch {
      throw new AiError(0, '响应不是合法 JSON，该地址可能不是 OpenAI 兼容接口', false)
    }
    if ((json as { error?: unknown }).error) throwStreamError(json)
    const content = (json as { choices?: { message?: { content?: unknown } }[] })
      .choices?.[0]?.message?.content
    if (typeof content !== 'string')
      throw new AiError(0, '响应里没有 choices[0].message.content', false)
    if (content !== '') onDelta?.(content)
    return content
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const own = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const reset = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      own.abort()
    }, IDLE_MS)
  }
  const forward = () => own.abort()
  if (signal) {
    if (signal.aborted) own.abort()
    else signal.addEventListener('abort', forward, { once: true })
  }
  // 读循环里再包一层 try：空闲超时发生在已建连之后，post() 的分类够不着这里。
  reset()
  let buffer = ''
  let out = ''
  let finished = false
  try {
    while (!finished) {
      const { done, value } = await reader.read()
      reset()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '')
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '') continue
        if (data === '[DONE]') {
          finished = true
          break
        }
        let json: unknown
        try {
          json = JSON.parse(data)
        } catch {
          continue // 半行注释或供应商私有事件，跳过比中断安全
        }
        if ((json as { error?: unknown }).error) throwStreamError(json)
        const delta = (json as { choices?: { delta?: { content?: unknown } }[] })
          .choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta !== '') {
          out += delta
          onDelta?.(delta)
        }
      }
    }
    return out
  } catch (err) {
    if (err instanceof AiError) throw err
    if (timedOut) throw new AiError(0, `响应超时：${IDLE_MS / 1000} 秒没收到新内容`, true)
    if (signal?.aborted) throw new AiError(0, '已停止', false)
    throw new AiError(
      0,
      `读取响应中断（${err instanceof Error ? err.message : String(err)}）`,
      true,
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
    reader.cancel().catch(() => {})
  }
}

/**
 * 测试连接：一轮 `stream: false` 的最小对话，200 即认为配置可用，返回响应里的模型 id。
 * 设置页用它区分三类失败：网络/CORS（换供应商）、401（改 Key）、429/5xx（稍后重试）。
 */
export async function testAiConnection(cfg: AiConfig): Promise<{ model: string }> {
  const res = await post(
    cfg,
    { model: cfg.model, messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 1 },
    { stream: false, idleMs: TEST_IDLE_MS },
  )
  if (!res.ok) await fail(res)
  let json: unknown
  try {
    json = JSON.parse(await res.text())
  } catch {
    throw new AiError(0, '响应不是合法 JSON，该地址可能不是 OpenAI 兼容接口', false)
  }
  if ((json as { error?: unknown }).error) throwStreamError(json)
  const model = (json as { model?: unknown }).model
  return { model: typeof model === 'string' && model !== '' ? model : cfg.model }
}
