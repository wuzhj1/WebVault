/**
 * Pure text helpers for search.
 *
 * MiniSearch's default tokenizer splits on whitespace, which leaves a Chinese sentence
 * as one giant token and makes CJK search useless. Notes are tokenized here into latin
 * words plus CJK unigrams and bigrams — bigrams give phrase-like recall without needing
 * a dictionary-based segmenter.
 */

const LATIN_WORD = /[A-Za-z0-9_$][A-Za-z0-9_$-]*/g
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g

export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const m of text.matchAll(LATIN_WORD)) tokens.push(m[0].toLowerCase())
  for (const m of text.matchAll(CJK_RUN)) {
    const run = m[0]
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i])
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2))
    }
  }
  return tokens
}

/** Snippet centred on the first query hit, with markdown noise stripped. */
export function buildExcerpt(body: string, query: string): string {
  const plain = body
    .replace(/^---[\s\S]*?^---\s*/m, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, '$1')
    .replace(/[#>*_`~[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)

  let at = -1
  for (const term of terms) {
    const found = plain.toLowerCase().indexOf(term.toLowerCase())
    if (found !== -1) {
      at = found
      break
    }
  }
  if (at === -1) return plain.slice(0, 120)

  const start = Math.max(0, at - 40)
  const end = Math.min(plain.length, at + 100)
  return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`
}
