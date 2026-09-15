/** Git blob object ids, so local hashes can be compared against Gitee tree entries. */

const encoder = new TextEncoder()

async function sha1Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** `sha1("blob <len>\0" + content)` — the id git stores for a file. */
export async function gitBlobSha(content: string): Promise<string> {
  const body = encoder.encode(content)
  return gitBlobShaBytes(body)
}

export async function gitBlobShaBytes(body: Uint8Array<ArrayBuffer>): Promise<string> {
  const header = encoder.encode(`blob ${body.byteLength}\0`)
  const buf = new Uint8Array(header.byteLength + body.byteLength)
  buf.set(header, 0)
  buf.set(body, header.byteLength)
  return sha1Hex(buf)
}

/** Truncated hash used for the local metadata index; not git-compatible. */
export async function contentFingerprint(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(content))
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function conflictStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`
}
