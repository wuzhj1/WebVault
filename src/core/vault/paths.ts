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

/** `notes/Redis 面试.md` -> `Redis 面试` */
export function titleOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return isNotePath(base) ? base.slice(0, -MD_EXT.length) : base
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
