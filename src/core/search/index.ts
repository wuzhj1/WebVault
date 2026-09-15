import MiniSearch, { type SearchResult } from 'minisearch'
import { db } from '@/core/db.ts'
import * as opfs from '@/core/vault/opfs.ts'
import { titleOf } from '@/core/vault/paths.ts'
import { buildExcerpt, tokenize } from './text.ts'

export { buildExcerpt, tokenize } from './text.ts'

export interface SearchHit {
  path: string
  title: string
  score: number
  excerpt: string
  matchedTitle: boolean
}

interface Doc {
  id: string
  title: string
  body: string
  tags: string
}

let index: MiniSearch<Doc> | null = null
let indexedRevision = -1

function createIndex(): MiniSearch<Doc> {
  return new MiniSearch<Doc>({
    fields: ['title', 'body', 'tags'],
    storeFields: ['title'],
    tokenize,
    searchOptions: {
      tokenize,
      boost: { title: 5, tags: 3 },
      // Prefix matching helps partial latin input; for CJK unigram/bigram tokens it only
      // adds noise, so those stay exact.
      prefix: (term) => term.length >= 2 && /^[a-z0-9_$]/.test(term),
      fuzzy: false,
    },
  })
}

/**
 * Rebuild when the vault changed. `revision` lets callers pass a cheap monotonically
 * increasing value instead of diffing every note's content.
 */
export async function ensureIndex(revision: number): Promise<MiniSearch<Doc>> {
  if (index && revision === indexedRevision) return index

  const fresh = createIndex()
  const notes = await db.notes.toArray()
  const docs: Doc[] = []
  for (const n of notes) {
    if (n.removedLocal || !n.cached) continue
    const body = (await opfs.readNote(n.path)) ?? ''
    const tags = (await db.tags.where('path').equals(n.path).toArray()).map((t) => t.tag)
    docs.push({ id: n.path, title: n.title, body, tags: tags.join(' ') })
  }
  fresh.addAll(docs)
  index = fresh
  indexedRevision = revision
  return fresh
}

export function invalidateIndex(): void {
  indexedRevision = -1
}

export async function search(query: string, revision: number, limit = 40): Promise<SearchHit[]> {
  const q = query.trim()
  if (q === '') return []
  const idx = await ensureIndex(revision)
  const results: SearchResult[] = idx.search(q)

  const hits: SearchHit[] = []
  for (const r of results.slice(0, limit)) {
    const path = String(r.id)
    const title = (r.title as string | undefined) ?? titleOf(path)
    const body = (await opfs.readNote(path)) ?? ''
    hits.push({
      path,
      title,
      score: r.score,
      excerpt: buildExcerpt(body, q),
      matchedTitle: title.toLowerCase().includes(q.toLowerCase()),
    })
  }
  return hits
}
