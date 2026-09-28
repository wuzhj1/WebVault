/**
 * 笔记正文存储层，双后端：
 * - 内置 OPFS（Origin Private File System）：默认后端，浏览器私有、资源管理器不可见；
 * - 用户目录：设置里绑定的本地文件夹（File System Access API），文件实打实在磁盘上，可备份、
 *   可被外部编辑器修改；绑定句柄持久化在 IndexedDB 的 config 表，重启后按权限续期。
 *
 * 无论哪个后端，上层（vault / sync / search）只看见同一组 read/write/delete/list 函数 ——
 * 路径校验、遍历防护与「读不建树」的纪律收在本模块，换后端不外溢到调用方。
 * 绑定目录未授权时**任何**文件 IO 都必须失败而不是悄悄退回 OPFS：两个来源混读会让
 * 索引与文件各说各话，正确姿势是由调用方（授权屏）先续期或解除绑定。
 *
 * 硬约束：只能在浏览器安全上下文里跑（HTTPS 或 localhost）；只用相对导入，无 `@/` 别名。
 * 每个入口都会先 `normalizePath`，把目录遍历防护收在这一层 —— 上层任何调用方忘了校验也不会逃出 vault。
 * 非写入口（读 / 删 / 探测）一律 `create: false`：一次读绝不允许在树上凭空造出目录或文件。
 */
import { deleteConfig, getConfig, putConfig } from '../db.ts'
import { ancestorDirs, normalizePath } from './paths.ts'

/** 绑定目录句柄在 config 表里的键；值是结构化克隆后的 FileSystemDirectoryHandle。 */
const DIR_HANDLE_KEY = 'vault-dir-handle'

/** 存储后端：内置 OPFS / 用户目录（已授权）/ 用户目录（待授权，授权前禁用一切文件 IO）。 */
export type StorageBackend = 'opfs' | 'dir' | 'blocked'

/**
 * 权限方法与目录选择器在 TS lib.dom 里的声明随版本漂移，统一按 WICG 规范的最小形状本地窄化，
 * 经 `as unknown as` 转型（等 vue-tsc 报错再收紧也行，这里以「缺席即不可用」为安全分支）：
 * `queryPermission` 缺席或返回非 granted 一律按待授权处理，`showDirectoryPicker` 缺席直接报不支持。
 */
interface PermCapable {
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}

function permOf(handle: FileSystemDirectoryHandle): PermCapable {
  return handle as unknown as PermCapable
}

function pickerOn(
  target: unknown,
):
  | ((options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>)
  | undefined {
  return (
    target as {
      showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
    }
  ).showDirectoryPicker
}

/** OPFS 根 handle 只解析一次：`getDirectory()` 每次返回新对象，复用可省掉重复的权限检查。 */
let rootPromise: Promise<FileSystemDirectoryHandle> | null = null

/**
 * 后端状态；null = 尚未解析（第一次文件 IO 时才读 config，省掉启动初期无谓的 IDB 往返）。
 * 'dir' 的 granted 会随授权动作就地更新，不回头重读存储。
 */
type BackendState =
  | { kind: 'opfs' }
  | { kind: 'dir'; handle: FileSystemDirectoryHandle; granted: boolean }
let backendState: BackendState | null = null

/** 惰性解析后端：读一次 config 里的目录句柄，没有就是内置 OPFS。 */
async function resolveBackend(): Promise<BackendState> {
  if (backendState) return backendState
  const handle = await getConfig<FileSystemDirectoryHandle>(DIR_HANDLE_KEY)
  if (!handle) {
    backendState = { kind: 'opfs' }
  } else {
    const granted = (await permOf(handle).queryPermission?.({ mode: 'readwrite' })) === 'granted'
    backendState = { kind: 'dir', handle, granted }
  }
  return backendState
}

/** 特性检测，不是缓存判断 —— 非安全上下文下 `navigator.storage` 存在但 `getDirectory` 缺失。 */
export function isOpfsSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory
}

