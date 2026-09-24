/**
 * 用 git 的 blob object id 作为内容指纹，这样本地算出的 sha 能直接与 Gitee tree entry 的 sha 比对，
 * 无需任何自定义协议。
 *
 * 硬约束：运行时依赖 `crypto.subtle` 与 `TextEncoder`（浏览器安全上下文与 Node ≥19 都提供，
 * 因此 `scripts/verify-hash.mts` 能以裸 node 直跑并用 git 向量对照）；只用相对导入，无 `@/` 别名。
 * SHA-1 在此仅作内容标识、非安全用途，这正是 git 自己的选择。
 */

const encoder = new TextEncoder()

/** 参数类型写成 `Uint8Array<ArrayBuffer>` 而非 `Uint8ArrayLike`：`crypto.subtle.digest` 要求确定性缓冲。 */
async function sha1Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** `sha1("blob <len>\0" + content)` —— git 为一个文件所存的 id。按 UTF-8 编码，与 git 一致。 */
export async function gitBlobSha(content: string): Promise<string> {
  const body = encoder.encode(content)
  return gitBlobShaBytes(body)
}

/** 字节版入口：同步侧已经拿到二进制时直接复用，避免「解码再编码」造成不可见字节往返失真。 */
export async function gitBlobShaBytes(body: Uint8Array<ArrayBuffer>): Promise<string> {
  // header 里的长度是字节数而非字符数，`\0` 也计入 —— 这是 git 的定义，错一位 sha 就全不一样。
  const header = encoder.encode(`blob ${body.byteLength}\0`)
  const buf = new Uint8Array(header.byteLength + body.byteLength)
  buf.set(header, 0)
  buf.set(body, header.byteLength)
  return sha1Hex(buf)
}

/** 本地元数据索引用的截断指纹；SHA-256 前 8 字节，不是 git 兼容值，故不可与远端比对。 */
export async function contentFingerprint(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(content))
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * 冲突副本文件名后缀 `YYYYMMDDTHHmmss`。用本地时间而非 UTC：这个串是给人读的，
 * 要能和「我什么时候改的」对上，时区或夏令时切换都不该让它跳到另一小时。
 */
export function conflictStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`
}
