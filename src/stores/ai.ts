/**
 * AI 对话 store：会话与消息、流式发送、停止、历史管理、沉淀为笔记。
 *
 * 三层分隔里的**第①层（存放分隔）**落在这里：对话历史是 settings 表的一行
 * （键 `ai-chat-history` → `.webvault/ai-chats.json`），**不是**笔记——
 * 不进 `db.notes`、不被搜索索引、不随同步引擎推 Gitee；只有用户显式点「存为笔记」，
 * `saveAsNote` 才会经 `vault.createNote` 在 `ai/` 目录写出真正的 `.md`（那是定稿，会同步）。
 *
 * 单飞纪律（照 sync store 的做法）：同一时刻只允许一轮请求，`streaming` 置位期间
 * `send` 直接返回；停止走 `AbortController`，用户点「停止」时正在跑的流立刻中断，
 * 已产出的部分内容留在气泡里（那是用户要的），空壳回复撤掉。
 *
 * 引用笔记的正文只随**当次**发送进入请求，不在历史里留副本：历史消息存的是用户输入原文，
 * 既让会话保持轻，也避免同一段笔记在 JSON 里反复膨胀。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getSetting, putSetting } from '@/core/db.ts'
// 键名在 config-layout 声明：它同时决定这份历史落进 .webvault/ai-chats.json。
import { SETTING_KEYS } from '@/core/vault/config-layout.ts'
import { titleOf } from '@/core/vault/paths.ts'
import { isAborted, streamChat, type ChatMessage } from '@/core/ai/client.ts'
import { AI_COPY, MAX_CONTEXT_CHARS, SYSTEM_PROMPT, buildUserMessage, clip } from '@/core/ai/prompts.ts'
import {
  buildAiNoteContent,
  deriveTitle,
  uniqueAiPath,
  type AiMark,
} from '@/core/ai/marks.ts'
import { useAiSettingsStore } from './aiSettings.ts'
import { useVaultStore } from './vault.ts'

/** 一条对话消息；存进 settings 表的形状，字段只增不改（改名即丢历史）。 */
export interface AiMessage {
  /** 会话里只有用户与模型两个角色；system 由发送时组装，不落历史。 */
  role: 'user' | 'assistant'
  /** 用户的原话，或模型的回复正文。 */
  content: string
  /** 该条发出时引用的笔记路径（只有路径，正文不落历史，见模块注释）。 */
  quote?: string
  /** 产出该条回复的模型 id；沉淀成笔记时写进 frontmatter。 */
  model?: string
  /** 最后写入时刻（毫秒），流式期间随 chunk 前进，也当会话排序的次级依据。 */
  at: number
}

/** 一个会话：历史列表按 `at` 倒序展示，消息按时间正序。 */
export interface AiSession {
  id: string
  title: string
  at: number
  messages: AiMessage[]
}

/** 会话数量上限：超出后按 `at` 淘汰最旧的，防对话历史无限膨胀撑爆 settings 行。 */
const MAX_SESSIONS = 30

/** 历史落盘的防抖窗口；与 ui store 的书签同款——流式结束这种成批写不该逐条打盘。 */
const PERSIST_MS = 400

/** settings 表里的行键。 */
const KEY = SETTING_KEYS.aiChatHistory

/** 引用笔记的形状；`body` 已按上限裁剪，`clipped` 让面板如实提示「已截断」。 */
export interface AiQuote {
  path: string
  body: string
  clipped: boolean
}