function opfsUnsupportedError(): Error {
  return new Error(
    '当前浏览器不支持 OPFS(源私有文件系统)。请使用 Chrome / Edge / Safari 15.2+ 并通过 HTTPS 或 localhost 访问。',
  )
}

/** 纯 OPFS 根，绕过后端状态 —— 迁移的源与回迁的落点都要求它不随后端切换。 */
async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (!isOpfsSupported()) throw opfsUnsupportedError()
  rootPromise ??= navigator.storage.getDirectory()
  return rootPromise
}

/**
 * 取当前后端的根 handle；目录未授权或浏览器不支持 OPFS 时以可读的中文错误 reject，
 * 好让上层直接展示给用户。
 */
async function getRoot(): Promise<FileSystemDirectoryHandle> {
  const state = await resolveBackend()
  if (state.kind === 'dir') {
    if (!state.granted) throw new Error('笔记目录的访问授权已过期,请重新授权后再试。')
    return state.handle
  }
  return opfsRoot()
}

/** 逐段解析目录。`create` 为 false 时缺任何一段就抛 NotFoundError，读路径靠这个区分「不存在」与出错。 */
async function resolveDir(
  root: FileSystemDirectoryHandle,
  dirPath: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let handle = root
  // 空串表示根，直接返回给定 handle，不进循环。
  if (dirPath === '') return handle
  for (const segment of dirPath.split('/')) {
    handle = await handle.getDirectoryHandle(segment, { create })
  }
  return handle
}

/**
 * 拆成「父目录 handle + 文件名」，根由调用方给定 —— 迁移 / 镜像要钉在固定根上操作，不随后端走。
 * 写 / 建传 `create: true` 会顺带补出缺失的中间目录；读、删、探测一律传 `false` ——
 * 严格只读纪律：探测一个不存在的路径不得留下空目录。
 */
async function getFileHandle(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
  const p = normalizePath(path)
  const slash = p.lastIndexOf('/')
  const dir = await resolveDir(root, slash === -1 ? '' : p.slice(0, slash), create)
  return { dir, name: slash === -1 ? p : p.slice(slash + 1) }
}

/** 在指定根下读正文；文件不存在返回 null（正常情况），其他错误照抛。 */
async function readAt(root: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  const { dir, name } = await getFileHandle(root, path, false)
  try {
    const file = await dir.getFileHandle(name)
    return await (await file.getFile()).text()
  } catch (err) {
    if (isNotFound(err)) return null
    throw err
  }
}

/** 在指定根下整文件覆盖写（writable 默认从头截断），不做追加也不做合并；顺带补建中间目录。 */
async function writeAt(root: FileSystemDirectoryHandle, path: string, content: string): Promise<void> {
  const { dir, name } = await getFileHandle(root, path, true)
  const file = await dir.getFileHandle(name, { create: true })
  const writable = await file.createWritable()
  await writable.write(content)
  // 必须 close()：数据在 close 之前只在 write stream 里，中途关页面就会留下半截文件。
  await writable.close()
}

/** 在指定根下删文件；不存在视为已达成目标而静默吞掉，让调用方不必自己先 exists。 */
async function deleteAt(root: FileSystemDirectoryHandle, path: string): Promise<void> {
  const { dir, name } = await getFileHandle(root, path, false)
  try {
    await dir.removeEntry(name)
  } catch (err) {
    if (!isNotFound(err)) throw err
  }
}

