/**
 * OPFS 目录句柄的异步迭代声明：浏览器已实现，但 `lib.dom.d.ts` 尚未收录。
 * 合并进全局接口后，`for await (const e of dir.values())` 才能通过类型检查。
 * 仅是类型补充，不含任何运行时代码。
 */
interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>
  keys(): AsyncIterableIterator<string>
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}