/** 会话 id：时间戳 + 随机尾巴，不依赖 crypto.randomUUID（兼容更老的浏览器）。 */
function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export const useAiStore = defineStore('ai', () => {
  /** 全部会话，队首最新。 */
  const sessions = ref<AiSession[]>([])
  /** 当前打开的会话；null = 「新对话」（还没有消息，首条发送时才建会话）。 */
  const currentId = ref<string | null>(null)
  /** 有一轮请求在飞：发送/停止按钮、面板的流式提示都看它。 */
  const streaming = ref(false)
  /** 最近一次失败的原因；下次发送开始时清掉。面板内联展示，不用全局通知刷屏。 */
  const error = ref<string | null>(null)
  /** 待发送的「引用笔记」芯片；随发送一直生效直到用户点 × 摘掉（多轮追问都带上下文）。 */
  const quote = ref<AiQuote | null>(null)

  /** 当前会话对象；不存在返回 null（新对话态）。 */
  const currentSession = computed<AiSession | null>(
    () => sessions.value.find((s) => s.id === currentId.value) ?? null,
  )

  /** 正在飞的请求的中止柄；`stop()` 唯一的落点。 */
  let abortCtrl: AbortController | null = null
  /** 落盘防抖句柄。 */
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  /** 历史读库的重入守卫：面板、启动、发送三处都会调。 */
  let loading: Promise<void> | null = null
  let loaded = false

  /** 读历史（从未存过时是空列表）；带重入守卫，重复调用只等同一次读库。 */
  function load(): Promise<void> {
    if (loaded) return Promise.resolve()
    if (loading) return loading
    loading = (async () => {
      const stored = await getSetting<unknown>(KEY, [])
      // 手改坏的文件不该让面板整个挂掉：逐会话做形状守卫，坏的丢掉、好的保留。
      sessions.value = Array.isArray(stored)
        ? stored
            .filter(
              (s): s is AiSession =>
                !!s &&
                typeof (s as AiSession).id === 'string' &&
                typeof (s as AiSession).title === 'string' &&
                Array.isArray((s as AiSession).messages),
            )
            .slice(0, MAX_SESSIONS)
        : []
      loaded = true
    })()
    return loading
  }

  /** 防抖落盘整份历史；调用点是「一批变更完成」的时机（发送结束、删会话），不是流式 delta。 */
  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      void putSetting(KEY, sessions.value)
    }, PERSIST_MS)
  }

  /** 新会话顶到队首并淘汰超量的最旧会话（当前打开的那条永不淘汰）。 */
  function prune(): void {
    if (sessions.value.length <= MAX_SESSIONS) return
    const keep = new Set<string>([...sessions.value.slice(0, MAX_SESSIONS)].map((s) => s.id))
    if (currentId.value) keep.add(currentId.value)
    sessions.value = sessions.value.filter((s) => keep.has(s.id))
  }

  /** 摘掉引用芯片（用户显式动作；发送不会自动摘）。 */
  function clearQuote(): void {
    quote.value = null
  }

  /**
   * 设置引用芯片：正文按 `MAX_CONTEXT_CHARS` 裁剪，裁过如实标 `clipped`。
   * 由 App 调用——它负责先 `flushSave()` 拿到落盘后的正文，这里只管形状。
   */
  function setQuote(path: string, rawBody: string): void {
    const clipped = rawBody.length > MAX_CONTEXT_CHARS
    quote.value = { path, body: clip(rawBody), clipped }
  }

  /** 切到「新对话」：停掉在飞的流（避免回复落进看不见的会话），清错误。 */
  function newChat(): void {
    stop()
    currentId.value = null
    error.value = null
  }

  /** 打开历史里的某个会话。 */
  function openSession(id: string): void {
    stop()
    currentId.value = id
    error.value = null
  }

  /** 删除会话；删的是当前会话则退回新对话态。 */
  function deleteSession(id: string): void {
    const target = sessions.value.find((s) => s.id === id)
    if (target && currentId.value === id) stop()
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (currentId.value === id) currentId.value = null
    schedulePersist()
  }

  /** 中止在飞的请求；面板的「停止」按钮与 newChat/openSession 都走这里。 */
  function stop(): void {
    abortCtrl?.abort()
  }

  /**
   * 发一轮对话。
   *
   * @param raw 用户输入（或快捷动作的可见文案）
   * @param opts.prompt 实际发给模型的完整 prompt（整篇处理的快捷动作用：可见文案是
   *   「总结（引用 xx）」，prompt 里才是笔记正文）；缺省 = `raw` 加引用芯片上下文。
   * @param opts.label 历史里记的可见文案；缺省 = `raw`。
   */
  async function send(raw: string, opts?: { prompt?: string; label?: string }): Promise<void> {
    const text = raw.trim()
    if (text === '' || streaming.value) return
    const cfg = useAiSettingsStore()
    await cfg.load()
    await load()
    if (!cfg.configured) {
      error.value = AI_COPY.unconfigured
      return
    }
    error.value = null

    const now = Date.now()
    let session = currentSession.value
    if (!session) {
      session = { id: newId(), title: deriveTitle(text, 24) || '新对话', at: now, messages: [] }
      sessions.value = [session, ...sessions.value]
      prune()
      currentId.value = session.id
    }

    const quotePath = quote.value?.path
    session.messages.push({
      role: 'user',
      content: opts?.label ?? text,
      ...(quotePath ? { quote: quotePath } : {}),
      at: now,
    })

    // 历史按存档原样重放；只有最后一条（本轮）换成带引用上下文的版本——正文不进历史。
    const history: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }]
    for (const m of session.messages) {
      if (m.content.trim() === '') continue
      history.push({ role: m.role, content: m.content })
    }
    history[history.length - 1] = {
      role: 'user',
      content: opts?.prompt ?? buildUserMessage(text, quote.value),
    }

    const placeholder: AiMessage = { role: 'assistant', content: '', model: cfg.settings.model, at: now }
    session.messages.push(placeholder)

    streaming.value = true
    abortCtrl = new AbortController()
    try {
      // 增量已经通过 onDelta 累进 placeholder,这里不接返回值——中途停止时以已产出的部分为准。
      await streamChat({
        cfg: { ...cfg.settings },
        messages: history,
        signal: abortCtrl.signal,
        onDelta: (delta) => {
          placeholder.content += delta
          placeholder.at = Date.now()
        },
      })
      // 供应商收尾时一个字没给：给个可见的占位，免得空泡泡看着像「没反应」。
      if (placeholder.content === '') placeholder.content = '（模型返回了空回复）'
    } catch (err) {
      // 空壳一律撤掉：失败/停止都不该在会话里留一个空气泡；有部分内容则保留（那是用户要的）。
      if (placeholder.content === '') session.messages.pop()
      if (!isAborted(err)) error.value = err instanceof Error ? err.message : String(err)
    } finally {
      streaming.value = false
      abortCtrl = null
      session.at = Date.now()
      // 队首可能是更早创建的会话；发送完把它顶回最前（最近活动优先）。
      const [first] = sessions.value
      if (first !== session) {
        sessions.value = [session, ...sessions.value.filter((s) => s.id !== session.id)]
      }
      schedulePersist()
    }
  }

  /**
   * 把一个会话沉淀成 `ai/` 下的笔记，返回新路径。
   * 内容 = frontmatter `ai:` 标记 + `# 标题` + 可见声明行 + 问答誊录——
   * `buildAiNoteContent` 是唯一的拼装出口，标记不可能被绕过。
   */
  async function saveAsNote(sessionId: string): Promise<string> {
    const vault = useVaultStore()
    const cfg = useAiSettingsStore()
    const session = sessions.value.find((s) => s.id === sessionId)
    if (!session) throw new Error('会话不存在')
    if (session.messages.length === 0) throw new Error('空会话没有可沉淀的内容')

    const model =
      [...session.messages].reverse().find((m) => m.role === 'assistant' && m.model)?.model ??
      cfg.settings.model ??
      ''
    const mark: AiMark = { model: model === '' ? 'unknown' : model, at: new Date().toISOString(), source: 'chat' }

    // 重名退让的判定要与 vault 的「在用」口径一致：墓碑不算占用（删完立刻同名重建是正常操作）。
    const path = uniqueAiPath(session.title, (p) => {
      const row = vault.byPath.get(p)
      return row !== undefined && row.removedLocal === 0
    })
    const content = buildAiNoteContent({ mark, title: titleOf(path), body: transcript(session) })
    return vault.createNote(path, content)
  }

  /** 会话 → 问答誊录正文；引用过的轮次附一行来源链接，分隔但可追溯。 */
  function transcript(session: AiSession): string {
    const parts: string[] = []
    let round = 0
    for (const m of session.messages) {
      const body = m.content.trim()
      if (body === '') continue
      if (m.role === 'user') {
        round++
        const from = m.quote ? `\n\n> 引用：[[${m.quote.replace(/\.md$/i, '')}]]` : ''
        parts.push(`### 问 ${round}\n\n${body}${from}`)
      } else {
        parts.push(`### 答 ${round}${m.model ? `（${m.model}）` : ''}\n\n${body}`)
      }
    }
    return parts.join('\n\n')
  }

  return {
    sessions,
    currentId,
    currentSession,
    streaming,
    error,
    quote,
    load,
    send,
    stop,
    newChat,
    openSession,
    deleteSession,
    clearQuote,
    setQuote,
    saveAsNote,
  }
})
