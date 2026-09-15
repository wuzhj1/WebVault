/**
 * Wikilink / tag / heading extraction.
 *
 * Deliberately not a bare regex over the whole file: fenced code blocks, inline code
 * spans and YAML frontmatter are masked out first, otherwise a README showing
 * `[[example]]` syntax would register as a real backlink.
 */

import { FRONTMATTER_DELIM, frontmatterEnd } from './frontmatter.ts'

export interface ParsedLink {
  /** note name or path as written, e.g. `Redis` or `00-收集箱/AI/Redis` */
  target: string
  alias: string | null
  heading: string | null
  blockRef: string | null
  embed: boolean
  line: number
  context: string
}

export interface ParsedTag {
  tag: string
  line: number
}

export interface ParseResult {
  links: ParsedLink[]
  tags: ParsedTag[]
  headings: string[]
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const INLINE_CODE = /(`+)(?:[^`]|(?!\1)`)*?\1/g
const WIKILINK = /(!?)\[\[([^\[\]]+?)\]\]/g
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/
// Obsidian tag rules: preceded by start-of-line or whitespace, no punctuation-only tags,
// `/` allowed for nesting, and at least one non-digit so `#2024` is not a tag.
const TAG = /(^|\s)#([\p{L}\p{N}_/-]+)/gu

/** Returns a copy of `line` with inline code spans blanked out. */
function maskInlineCode(line: string): string {
  return line.replace(INLINE_CODE, (m) => ' '.repeat(m.length))
}

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
      // `[[Note#heading]]` and `#^block` are not tags; the wikilink pass owns those.
      const at = (m.index ?? 0) + m[1].length
      if (isInsideWikilink(line, at)) continue
      tags.push({ tag: tag.toLowerCase(), line: i })
    }
  })

  return { links, tags, headings }
}

/**
 * Visits every line of real prose, skipping YAML frontmatter, fenced code blocks and
 * inline code spans. `maskedLine` has the same length and column offsets as the raw
 * line, with code spans blanked, so match indices can be reused for surgical edits.
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

    // An unterminated leading `---` is a thematic break, not metadata: the rest of the file is
    // prose, and swallowing it here would hide every link and tag in the note.
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

export interface WikilinkSpan {
  /** offset of the `[[` (or `![[`) that opens this link */
  matchStart: number
  /** offset where the target text begins, just inside the brackets */
  targetStart: number
  /** offset one past the target text, i.e. at `#`, `^`, `|` or `]]` */
  targetEnd: number
  /** trimmed target text as written */
  target: string
  embed: boolean
}

/**
 * Exact target offsets for every wikilink on an already-masked line. Offsets are valid
 * against the raw line too, because masking preserves length.
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

function earliestIndex(s: string, ...chars: string[]): number {
  let best = s.length
  for (const c of chars) {
    const i = s.indexOf(c)
    if (i !== -1 && i < best) best = i
  }
  return best
}

function isInsideWikilink(line: string, tagOffset: number): boolean {
  for (const m of line.matchAll(WIKILINK)) {
    const start = m.index ?? 0
    if (tagOffset > start && tagOffset < start + m[0].length) return true
  }
  return false
}

function buildContext(line: string): string {
  const text = line
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*>\s?/, '')
    // Collapse each link to what the reader sees: the alias when there is one.
    .replace(/!?\[\[([^|\]]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/!?\[\[([^\]]*)\]\]/g, '$1')
    .replace(/!?\[\[|\]\]/g, '')
    .replace(/[*_`~]/g, '')
    .trim()
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}
