/**
 * Wikilink / tag / heading 抽取。
 *
 * 刻意不拿一个裸正则扫全文：先屏蔽围栏代码块、行内代码和 YAML frontmatter，否则 README 里
 * 展示的 `[[example]]` 语法会被当成一条真实反链。
 *
 * 与 `frontmatter.ts` 的逐字节约定：两者必须用同一个 `FRONTMATTER_DELIM` 判定块边界，
 * 一方若把另一方的元数据当正文解析，反链和标签就会污染索引。本文件只用相对导入
 * （验证脚本以裸 node 直跑，无 `@/` 别名解析），且运行时不导入 `db.ts`。
 */

import { FRONTMATTER_DELIM, frontmatterEnd } from './frontmatter.ts'

/** 一条 `[[...]]` 双链的解析结果，字段与写作时的原文一一对应。 */
export interface ParsedLink {
  /** 按原文书写的目标：笔记名或路径，如 `Redis` 或 `00-收集箱/AI/Redis` */
  target: string
  /** `|` 之后的显示别名，没有则为 null */
  alias: string | null
  /** `#小节` 锚点，没有则为 null */
  heading: string | null
  /** `^块引用` 锚点，没有则为 null */
  blockRef: string | null
  /** 是否为 `![[嵌入]]` 嵌入语法 */
  embed: boolean
  /** 在整篇文档中的 0 基行号 */
  line: number
  /** 供反链列表展示的摘要文本，由所在行净化而来 */
  context: string
}

/** 一个 `#标签` 的解析结果。 */
export interface ParsedTag {
  /** 已小写化的标签名（不含 `#`） */
  tag: string
  /** 在整篇文档中的 0 基行号 */
  line: number
}

/** 一次全文解析的产物：双链、标签、全部小节标题。 */
export interface ParseResult {
  links: ParsedLink[]
  tags: ParsedTag[]
  headings: string[]
}

/** 围栏代码块的开闭标记：0-3 个前导空格 + 至少 3 个 `` ` `` 或 `~`。 */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/
/** 行内代码 span：反引号开、同长反引号闭，屏蔽时按原长度补空格以保住列偏移。 */
const INLINE_CODE = /(`+)(?:[^`]|(?!\1)`)*?\1/g
/** 双链（含 `!` 前缀的嵌入）：括号内不允许再出现方括号，故不做嵌套匹配。 */
const WIKILINK = /(!?)\[\[([^\[\]]+?)\]\]/g
/** ATX 小节标题：0-3 个前导空格 + 1-6 个 `#` + 空格，尾部 `#` 闭合符一并吃掉。 */
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/
// Obsidian 标签规则：前面必须是行首或空白，不允许纯标点标签，
// `/` 允许用于层级嵌套，且至少含一个非数字，这样 `#2024` 不会被当成标签。
const TAG = /(^|\s)#([\p{L}\p{N}_/-]+)/gu

/** 返回 `line` 的副本，其中行内代码 span 已被等长空格替换（列偏移不变）。 */
function maskInlineCode(line: string): string {
  return line.replace(INLINE_CODE, (m) => ' '.repeat(m.length))
}

/**
 * 把链接目标拆成「路径 + 小节 + 块引用」三部分。
 * 先切 `#` 再切 `^`，并容忍 `^` 出现在小节名内部（`Note#标题^blk`）；
 * 空锚点（`Note#`）归一成 null。
 */
function splitHeadingAndBlock(target: string): {
  target: string
  heading: string | null
  blockRef: string | null
} {
  let rest = target
  let heading: string | null = null
  let blockRef: string | null = null

  const hashAt = rest.indexOf('#')
  if (hashAt !== -1) {
    heading = rest.slice(hashAt + 1).trim() || null
    rest = rest.slice(0, hashAt)
  }
  const caretAt = rest.indexOf('^')
  if (caretAt !== -1) {
    blockRef = rest.slice(caretAt + 1).trim() || null
    rest = rest.slice(0, caretAt)
  }
  if (heading) {
    const caretInHeading = heading.indexOf('^')
    if (caretInHeading !== -1) {
      blockRef = heading.slice(caretInHeading + 1).trim() || null
      heading = heading.slice(0, caretInHeading).trim() || null
    }
  }
  return { target: rest.trim(), heading, blockRef }
}

