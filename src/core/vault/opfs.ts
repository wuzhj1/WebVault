/**
 * OPFS-backed note storage. This is the single source of truth for note bodies;
 * Gitee is only a sync target. Everything here is offline-capable.
 */
import { ancestorDirs, normalizePath } from './paths.ts'

let rootPromise: Promise<FileSystemDirectoryHandle> | null = null

export function isOpfsSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory
}

function getRoot(): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsSupported()) {
    return Promise.reject(
      new Error('当前浏览器不支持 OPFS(源私有文件系统)。请使用 Chrome / Edge / Safari 15.2+ 并通过 HTTPS 或 localhost 访问。'),
    )
  }
  rootPromise ??= navigator.storage.getDirectory()
  return rootPromise
}

async function resolveDir(dirPath: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  let handle = await getRoot()
  if (dirPath === '') return handle
  for (const segment of dirPath.split('/')) {
    handle = await handle.getDirectoryHandle(segment, { create })
  }
  return handle
}

async function getFileHandle(
  path: string,
  create: boolean,
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const p = normalizePath(path)
  const slash = p.lastIndexOf('/')
  const dir = await resolveDir(slash === -1 ? '' : p.slice(0, slash), create)
  return { dir, name: slash === -1 ? p : p.slice(slash + 1) }
}

export async function readNote(path: string): Promise<string | null> {
  const { dir, name } = await getFileHandle(path, false)
  try {
    const file = await dir.getFileHandle(name)
    return await (await file.getFile()).text()
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

export async function writeNote(path: string, content: string): Promise<void> {
  const { dir, name } = await getFileHandle(path, true)
  const file = await dir.getFileHandle(name, { create: true })
  const writable = await file.createWritable()
  await writable.write(content)
  await writable.close()
}

export async function deleteNote(path: string): Promise<void> {
  const { dir, name } = await getFileHandle(path, false)
  try {
    await dir.removeEntry(name)
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
}

/** OPFS has no move; copy-then-delete keeps the caller's semantics. */
export async function moveNote(from: string, to: string): Promise<void> {
  const content = await readNote(from)
  if (content === null) throw new Error(`源文件不存在: ${from}`)
  await writeNote(to, content)
  await deleteNote(from)
}

export async function existsNote(path: string): Promise<boolean> {
  const { dir, name } = await getFileHandle(path, false)
  try {
    await dir.getFileHandle(name)
    return true
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

/** Every `.md` file in the vault, as normalized relative paths. */
export async function listNotePaths(): Promise<string[]> {
  const root = await getRoot()
  const found: string[] = []
  await walk(root, '', found)
  return found.sort()
}

async function walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: string[],
): Promise<void> {
  for await (const entry of dir.values()) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.kind === 'directory') {
      const child = await dir.getDirectoryHandle(entry.name)
      await walk(child, path, out)
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      out.push(path)
    }
  }
}

/** Drop every note from OPFS. Used by the "storage was wiped, re-pull from remote" recovery. */
export async function clearAllNotes(): Promise<void> {
  const root = await getRoot()
  for await (const entry of root.values()) {
    await root.removeEntry(entry.name, { recursive: true })
  }
}

export async function ensureDirsFor(paths: Iterable<string>): Promise<void> {
  const needed = new Set<string>()
  for (const p of paths) {
    for (const d of ancestorDirs(normalizePath(p))) needed.add(d)
  }
  for (const d of [...needed].sort((a, b) => a.length - b.length)) {
    await resolveDir(d, true)
  }
}

export async function persistedStorageGranted(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted?.()) return true
  return navigator.storage.persist()
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'NoModificationAllowedError')
}