/** 指定根下的存在性判断；父目录缺失同样算「不存在」，不取内容 —— 避免整篇读进内存。 */
async function existsAt(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
  try {
    const { dir, name } = await getFileHandle(root, path, false)
    await dir.getFileHandle(name)
    return true
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

/** 读正文；文件不存在返回 null（正常情况，如尚未下载的索引 stub），其他错误照抛。 */
export async function readNote(path: string): Promise<string | null> {
  return readAt(await getRoot(), path)
}

/** 整文件覆盖写（当前后端的 writable 默认从头截断），不做追加也不做合并。 */
export async function writeNote(path: string, content: string): Promise<void> {
  await writeAt(await getRoot(), path, content)
}

/** 删文件；不存在视为已达成目标而静默吞掉，让调用方不必自己先 exists。 */
export async function deleteNote(path: string): Promise<void> {
  await deleteAt(await getRoot(), path)
}

/**
 * OPFS 与用户目录都没有 move API；copy-then-delete 保持调用方期望的语义。
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
  return existsAt(await getRoot(), path)
}

/** 当前后端（触发一次惰性解析）。设置页与启动流程据此分叉。 */
export async function currentBackend(): Promise<StorageBackend> {
  const state = await resolveBackend()
  if (state.kind === 'opfs') return 'opfs'
  return state.granted ? 'dir' : 'blocked'
}

/** 绑定的目录名；未绑定返回 null。授权屏与设置页展示用。 */
export async function dirName(): Promise<string | null> {
  const state = await resolveBackend()
  return state.kind === 'dir' ? state.handle.name : null
}

/** 目录选择器特性检测：`showDirectoryPicker` 只有 Chromium 系实现，Safari / Firefox 没有。 */
export function isDirPickerSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/**
 * 弹系统目录选择器（mode: readwrite，选定即授予本会话读写权）。
 * 用户取消时浏览器抛 AbortError —— 调用方按「无操作」处理，不当作错误展示。
 */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = pickerOn(window)
  if (!picker) throw new Error('当前浏览器不支持目录选择器,请使用 Chrome / Edge。')
  return picker.call(window, { mode: 'readwrite' })
}

/**
 * 持久化绑定并切换后端。调用方必须**先完成迁移**（现有正文复制进目录）再调本函数：
 * 落库即生效，之后所有 IO 都走新目录。
 */
export async function bindDirectory(handle: FileSystemDirectoryHandle): Promise<void> {
  await putConfig(DIR_HANDLE_KEY, handle)
  const granted = (await permOf(handle).queryPermission?.({ mode: 'readwrite' })) === 'granted'
  backendState = { kind: 'dir', handle, granted }
}

/** 解除绑定：句柄出库，后端回到内置 OPFS（根 handle 缓存继续复用）。 */
export async function unbindDirectory(): Promise<void> {
  await deleteConfig(DIR_HANDLE_KEY)
  backendState = { kind: 'opfs' }
}

/** 续期目录授权（须在用户手势内调用）；成功后就地更新 granted 并返回 true。 */
export async function requestDirectoryPermission(): Promise<boolean> {
  const state = await resolveBackend()
  if (state.kind !== 'dir') return false
  const request = permOf(state.handle).requestPermission
  if (!request) return false
  const result = await request.call(state.handle, { mode: 'readwrite' })
  state.granted = result === 'granted'
  return state.granted
}

/** 迁移回执：copied 复制过去的文件数，skipped 因目标已存在而跳过的数。 */
export interface MigrateResult {
  copied: number
  skipped: number
}

/**
 * 迁移：把内置 OPFS 的全部文件（含附件，不限 .md）复制进目标目录。
 * 目标里已有的同名文件一律跳过、绝不覆盖 —— 指向既有资料夹时用户内容优先，
 * 与索引的差异交给绑定后的 reconcile 以文件为准对账。目标里缺的子目录会补建。
 * 迁移成功后调用方才 `bindDirectory`，中途失败不会留下「已绑定但没迁完」的半状态。
 */
export async function migrateOpfsTo(target: FileSystemDirectoryHandle): Promise<MigrateResult> {
  const root = await opfsRoot()
  const files: string[] = []
  await walk(root, '', files, false)
  let copied = 0
  let skipped = 0
  for (const path of files) {
    if (await existsAt(target, path)) {
      skipped++
      continue
    }
    const content = await readAt(root, path)
    // 遍历后被并发删除的文件：跳过即可，绑定后的对账会如实反映两边。
    if (content === null) continue
    await writeAt(target, path, content)
    copied++
  }
  return { copied, skipped }
}

/**
 * 回迁：绑定目录 → 内置 OPFS 的完整镜像（目录里有的写进去、OPFS 多出来的删掉），
 * 让内置副本收敛成目录此刻的样子 —— 解除绑定后的对账不会复活已删笔记、也不丢新写入。
 * 无授权时返回 false 并静默跳过（授权屏上的「改用内置存储」拿不到内容，OPFS 停留在迁移前快照，
 * 文件本身仍完好地留在用户目录里）。
 */
export async function migrateDirToOpfs(): Promise<boolean> {
  const state = await resolveBackend()
  if (state.kind !== 'dir' || !state.granted) return false
  const target = await opfsRoot()
  const files: string[] = []
  await walk(state.handle, '', files, false)
  const keep = new Set<string>()
  for (const path of files) {
    keep.add(normalizePath(path))
    const content = await readAt(state.handle, path)
    if (content === null) continue
    if ((await readAt(target, path)) !== content) await writeAt(target, path, content)
  }
  const own: string[] = []
  await walk(target, '', own, false)
  for (const path of own) {
    if (!keep.has(normalizePath(path))) await deleteAt(target, path)
  }
  return true
}

/** 当前是否处于「已绑定目录」状态（reconcile 的外部改动检测只在该后端启用）。 */
export async function isDirBackend(): Promise<boolean> {
  return (await currentBackend()) === 'dir'
}

/** vault 内全部 `.md` 文件，返回规范化相对路径。用于启动时对账，不读内容。 */
export async function listNotePaths(): Promise<string[]> {
  const root = await getRoot()
  const found: string[] = []
  await walk(root, '', found)
  return found.sort()
}

/** 深度优先遍历。`prefix` 累加相对路径；`mdOnly` 时只收 `.md`（判定大小写不敏感，与 `isNotePath` 一致）。 */
async function walk(
  dir: FileSystemDirectoryHandle,
  prefix: string,
  out: string[],
  mdOnly = true,
): Promise<void> {
  for await (const entry of dir.values()) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.kind === 'directory') {
      // 重新按名字取一次句柄而不是用 `entry`：`values()` 的元素类型是基类 `FileSystemHandle`。
      const child = await dir.getDirectoryHandle(entry.name)
      await walk(child, path, out, mdOnly)
    } else if (!mdOnly || entry.name.toLowerCase().endsWith('.md')) {
      out.push(path)
    }
  }
}

