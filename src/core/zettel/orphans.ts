/**
 * Orphan detection: a card nothing points at and that points at nothing.
 *
 * In a Zettelkasten an unlinked card might as well not exist, so this is the one list worth
 * surfacing. The degree table is built from a single pass over every link row — the sidebar, the
 * graph and the right panel all read the same table, which is what keeps them from disagreeing
 * about whether a card is alone.
 *
 * Relative imports only: `scripts/verify-zettel.mts` runs this under plain node with no alias
 * resolver. No runtime import of `../db.ts` either; the edge shape below is structural so a
 * `LinkRow` is assignable to it without this module knowing Dexie exists.
 */

export interface LinkEdge {
  src: string
  /** Null when the target resolves to nothing, i.e. a `[[待建链接]]`. */
  targetPath: string | null
}

export interface Degrees {
  /** Resolved, deduped, self-links excluded: exactly what the graph draws. */
  in: Map<string, number>
  out: Map<string, number>
  /**
   * Rows leaving a note whose target resolved to nothing. For an orphan this is the only
   * interesting number left: it separates "wrote no links" from "wrote links that are still
   * waiting for their notes to exist". A self-link is not one of those, so it does not count.
   */
  unresolved: Map<string, number>
}

/**
 * Deduping by unordered pair is what makes `=== 0` mean "no neighbours" rather than "no link rows":
 * `[[a]]` written twice on one page is one connection, and a note linking only itself is still
 * alone. Both rules match `GraphView.vue`, so the hollow dots and the sidebar list agree.
 */
export function buildDegrees(rows: readonly LinkEdge[]): Degrees {
  const inDeg = new Map<string, number>()
  const outDeg = new Map<string, number>()
  const unresolved = new Map<string, number>()
  const seen = new Set<string>()

  for (const r of rows) {
    if (r.targetPath === null) {
      unresolved.set(r.src, (unresolved.get(r.src) ?? 0) + 1)
      continue
    }
    // `a -> a` is not a connection: a card that links only itself is still alone.
    if (r.src === r.targetPath) continue

    const key = r.src < r.targetPath ? `${r.src}\u0000${r.targetPath}` : `${r.targetPath}\u0000${r.src}`
    if (seen.has(key)) continue
    seen.add(key)

    outDeg.set(r.src, (outDeg.get(r.src) ?? 0) + 1)
    inDeg.set(r.targetPath, (inDeg.get(r.targetPath) ?? 0) + 1)
  }

  return { in: inDeg, out: outDeg, unresolved }
}

export function isOrphan(path: string, degrees: Degrees): boolean {
  return (degrees.in.get(path) ?? 0) === 0 && (degrees.out.get(path) ?? 0) === 0
}

/**
 * Live paths that nothing connects to, ordered by creation so the oldest neglected card is on top.
 * `created` comes from the caller because this module never touches the card index; paths with no
 * known creation date sort last, then by path for a deterministic order.
 */
export function findOrphans(
  live: readonly string[],
  degrees: Degrees,
  createdOf: (path: string) => number,
): string[] {
  return live
    .filter((p) => isOrphan(p, degrees))
    .sort((a, b) => {
      const ca = createdOf(a)
      const cb = createdOf(b)
      if (ca !== cb) {
        if (ca === 0) return 1
        if (cb === 0) return -1
        return ca - cb
      }
      return a.localeCompare(b, 'zh-Hans-CN', { numeric: true })
    })
}
