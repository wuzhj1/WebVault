/**
 * AI 的**提示词层**：动作命令表 + prompt 组装 + 上下文裁剪。纯模块——只用相对导入、
 * 不碰浏览器 API 与 `db.ts`，`scripts/verify-ai-prompts.mts` 裸 node 直跑本文件。
 *
 * 三条设计纪律，全部为「AI 与自己的思考分隔」服务：
 * 1. **动作是显式注册表**：选区浮层、整篇处理页签渲染什么，完全由 `SELECTION_ACTIONS` /
 *    `NOTE_ACTIONS` 决定——新增一个动作是往数组里加一项，不是散落各处的 if；
 * 2. **输出纪律写进 prompt**：AI 的输出要么被 `aiQuoteBlock` 包进引用块插入、要么整篇沉淀，
 *    两种落法都带标记，所以 prompt 统一要求「只输出结果本体」，不留解释性前后缀干扰引用块；
 * 3. **上下文先裁再发**：引用笔记、标题索引都有硬上限（`clip`），长文不裁会静默撑爆
 *    上下文窗口——请求失败用户看到的是 400，而不是「你贴太长了」。
 */
import { AI_DIR } from './marks.ts'

/** 系统提示词：身份、语言、输出纪律。三条都是硬要求，别在这上面做「简洁」优化。 */
export const SYSTEM_PROMPT = [
  '你是 WebVault 笔记应用里的写作助手，用简体中文回答（用户明确要求翻译时除外）。',
  '你的输出会被明确标记为 AI 生成内容并插入用户的笔记，因此：',
  '- 只输出结果本体，不要开场白、不要“好的”“以下是”这类前缀、不要结尾解释；',
  '- 结果是多段时直接用空行分段，不要用编号之外的装饰包裹；',
  '- 不确定就明说“不确定”，不要编造引用、链接或事实。',
].join('\n')

/** 一个可触发的 AI 动作：浮层/页签渲染它，prompt 由 `build*Prompt` 按 id 组装。 */
export interface AiAction {
  /** 稳定 id，进 prompt 与日志用，改名会让旧消息的 label 失配。 */
  id: string
  /** 面板上显示的短标签。 */
  label: string
  /** 悬停提示，说明这个动作干什么。 */
  hint: string
}

/** 选中文本后的动作表（选区浮层按此渲染）。 */
export const SELECTION_ACTIONS: readonly AiAction[] = [
  { id: 'rewrite', label: '改写', hint: '保留原意，换更准确的表达' },
  { id: 'polish', label: '润色', hint: '修语病、统一语气，不动内容' },
  { id: 'expand', label: '续写', hint: '沿着选中片段的语境继续往下写' },
  { id: 'summarize', label: '总结', hint: '抽出要点，压成几行' },
  { id: 'translate', label: '翻译', hint: '中英互译（中文译英文、英文译中文）' },
  { id: 'explain', label: '解释', hint: '讲清楚这段在说什么、为什么' },
]

/** 整篇笔记的处理动作（AI 面板「引用笔记」后的快捷按钮按此渲染）。 */
export const NOTE_ACTIONS: readonly AiAction[] = [
  { id: 'note-summary', label: '总结', hint: '提炼全篇要点' },
  { id: 'note-tags', label: '标签', hint: '给出建议的 #标签 列表' },
  { id: 'note-outline', label: '提纲', hint: '整理成结构化大纲' },
]

/** 单段文本进 prompt 的硬上限（字符）。超长按头保留、尾截断，见 `clip`。 */
export const MAX_CONTEXT_CHARS = 16_000

/** 「双链建议」能携带的库内标题条数上限：全库几千条标题会把上下文吃光。 */
export const MAX_TITLES = 400

/**
 * 裁剪：超限的文本保留开头与结尾各一半，中间以省略行标出。
 *
 * 头尾都留是因为笔记的关键信息常在开头（标题、结论），而选区操作的上下文常在结尾
 * （正在写的那句话）；只保头或只保尾都会丢掉一半场景。
 */
export function clip(text: string, max = MAX_CONTEXT_CHARS): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  return `${text.slice(0, head)}\n…（中间省略 ${text.length - max} 字符）\n${text.slice(text.length - tail)}`
}

/** 引用笔记进上下文时的定界包裹：模型看到的边界是显式的，用户消息本体前后不会被误读。 */
export function wrapNoteContext(text: string, path: string, body: string): string {
  return `<引用笔记 path="${path}">\n${clip(body)}\n</引用笔记>\n\n${text}`
}

