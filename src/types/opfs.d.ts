/**
 * OPFS async iteration is shipped by browsers but missing from lib.dom.d.ts.
 * Merged onto the global interface so `for await (const e of dir.values())` typechecks.
 */
interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>
  keys(): AsyncIterableIterator<string>
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}
