/**
 * AI 分隔三层里的**标记层**（第②层）：AI 内容一旦进笔记，必须带着可机读（frontmatter `ai:`）
 * 与可见（`> 🤖` 引用块）的双重标记。本模块是这些标记的唯一生成处——
 * 「永不裸插」这条纪律靠的不是调用方自觉，而是裸插所需的函数在这里根本不存在：
 * 插入编辑器只走 `aiQuoteBlock`，沉淀成笔记只走 `buildAiNoteContent`，两条路都会带标记。
 *
 * 落盘位置同样由这里声明：AI 产出一律进 `ai/` 目录（`AI_DIR`），文件树的 AI 角标、
 * 侧栏 AI 分区的「产出」页签都按 `isAiPath` 过滤——三处共用一个判定，不会出现
 * 「角标认得、产出列表不认」的漂移。
 *
 * 硬约束：纯函数、只用相对导入，不得 import `db.ts` 或任何浏览器 API——
 * `scripts/verify-ai-prompts.mts` 以裸 node 直跑本文件。
 */
import { encodeScalar, parseFrontmatter } from '../parse/frontmatter.ts'
import { sanitizeTitle } from '../vault/paths.ts'

/** AI 产出笔记的专属目录。与笔记同层（vault 根下），因此会随同步引擎推到 Gitee——它是定稿，不是草稿。 */
export const AI_DIR = 'ai'

/** 标记块与角标共用的图标；与设置页/面板里表示 AI 的图标一致。 */
export const AI_ICON = '🤖'

/**
 * 是否是 AI 产出目录下的路径。前缀必须带 `/`（或整串相等），否则 `aifoo/x.md` 会被误判——
 * 这个函数决定文件树角标与「产出」列表，误判等于给用户自己的笔记贴 AI 标签。
 */
export function isAiPath(path: string): boolean {
  return path === AI_DIR || path.startsWith(`${AI_DIR}/`)
}

/** 一次 AI 产出的机读身份，写进 frontmatter；字段只增不改，老笔记靠缺省兼容。 */
export interface AiMark {
  /** 产出它的模型 id，如 `deepseek-chat`。 */
  model: string
  /** 产出时刻（ISO 8601 UTC），如 `2026-10-08T06:03:11.123Z`。 */
  at: string
  /** 产出路径：对话沉淀 / 选区操作 / 整篇处理。 */
  source: 'chat' | 'selection' | 'note'
}

/**
 * AI 产出笔记的 frontmatter 块（含收尾空行，`fm + body === 文件内容`）。
 *
 * `ai` 不在 frontmatter 模块的 `OWNED_KEYS` 里：它是**不透明负载**，字节稳定保留——
 * 用户用其他工具改它、或把它挪出 `ai/` 目录，`writeKeys` 的任何一次改写都不会碰它一个字节。
 * 这也是刻意的：本模块只在**创建**时写标记，此后永不回写。
 */
export function aiFrontmatter(mark: AiMark): string {
  return [
    '---',
    'ai:',
    `  model: ${encodeScalar(mark.model)}`,
    `  at: ${encodeScalar(mark.at)}`,
    `  source: ${encodeScalar(mark.source)}`,
    '---',
    '',
    '',
  ].join('\n')
}

/**
 * 可见标记块：把 AI 输出整体包进一个引用块，首行是 `🤖 AI（模型 · 来源）`。
 *
 * 「编辑器插入」的唯一入口就是它：正文里不存在裸插 AI 文本的路径，读者扫一眼引用块
 * 就知道这段不是作者写的。每一行都加 `>` 前缀，空行写成 `>`（引用块内空行的 markdown 写法），
 * 多段落输出不会在第一个空行处「越狱」出引用块。
 */
export function aiQuoteBlock(text: string, model: string, label?: string): string {
  const head = `${AI_ICON} **AI（${model}${label ? ` · ${label}` : ''}）**`
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return [`> ${head}`, '>', ...lines.map((line) => (line === '' ? '>' : `> ${line}`))].join('\n')
}

/** `buildAiNoteContent` 的入参：标记 + 标题 + 落盘正文。 */
export interface AiNoteSpec {
  mark: AiMark
  /** 文件名与 `# 一级标题` 用的标题；已由调用方过 `deriveTitle`。 */
  title: string
  /** 正文（对话沉淀是问答誊录，整篇处理是 AI 输出本身）。 */
  body: string
}

/**
 * 沉淀成整篇笔记的完整内容：frontmatter 标记 + `# 标题` + 可见声明行 + 正文。
 *
 * 可见声明行（`> 🤖 由 … 生成`）独立于 frontmatter 存在：frontmatter 在编辑器里不可见，
 * 而这篇笔记整篇都是 AI 产出，出编辑器（阅读视图、导出、贴给别人）也得带身份。
 */
export function buildAiNoteContent(spec: AiNoteSpec): string {
  const { mark, title, body } = spec
  const date = mark.at.slice(0, 10)
  const notice = `${AI_ICON} 由 ${mark.model} 生成于 ${date}，来源 ${mark.source}；本篇为 AI 产出，非作者原稿。`
  const clean = body.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  return `${aiFrontmatter(mark)}# ${title}\n\n> ${notice}\n\n${clean}\n`
}

/**
 * 从一段文本推导笔记标题：取首个非空行、剥 markdown 记号、压空白、截断。
 *
 * 返回值保证能过 `sanitizeTitle`（非空、无禁用字符的前身已剥掉）——`sanitizeTitle`
 * 在空串上会抛，而 AI 输出的第一个非空行可能是 `**加粗**` 这种剥完就没了的记号。
 */
export function deriveTitle(text: string, maxChars = 30): string {
  const first = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')
  const cleaned = (first ?? '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\s*[->*+]\s+/, '')
    .replace(/[`*_~]/g, '')
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...cleaned]
  return chars.length > maxChars ? chars.slice(0, maxChars).join('').trim() : cleaned
}

/**
 * 保证 `ai/<title>.md` 不撞已存在的笔记：重名时按 `title 2 / 3 / …` 退让。
 *
 * `createNote` 对占用路径是**幂等早退**（不写内容直接返回路径）——不先退让的话，
 * 第二次沉淀同名笔记会「提示成功」却一个字都没写进去。
 *
 * `sanitizeTitle` 对「剥完只剩禁用字符/点号」的标题会抛（`/…/`、`..` 都会），而 AI 输出
 * 的第一行完全可能长这样——沉淀是收尾动作，不能在最后一步炸掉，一律兜底成 `AI 笔记`。
 */
export function uniqueAiPath(title: string, exists: (path: string) => boolean): string {
  let stem: string
  try {
    stem = sanitizeTitle(deriveTitle(title))
  } catch {
    stem = 'AI 笔记'
  }
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ` ${n}`
    const path = `${AI_DIR}/${stem}${suffix}.md`
    if (!exists(path)) return path
  }
}

/**
 * 从整篇文件内容里读出 `ai:` 标记的 model 值；不是 AI 产出或缺字段返回 null。
 * 只用于展示（如右栏信息），判定「是不是 AI 笔录」永远以 `isAiPath` 为准。
 */
export function readAiModel(raw: string): string | null {
  const fm = parseFrontmatter(raw)
  if (!fm.exists) return null
  const line = fm.body.find((l) => l.trimStart().startsWith('model:'))
  if (!line) return null
  const value = line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '')
  return value === '' ? null : value
}
