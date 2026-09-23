/**
 * OPFS（Origin Private File System）笔记存储层：这里是笔记正文唯一的真相来源，Gitee 只是同步目标，
 * 因此所有读写都必须离线可用、不依赖网络。
 *
 * 硬约束：只能在浏览器安全上下文里跑（HTTPS 或 localhost）；只用相对导入，无 `@/` 别名。
 * 每个入口都会先 `normalizePath`，把目录遍历防护收在这一层 —— 上层任何调用方忘了校验也不会逃出 vault。
 * 非写入口（读 / 删 / 探测）一律 `create: false`：一次读绝不允许在树上凭空造出目录或文件。
 */
import { ancestorDirs, normalizePath } from './paths.ts'

/** 根目录 handle 只解析一次：`getDirectory()` 每次返回新对象，复用可省掉重复的权限检查。 */
let rootPromise: Promise<FileSystemDirectoryHandle> | null = null

/** 特性检测，不是缓存判断 —— 非安全上下文下 `navigator.storage` 存在但 `getDirectory` 缺失。 */
export function isOpfsSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory
}

/** 取 vault 根 handle；不支持 OPFS 时以可读的中文错误 reject，好让上层直接展示给用户。 */
function getRoot(): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsSupported()) {
    return Promise.reject(
      new Error('当前浏览器不支持 OPFS(源私有文件系统)。请使用 Chrome / Edge / Safari 15.2+ 并通过 HTTPS 或 localhost 访问。'),
    )
  }
  rootPromise ??= navigator.storage.getDirectory()
  return rootPromise
}

/** 逐段解析目录。`create` 为 false 时缺任何一段就抛 NotFoundError，读路径靠这个区分「不存在」与出错。 */
async function resolveDir(dirPath: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  let handle = await getRoot()
  // 空串表示 vault 根，直接返回根 handle，不进循环。
  if (dirPath === '') return handle
  for (const segment of dirPath.split('/')) {
    handle = await handle.getDirectoryHandle(segment, { create })
  }
  return handle
}

/**
 * 拆成「父目录 handle + 文件名」。写 / 建传 `create: true` 会顺带补出缺失的中间目录；
 * 读、删、探测一律传 `false` —— 严格只读纪律：探测一个不存在的路径不得留下空目录。
 */
async function getFileHandle(
  path: string,
  create: boolean,
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const p = normalizePath(path)
  const slash = p.lastIndexOf('/')
  const dir = await resolveDir(slash === -1 ? '' : p.slice(0, slash), create)
  return { dir, name: slash === -1 ? p : p.slice(slash + 1) }
}

/** 读正文；文件不存在返回 null（正常情况，如尚未下载的索引 stub），其他错误照抛。 */
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

/** 整文件覆盖写（OPFS 的 writable 默认从头截断），不做追加也不做合并。 */
export async function writeNote(path: string, content: string): Promise<void> {
  const { dir, name } = await getFileHandle(path, true)
  const file = await dir.getFileHandle(name, { create: true })
  const writable = await file.createWritable()
  await writable.write(content)
  // 必须 close()：数据在 close 之前只在 write stream 里，中途关页面就会留下半截文件。
  await writable.close()
}

/** 删文件；不存在视为已达成目标而静默吞掉，让调用方不必自己先 exists。 */
export async function deleteNote(path: string): Promise<void> {
  const { dir, name } = await getFileHandle(path, false)
  try {
    await dir.removeEntry(name)
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
}

/**
 * OPFS 没有 move API；copy-then-delete 保持调用方期望的语义。
 * 两步之间崩溃会留下两份副本 —— 上层以「路径即身份」的元数据索引吸收这种不一致。
 * 注：目前 `renameNote` 自行做了同样的读写删，本函数尚无调用方。
 */
export async function moveNote(from: string, to: string): Promise<void> {
  const content = await readNote(from)
  if (content === null) throw new Error(`源文件不存在: ${from}`)
  await writeNote(to, content)
  await deleteNote(from)
}

/** 只做存在性判断，不取内容 —— 用于挑候选冲突文件名，避免整篇读进内存。 */
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

/** vault 内全部 `.md` 文件，返回规范化相对路径。用于启动时对账，不读内容。 */
export async function listNotePaths(): Promise<string[]> {
  const root = await getRoot()
  const found: string[] = []
  await walk(root, '', found)
  return found.sort()
}

/** 深度优先遍历。`prefix` 累加相对路径；扩展名判定大小写不敏感，与 `isNotePath` 一致。 */
async function walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: string[],
): Promise<void> {
  for await (const entry of dir.values()) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.kind === 'directory') {
      // 重新按名字取一次句柄而不是用 `entry`：`values()` 的元素类型是基类 `FileSystemHandle`。
      const child = await dir.getDirectoryHandle(entry.name)
      await walk(child, path, out)
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      out.push(path)
    }
  }
}

/** 清空整个 OPFS（连目录一起）。仅用于「存储被清空、需从远端重拉」的恢复流程，不可撤销。 */
export async function clearAllNotes(): Promise<void> {
  const root = await getRoot()
  for await (const entry of root.values()) {
    await root.removeEntry(entry.name, { recursive: true })
  }
}

/** 批量预建目录：先把所有路径的祖先去重，再按长度升序创建，保证父先于子。 */
export async function ensureDirsFor(paths: Iterable<string>): Promise<void> {
  const needed = new Set<string>()
  for (const p of paths) {
    for (const d of ancestorDirs(normalizePath(p))) needed.add(d)
  }
  for (const d of [...needed].sort((a, b) => a.length - b.length)) {
    await resolveDir(d, true)
  }
}

/**
 * 申请持久化存储：不给这个标志，浏览器在磁盘吃紧时可以连同 IndexedDB 一起清掉整个 OPFS。
 * 已授权时直接返回 true，避免重复弹权限请求。
 */
export async function persistedStorageGranted(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted?.()) return true
  return navigator.storage.persist()
}

/**
 * 「找不到」的两种形态：`NotFoundError` 是常规缺失，`NoModificationAllowedError` 出现在 Safari ——
 * 对一个刚被删掉的句柄继续操作时它抛这个而非前者。
 */
function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'NoModificationAllowedError')
}
