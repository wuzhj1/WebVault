/**
 * Resolve a `[[target]]` to a concrete note path.
 *
 * Mirrors Obsidian's rules closely enough to stay compatible with an existing vault:
 * exact path, then case-insensitive path, then basename — and when a basename is
 * ambiguous the shortest path wins. A zettel id is tried last of all, so a note really
 * named `202609151423.md` still wins on its own path.
 */
import type { NoteMeta } from '../db.ts'
import { normalizePath, titleOf } from '../vault/paths.ts'
import { isZid } from '../zettel/card.ts'

/** The two fields the id index needs; a `CardRow` satisfies it without this module knowing Dexie. */
export interface ZidHolder {
  path: string
  zid: string
}

export interface Resolver {
  paths: Set<string>
  byExactPath: Map<string, string>
  byLowerPath: Map<string, string>
  byLowerPathNoExt: Map<string, string>
  byBasename: Map<string, string[]>
  byZid: Map<string, string>
}

const NON_NOTE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico|pdf|mp[34]|wav|webm|ogg|zip|canvas|excalidraw)$/i

export function buildResolver(notes: NoteMeta[], cards?: readonly ZidHolder[]): Resolver {
  const r: Resolver = {
    paths: new Set(),
    byExactPath: new Map(),
    byLowerPath: new Map(),
    byLowerPathNoExt: new Map(),
    byBasename: new Map(),
    byZid: new Map(),
  }
  for (const n of notes) {
    // Tombstones are remote-deletion bookkeeping, not notes: indexing them would keep
    // links to deleted files "resolvable" and make basenames look ambiguous on rename.
    if (n.removedLocal) continue
    r.paths.add(n.path)
    r.byExactPath.set(n.path, n.path)
    r.byLowerPath.set(n.path.toLowerCase(), n.path)
    r.byLowerPathNoExt.set(stripMd(n.path).toLowerCase(), n.path)
    const base = titleOf(n.path).toLowerCase()
    const bucket = r.byBasename.get(base)
    if (bucket) bucket.push(n.path)
    else r.byBasename.set(base, [n.path])
  }
  for (const bucket of r.byBasename.values()) {
    bucket.sort((a, b) => a.length - b.length || a.localeCompare(b))
  }

  if (cards) {
    // Two files can carry the same id when two devices each create a card in the same minute and
    // the sync engine keeps both. There is no coordinator to ask which one the author meant, so
    // take the lowest path: arbitrary, but the same answer on every device and every rebuild.
    const claimed = new Map<string, string>()
    for (const c of cards) {
      if (c.zid === '' || !isZid(c.zid)) continue
      // Filtering on `paths` rather than trusting the caller means a tombstoned note's id can
      // never resolve, whichever order the two indexes happened to be refreshed in.
      if (!r.paths.has(c.path)) continue
      const held = claimed.get(c.zid)
      if (held === undefined || c.path < held) claimed.set(c.zid, c.path)
    }
    r.byZid = claimed
  }

  return r
}

export function isAttachmentTarget(target: string): boolean {
  return NON_NOTE_EXT.test(target.trim())
}

/** Returns the resolved note path, or null for an unresolved (dangling) link. */
export function resolveTarget(resolver: Resolver, rawTarget: string): string | null {
  const target = rawTarget.trim()
  if (target === '') return null
  if (isAttachmentTarget(target)) return null

  const cleaned = target.replace(/^\.\//, '')
  if (resolver.byExactPath.has(cleaned)) return cleaned

  const direct = resolver.byLowerPath.get(cleaned.toLowerCase())
  if (direct) return direct

  const noExt = resolver.byLowerPathNoExt.get(stripMd(cleaned).toLowerCase())
  if (noExt) return noExt

  const asPath = resolver.byLowerPathNoExt.get(stripMd(cleaned).toLowerCase().replace(/^\/+/, ''))
  if (asPath) return asPath

  const byBase = resolver.byBasename.get(titleOf(cleaned).toLowerCase())
  if (byBase && byBase.length > 0) return byBase[0]

  // Last, and only for a well-formed id: without the `isZid` gate a target of `2026` would be
  // free to match any id starting with those digits.
  if (isZid(cleaned)) {
    const byId = resolver.byZid.get(cleaned)
    if (byId) return byId
  }

  return null
}

/** The text a link should be written as after a rename: shortest unambiguous form. */
export function preferredLinkText(resolver: Resolver, path: string): string {
  const base = titleOf(path)
  const bucket = resolver.byBasename.get(base.toLowerCase())
  if (bucket && bucket.length === 1) return base
  return stripMd(path)
}

function stripMd(p: string): string {
  return p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p
}

/** Safe rename target: normalized, `.md` guaranteed, and must not already exist. */
export function validateNewPath(
  resolver: Resolver,
  candidate: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  let path: string
  try {
    path = normalizePath(candidate)
  } catch {
    return { ok: false, reason: '路径不合法(不能为空、不能包含 `..`)' }
  }
  if (!path.toLowerCase().endsWith('.md')) path += '.md'
  if (resolver.paths.has(path)) return { ok: false, reason: `已存在同名笔记: ${path}` }
  return { ok: true, path }
}
