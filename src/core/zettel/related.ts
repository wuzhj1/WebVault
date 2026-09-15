/**
 * "This card probably belongs next to that one."
 *
 * Four signals, all cheap and all derived from indexes the vault already keeps:
 * - **co-citation** — another card points at something I point at;
 * - **trail** — a card I point at points onward to a third card;
 * - **shared tags** — by Jaccard, so a card wearing twenty tags does not match everything;
 * - **text** — a MiniSearch ranking of my own body, used only when the index is already warm.
 * Plus a flat bonus for a card that cites me when I do not cite it back, which is exactly the
 * asymmetry a Zettelkasten most wants surfaced.
 *
 * Both link signals are damped by how promiscuous the connecting card is: co-citation through a
 * target that half the vault points at is a coincidence, and a trail through a card that links
 * everything is not a recommendation. (The plan wrote these two dampings the other way round; its
 * own rationale — "an index page everybody links to must not dominate" — is about in-degree, so
 * that is what this implements.)
 *
 * Relative imports only, and no Dexie, Vue or MiniSearch: `scripts/verify-zettel.mts` runs this
 * under plain node, and keeping it pure is what makes the ranking assertable at all.
 */
import type { LinkEdge } from './orphans.ts'

export const RELATED_WEIGHTS = {
  cocite: 3,
  neighbour: 2,
  tag: 1.5,
  text: 1,
  inbound: 1,
} as const

/**
 * A tag worn by at least this many cards and by more than `HUB_TAG_RATIO` of the vault carries no
 * signal. The absolute floor is what keeps a five-note library from classifying every tag as a hub.
 */
const HUB_TAG_MIN = 6
const HUB_TAG_RATIO = 0.15
const DEFAULT_LIMIT = 12

export interface RelatedHit {
  path: string
  score: number
  /** Short labels the UI joins into one line of explanation, e.g. `共引 3 · 同标签 1`. */
  reasons: string[]
}

export interface RelatedInput {
  path: string
  live: readonly string[]
  edges: readonly LinkEdge[]
  tagsOf: (path: string) => readonly string[]
  /** Raw MiniSearch scores; only their ratio to the best one is used. Omit when the index is cold. */
  text?: ReadonlyMap<string, number>
  limit?: number
}

const EMPTY: ReadonlySet<string> = new Set<string>()

export function rankRelated(input: RelatedInput): RelatedHit[] {
  const live = new Set(input.live)
  const path = input.path
  if (!live.has(path)) return []

  const out = new Map<string, Set<string>>()
  const inn = new Map<string, Set<string>>()
  for (const e of input.edges) {
    // Same three rules the graph and the orphan list use, so no two views ever disagree.
    if (e.targetPath === null || e.src === e.targetPath) continue
    if (!live.has(e.src) || !live.has(e.targetPath)) continue
    link(out, e.src, e.targetPath)
    link(inn, e.targetPath, e.src)
  }

  const mine = out.get(path) ?? EMPTY
  const citedBy = inn.get(path) ?? EMPTY
  const W = RELATED_WEIGHTS
  const scores = new Map<string, number>()
  const cocite = new Map<string, Set<string>>()
  const trail = new Map<string, Set<string>>()
  const sharedTags = new Map<string, Set<string>>()
  const textHit = new Set<string>()

  const addScore = (c: string, delta: number): void => {
    scores.set(c, (scores.get(c) ?? 0) + delta)
  }

  for (const target of mine) {
    const others = inn.get(target)
    if (!others) continue
    const damp = 1 / Math.log2(1 + sizeOf(inn, target))
    for (const c of others) {
      if (c === path) continue
      link(cocite, c, target)
      addScore(c, W.cocite * damp)
    }
  }

  for (const via of mine) {
    const onward = out.get(via)
    if (!onward) continue
    const damp = 1 / Math.log2(1 + sizeOf(out, via))
    for (const c of onward) {
      if (c === path) continue
      link(trail, c, via)
      addScore(c, W.neighbour * damp)
    }
  }

  const tags = new Map<string, readonly string[]>()
  const holders = new Map<string, number>()
  for (const p of live) {
    const own = input.tagsOf(p)
    tags.set(p, own)
    for (const t of own) holders.set(t, (holders.get(t) ?? 0) + 1)
  }
  const informative = (t: string): boolean => {
    const n = holders.get(t) ?? 0
    return !(n >= HUB_TAG_MIN && n > HUB_TAG_RATIO * live.size)
  }

  const myTags = new Set((tags.get(path) ?? []).filter(informative))
  if (myTags.size > 0) {
    for (const [c, own] of tags) {
      if (c === path) continue
      const shared = own.filter((t) => myTags.has(t))
      if (shared.length === 0) continue
      // Hub tags stay out of the denominator too: a coincidence is not similarity.
      const union = new Set([...myTags, ...own.filter(informative)]).size
      link(sharedTags, c, ...shared)
      addScore(c, W.tag * (shared.length / union))
    }
  }

  if (input.text && input.text.size > 0) {
    let best = 0
    for (const v of input.text.values()) if (v > best) best = v
    if (best > 0) {
      for (const [c, v] of input.text) {
        if (c === path || !live.has(c) || v <= 0) continue
        addScore(c, W.text * (v / best))
        textHit.add(c)
      }
    }
  }

  for (const c of citedBy) addScore(c, W.inbound)

  const hits: RelatedHit[] = []
  for (const [c, score] of scores) {
    // Direct neighbours are already listed under 出链; repeating them here is just noise.
    if (c === path || mine.has(c) || !live.has(c)) continue
    const reasons: string[] = []
    const co = cocite.get(c)
    if (co && co.size > 0) reasons.push(`共引 ${co.size}`)
    const via = trail.get(c)
    if (via && via.size > 0) reasons.push(`同源 ${via.size}`)
    const shared = sharedTags.get(c)
    if (shared && shared.size > 0) reasons.push(`同标签 ${shared.size}`)
    if (textHit.has(c)) reasons.push('文本相似')
    if (citedBy.has(c)) reasons.push('引用了我')
    hits.push({ path: c, score, reasons })
  }

  hits.sort(
    (a, b) => b.score - a.score || a.path.localeCompare(b.path, 'zh-Hans-CN', { numeric: true }),
  )
  return hits.slice(0, input.limit ?? DEFAULT_LIMIT)
}

function link(map: Map<string, Set<string>>, key: string, ...values: string[]): void {
  const bucket = map.get(key)
  if (bucket) {
    for (const v of values) bucket.add(v)
  } else {
    map.set(key, new Set(values))
  }
}

function sizeOf(map: Map<string, Set<string>>, key: string): number {
  return map.get(key)?.size ?? 0
}