/** 选区操作的 prompt；`actionId` 必须来自 `SELECTION_ACTIONS`，未知 id 退回「改写」。 */
export function buildSelectionPrompt(actionId: string, selected: string): string {
  const action = SELECTION_ACTIONS.find((a) => a.id === actionId) ?? SELECTION_ACTIONS[0]!
  const task: Record<string, string> = {
    rewrite: '在保留原意的前提下改写下面这段文本。',
    polish: '润色下面这段文本：修语病、让语气一致，不增删信息。',
    expand: '沿着下面片段的语境续写，衔接自然、风格一致。',
    summarize: '总结下面这段文本的要点。',
    translate: '翻译下面这段文本：中文译成英文，英文译成中文。',
    explain: '解释下面这段文本在说什么、为什么这么说。',
  }
  return [
    task[action.id] ?? task.rewrite!,
    '',
    '<选中文本>',
    clip(selected),
    '</选中文本>',
    '',
    '只输出结果本体。',
  ].join('\n')
}

/** 整篇处理的 prompt；`actionId` 必须来自 `NOTE_ACTIONS`。 */
export function buildNotePrompt(actionId: string, body: string, title?: string): string {
  const action = NOTE_ACTIONS.find((a) => a.id === actionId) ?? NOTE_ACTIONS[0]!
  const task: Record<string, string> = {
    'note-summary': '总结下面这篇笔记的要点，分点列出。',
    'note-tags': '给出适合这篇笔记的 #标签（5 到 8 个，直接以 #标签 形式输出在一行里）。',
    'note-outline': '把下面这篇笔记整理成结构化大纲（保留原有层级关系）。',
  }
  const header = title ? `笔记标题：${title}\n\n` : ''
  return `${task[action.id] ?? task['note-summary']!}\n\n${header}${clip(body)}`
}

/**
 * 双链建议：携带笔记正文 + 库内标题索引，让模型建议 `[[双链]]`。
 *
 * 标题索引是「AI 感知库」的唯一通道——本项目纯静态、模型看不到库，能建议什么链接
 * 完全取决于这里喂了什么；超过 `MAX_TITLES` 条时截断并在 prompt 里如实声明，
 * 不让模型以为库里只有这些标题。
 */
export function buildLinkSuggestPrompt(body: string, titles: readonly string[]): string {
  const shown = titles.slice(0, MAX_TITLES)
  const trunc = titles.length > shown.length ? `（仅列出前 ${MAX_TITLES} 条，库里共 ${titles.length} 条）` : ''
  const list = shown.map((t) => `- ${t}`).join('\n')
  return [
    '下面是这篇笔记的正文，以及这个库里已有笔记的标题。请建议 3 到 8 个最相关的标题，',
    `以 \`[[标题]]\` 形式列在最后，每行一个；只建议库里真实存在的标题，不要编造。${trunc}`,
    '',
    '<笔记正文>',
    clip(body),
    '</笔记正文>',
    '',
    '<库内标题>',
    list,
    '</库内标题>',
  ].join('\n')
}

/**
 * 对话的发送消息组装：把「引用笔记」作为定界块拼进用户消息。
 * 未附上下文时原样返回，历史消息与重发不受影响。
 */
export function buildUserMessage(
  text: string,
  quote?: { path: string; body: string } | null,
): string {
  if (!quote) return text
  return wrapNoteContext(text, quote.path, quote.body)
}

/** AI 面板的占位/空态文案；集中一处免得三个组件各写一份措辞。 */
export const AI_COPY = {
  /** 面板空态：一句话说明这里是什么。 */
  empty: '问点什么，或引用一篇笔记开始。',
  /** 未配置时的引导文案。 */
  unconfigured: '还没配置 AI：在设置 → AI 里填入接口地址、API Key 与模型名即可使用。',
  /** 引用笔记的芯片标题。 */
  quoteChip: '引用笔记',
  /** 发送中按钮的文案。 */
  sending: '生成中…',
  /** 对话历史的空态。 */
  noChats: '还没有对话。新对话从上面开始。',
  /** 产出页签的空态。 */
  noOutputs: `还没有 AI 产出。对话里点「存为笔记」，内容会进 ${AI_DIR}/ 目录。`,
} as const
