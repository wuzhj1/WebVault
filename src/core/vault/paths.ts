/** Vault-relative path helpers. Every path in the app is normalized through here. */

const MD_EXT = '.md'

export class UnsafePathError extends Error {
  constructor(path: string) {
    super(`拒绝不安全的路径: ${path}`)
    this.name = 'UnsafePathError'
  }
}

/** Collapse `./`, `../`, duplicate and trailing slashes. Throws on escape attempts. */
export function normalizePath(raw: string): string {
  const cleaned = raw.trim().replace(/\\/g, '/').replace(/^\//, '')
  if (cleaned === '' || cleaned.includes('\0')) throw new UnsafePathError(raw)
  if (/^[a-zA-Z]:/.test(cleaned)) throw new UnsafePathError(raw)

  const out: string[] = []
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) throw new UnsafePathError(raw)
      out.pop()
      continue
    }
    out.push(segment)
  }
  if (out.length === 0) throw new UnsafePathError(raw)
  return out.join('/')
}

export function isNotePath(path: string): boolean {
  return path.toLowerCase().endsWith(MD_EXT)
}

export function ensureMdExt(name: string): string {
  const trimmed = name.trim()
  return isNotePath(trimmed) ? trimmed : trimmed + MD_EXT
}

/**
 * A zettel id prefix in a filename: twelve digits of local `YYYYMMDDHHmm`, an optional
 * letter suffix that breaks same-minute collisions, then a separator.
 *
 * The separator is required, which is why this is not the same pattern as `isZid`: a note named
 * exactly `202609151423.md` keeps that as its title instead of being stripped to nothing.
 */
export const ZID_PREFIX = /^\d{12}[a-z]{0,3}[ _-]+/

/**
 * `notes/sub/a.md` -> `a`, and `202609151423 卡片盒.md` -> `卡片盒`.
 *
 * Stripping the id here rather than at each call site is the whole point: `titleOf` feeds the top
 * bar, the file tree, backlinks, graph labels, sync progress, search documents and the link
 * picker, so one change keeps a timestamp out of all of them. It also makes `[[卡片盒]]` and
 * `[[202609151423 卡片盒]]` resolve to the same note, since the resolver buckets by this value.
 */
export function titleOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const stem = isNotePath(base) ? base.slice(0, -MD_EXT.length) : base
  const stripped = stem.replace(ZID_PREFIX, '')
  return stripped === '' ? stem : stripped
}

/** `notes/sub/a.md` -> `notes/sub`; `a.md` -> `` */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

export function joinPath(dir: string, name: string): string {
  const d = dir.trim()
  return d === '' || d === '/' ? name : `${d}/${name}`
}

/** All ancestor directories of a path, shallowest first. */
export function ancestorDirs(path: string): string[] {
  const dirs: string[] = []
  let d = dirOf(path)
  while (d !== '') {
    dirs.unshift(d)
    d = dirOf(d)
  }
  return dirs
}

/** Sort key that keeps folders before notes and orders naturally. */
export function comparePath(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true })
}