/**
 * 清空正文。内置 OPFS 是整个应用私有的，连目录一起清；
 * 用户目录可能属于用户自己的资料夹，只删 `.md` 笔记 —— 非笔记文件绝不能碰。
 * 仅用于「存储被清空、需从远端重拉」的恢复流程，不可撤销。
 */
export async function clearAllNotes(): Promise<void> {
  const root = await getRoot()
  const state = await resolveBackend()
  if (state.kind === 'dir') {
    const files: string[] = []
    await walk(root, '', files, true)
    for (const path of files) await deleteAt(root, path)
    return
  }
  for await (const entry of root.values()) {
    await root.removeEntry(entry.name, { recursive: true })
  }
}

/** 批量预建目录：先把所有路径的祖先去重，再按长度升序创建，保证父先于子。 */
export async function ensureDirsFor(paths: Iterable<string>): Promise<void> {
  const root = await getRoot()
  const needed = new Set<string>()
  for (const p of paths) {
    for (const d of ancestorDirs(normalizePath(p))) needed.add(d)
  }
  for (const d of [...needed].sort((a, b) => a.length - b.length)) {
    await resolveDir(root, d, true)
  }
}

/**
 * 申请持久化存储：不给这个标志，浏览器在磁盘吃紧时可以连同 IndexedDB 一起清掉整个 OPFS。
 * 已授权时直接返回 true，避免重复弹权限请求。仅对内置后端有意义（用户目录由文件夹本身承载）。
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