/** 解析整篇笔记：抽出全部双链、标签与小节标题；正文之外的区域一律跳过。 */
export function parseNote(markdown: string): ParseResult {
  const links: ParsedLink[] = []
  const tags: ParsedTag[] = []
  const headings: string[] = []

  forEachProseLine(markdown, (i, raw, line) => {
    const headingMatch = line.match(HEADING)
    if (headingMatch) headings.push(headingMatch[2].trim())

    for (const m of line.matchAll(WIKILINK)) {
      const inner = m[2]
      const pipeAt = inner.indexOf('|')
      const targetPart = pipeAt === -1 ? inner : inner.slice(0, pipeAt)
      const alias = pipeAt === -1 ? null : inner.slice(pipeAt + 1).trim() || null
      const { target, heading, blockRef } = splitHeadingAndBlock(targetPart)
      if (target === '' && heading === null && blockRef === null) continue
      links.push({
        target,
        alias,
        heading,
        blockRef,
        embed: m[1] === '!',
        line: i,
        context: buildContext(raw),
      })
    }

    for (const m of line.matchAll(TAG)) {
      const tag = m[2]
      if (tag === '' || !/[^\d]/.test(tag)) continue
      // `[[Note#heading]]` 和 `#^block` 不是标签，那部分归双链解析管，这里跳过。
      const at = (m.index ?? 0) + m[1].length
      if (isInsideWikilink(line, at)) continue
      tags.push({ tag: tag.toLowerCase(), line: i })
    }
  })

  return { links, tags, headings }
}

/**
 * 逐行遍历真正的正文，跳过 YAML frontmatter、围栏代码块和行内代码 span。
 * `maskedLine` 与原始行长、列偏移完全一致（代码部分被等长空格遮蔽），
 * 因此匹配到的下标可直接用于对原始行的原样改写。
 */
export function forEachProseLine(
  markdown: string,
  visit: (lineIndex: number, rawLine: string, maskedLine: string) => void,
): void {
  const lines = markdown.split('\n')
  let fenceMarker: string | null = null
  let inFrontmatter = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]

    // 开头的 `---` 若没有闭合符，它是分隔线而非元数据：文件其余部分全是正文，
    // 在这里吞掉它会让整篇笔记的链接和标签都消失。
    if (i === 0 && frontmatterEnd(lines) !== -1) {
      inFrontmatter = true
      continue
    }
    if (inFrontmatter) {
      if (FRONTMATTER_DELIM.test(raw)) inFrontmatter = false
      continue
    }

    const fence = raw.match(FENCE)
    if (fence) {
      const marker = fence[1][0].repeat(3)
      if (fenceMarker === null) {
        fenceMarker = marker
      } else if (marker === fenceMarker && raw.trim().length === fenceMarker.length) {
        fenceMarker = null
      }
      continue
    }
    if (fenceMarker !== null) continue

    visit(i, raw, maskInlineCode(raw))
  }
}

/** 屏蔽行上一条双链的精确区间，用于只替换目标片段、其余字节不动。 */
export interface WikilinkSpan {
  /** 开闭 `[[`（或 `![[`）的起始偏移 */
  matchStart: number
  /** 目标文本起始偏移，恰在括号内侧 */
  targetStart: number
  /** 目标文本结束偏移的下一格，即停在 `#`、`^`、`|` 或 `]]` 处 */
  targetEnd: number
  /** 按原文书写、已 trim 的目标文本 */
  target: string
  /** 是否为 `![[...]]` 嵌入 */
  embed: boolean
}

/**
 * 给已屏蔽行上的每条双链算出目标片段的精确偏移。屏蔽只是把代码换成等长空格，
 * 不改变长度，所以这些偏移对原始行同样有效。
 */
export function wikilinkSpans(maskedLine: string): WikilinkSpan[] {
  const spans: WikilinkSpan[] = []
  for (const m of maskedLine.matchAll(WIKILINK)) {
    const matchStart = m.index ?? 0
    const inner = m[2]
    const innerStart = matchStart + m[1].length + 2
    const pipeAt = inner.indexOf('|')
    const targetPart = pipeAt === -1 ? inner : inner.slice(0, pipeAt)
    const cut = earliestIndex(targetPart, '#', '^')
    spans.push({
      matchStart,
      targetStart: innerStart,
      targetEnd: innerStart + cut,
      target: targetPart.slice(0, cut).trim(),
      embed: m[1] === '!',
    })
  }
  return spans
}

/** 返回 `chars` 中任一字符在 `s` 里最早出现的下标；一个都没出现则返回 `s.length`。 */
function earliestIndex(s: string, ...chars: string[]): number {
  let best = s.length
  for (const c of chars) {
    const i = s.indexOf(c)
    if (i !== -1 && i < best) best = i
  }
  return best
}

/** 判断偏移 `tagOffset` 处的 `#` 是否落在某条双链内部（那是锚点，不是标签）。 */
function isInsideWikilink(line: string, tagOffset: number): boolean {
  for (const m of line.matchAll(WIKILINK)) {
    const start = m.index ?? 0
    if (tagOffset > start && tagOffset < start + m[0].length) return true
  }
  return false
}

/** 把所在行净化成反链摘要：剥掉标题/列表/引用前缀与格式符，双链只留读者看到的别名。 */
function buildContext(line: string): string {
  const text = line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*>\s?/, '')
    // 每条双链折叠成读者实际看到的文本：有别名取别名。
    .replace(/!?\[\[([^|\]]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, '$1')
    .replace(/!?\[\[|\]\]/g, '')
    .replace(/[*_`~]/g, '')
    .trim()
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}
