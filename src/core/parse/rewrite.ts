/**
 * Surgical wikilink rewriting for renames and moves.
 *
 * Only the target span inside `[[...]]` is replaced — aliases, headings, block refs,
 * surrounding whitespace and every other byte of the file are preserved exactly. This
 * matters because a rename that reformats the note would show up as a spurious diff on
 * the next sync.
 */
import { forEachProseLine, wikilinkSpans } from './links.ts'

export interface RewriteRule {
  shouldRewrite(target: string): boolean
  replacement(target: string): string
}

export interface RewriteResult {
  text: string
  changed: number
}

export function rewriteWikilinks(markdown: string, rule: RewriteRule): RewriteResult {
  const lines = markdown.split('\n')
  let changed = 0

  forEachProseLine(markdown, (i, _raw, masked) => {
    const edits: { start: number; end: number; text: string }[] = []

    for (const span of wikilinkSpans(masked)) {
      if (span.target === '' || !rule.shouldRewrite(span.target)) continue
      const next = rule.replacement(span.target)
      const current = lines[i].slice(span.targetStart, span.targetEnd)
      if (next === current.trim() && current === next) continue
      edits.push({ start: span.targetStart, end: span.targetEnd, text: next })
    }

    if (edits.length === 0) return
    // Right to left so earlier offsets stay valid.
    edits.sort((a, b) => b.start - a.start)
    let line = lines[i]
    for (const e of edits) {
      line = line.slice(0, e.start) + e.text + line.slice(e.end)
      changed++
    }
    lines[i] = line
  })

  return { text: lines.join('\n'), changed }
}
