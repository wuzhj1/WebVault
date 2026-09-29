/**
 * 极简 ZIP 写入器 —— 「导出备份」的打包层。
 *
 * 为什么手写：项目至今没有任何压缩依赖，而把若干文本文件打进一个 `.zip` 只需要写三段
 * 定长结构（本地文件头 → 中央目录 → EOCD）。**压缩本身不自己实现**：交给浏览器原生的
 * `CompressionStream('deflate-raw')`；该 API 缺席或失败时整包退回 store（method 0，不压缩）。
 * ZIP 允许逐条目选择方法，任何解压工具都能正常打开两种结果。
 *
 * 刻意不支持的边界（注释即契约，越界直接抛错而不是静默截断）：
 * - 不做 zip64：单条 < 4GiB、总条目 ≤ 65534。笔记是纯文本，差着好几个数量级；
 *   写成静默截断的残包才是真正的数据灾难。
 * - 不加密、不多卷、不写 extra field / 注释，也不算 Unix 权限位（外部属性恒 0）。
 * - 文件名按 UTF-8 落盘并置 general purpose bit 11 —— 中文路径全靠这一位被解压端认出来。
 *
 * 纯模块：只用相对导入且不碰 `db.ts`，因此能被 `scripts/verify-zip.mts` 裸 node 直跑验证。
 */

/** 三段结构的魔数。 */
const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

/** 通用标志位 bit 11 = 文件名与注释都是 UTF-8。缺了它，中文路径会被当成 cp437 读成乱码。 */
const UTF8_FLAG = 0x0800
/** 需要的最低解压能力版本（20 = 2.0，支持 deflate）。 */
const VERSION = 20
/** EOCD 的条目数是 16 位，0xFFFF 是 zip64 的哨兵值，所以只能到 65534。 */
const MAX_ENTRIES = 0xfffe
/** 各处 32 位尺寸/偏移字段的上限。 */
const MAX_UINT32 = 0xffffffff
/** 本地文件头 / 中央目录头的固定长度（不含文件名）。 */
const LOCAL_HEADER_LEN = 30
const CENTRAL_HEADER_LEN = 46
const EOCD_LEN = 22

const ENCODER = new TextEncoder()

/** 一个待打包的条目。`path` 用 `/` 分隔，是解压后在磁盘上的相对路径。 */
export interface ZipEntry {
  path: string
  /**
   * 原始字节；是否压缩由本模块按体积与运行时能力自行决定。
   * 泛型固定为 `ArrayBuffer` 而不是默认的 `ArrayBufferLike`：`CompressionStream` 的写入端
   * 只收 `ArrayBufferView<ArrayBuffer>`，收窄在这里，调用方（`TextEncoder.encode` 正好就是）不用到处转。
   */
  data: Uint8Array<ArrayBuffer>
  /** 文件修改时间（毫秒）。缺省取当前时间；ZIP 只有 2 秒粒度的 DOS 时间精度。 */
  mtime?: number
}

export interface ZipOptions {
  /**
   * 是否尝试 deflate。缺省为 true（运行时支持则压缩）。
   * 传 false 可强制 store —— 验证脚本用它把两条路径都覆盖到。
   */
  deflate?: boolean
}

/** 组装完成后其中一条的落盘参数；只在 buildZip 内部流转。 */
interface Prepared {
  name: Uint8Array<ArrayBuffer>
  /** 未压缩原文，用来算 CRC 与填 uncompressed size。 */
  data: Uint8Array<ArrayBuffer>
  /** 真正写进包里的字节（store 时与 data 是同一个引用）。 */
  payload: Uint8Array<ArrayBuffer>
  method: number
  crc: number
  time: number
  date: number
  offset: number
}

// ---------------------------------------------------------------------------
// CRC-32（ZIP 的校验算法，与 PKZIP/ITU-T V.42 的 reflected 多项式一致）
// ---------------------------------------------------------------------------

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/**
 * CRC-32 校验和，返回无符号 32 位值。
 * 查表法：每字节一次异或与移位，纯文本导出的量级下足够快，且不申请任何临时缓冲。
 * 参数用不带泛型的 `Uint8Array`：只要参与运算，`Buffer` 之类的派生视图也能直接传进来。
 */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// ---------------------------------------------------------------------------
// 压缩
// ---------------------------------------------------------------------------

/**
 * `CompressionStream('deflate-raw')` 是否可用。结果缓存 —— 探测要真开一个流，
 * 每个条目探一次纯属浪费；探测失败也说明整包都不该再试。
 */
let deflateRawOk: boolean | undefined

function supportsDeflateRaw(): boolean {
  if (deflateRawOk !== undefined) return deflateRawOk
  if (typeof CompressionStream === 'undefined') {
    deflateRawOk = false
    return false
  }
  try {
    void new CompressionStream('deflate-raw')
    deflateRawOk = true
  } catch {
    deflateRawOk = false
  }
  return deflateRawOk
}

/** 拼接若干分块为单块：拿到总长后一次分配，避免反复扩容与拷贝。 */
function concat(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total)
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}

/**
 * 单条压缩。返回 { payload, method }，由调用方写进头部。
 *
 * 顺序有讲究：**先起 `collect` 再 `write`** —— 写入端会按流的背压停下来等人读，
 * 若等写完才开始读，超过内部队列的大文件会互相等死。`collect` 一进来就阻塞在
 * `reader.read()` 上，等价于「边压边收」。
 */
async function compress(
  data: Uint8Array<ArrayBuffer>,
  enabled: boolean,
): Promise<{ payload: Uint8Array<ArrayBuffer>; method: number }> {
  // 空文件压出来是十几字节的 zlib 头尾，比原文还大，直接存原始字节。
  if (!enabled || !supportsDeflateRaw() || data.length === 0) return { payload: data, method: 0 }

  let payload: Uint8Array<ArrayBuffer>
  try {
    const stream = new CompressionStream('deflate-raw')
    const collect = (async (): Promise<Uint8Array<ArrayBuffer>> => {
      const reader = stream.readable.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.length
      }
      return concat(chunks, total)
    })()
    const writer = stream.writable.getWriter()
    await writer.write(data)
    await writer.close()
    payload = await collect
  } catch {
    // 探测通过但真用时炸了（或压到一半失败）：退回 store，并且此后整包不再尝试。
    deflateRawOk = false
    return { payload: data, method: 0 }
  }

  // 压缩反而变大就退回 store（短内容、已压缩内容都会这样）—— ZIP 逐条目支持混合方法。
  if (payload.length >= data.length) return { payload: data, method: 0 }
  return { payload, method: 8 }
}

// ---------------------------------------------------------------------------
// DOS 时间
// ---------------------------------------------------------------------------

/**
 * 毫秒时间戳 → ZIP 的 16 位 time / 16 位 date。年份只有 7 位（1980 起），
 * 时间粒度 2 秒 —— 越界一律钳到边界，写出 0 这种"1980-00-00"会更糟。
 */
function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms)
  const year = Math.min(2107, Math.max(1980, d.getFullYear()))
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time: time & 0xffff, date: date & 0xffff }
}

// ---------------------------------------------------------------------------
// 路径校验
// ---------------------------------------------------------------------------

/**
 * 打进包里的路径必须是干净的相对路径。这里拦的每一条都是真实的解压风险：
 * 绝对路径、`..` 会让解压端写出目标目录之外（zip slip）；`\` 会被当成文件名字面量；
 * 空段会在部分工具里变成空目录项。
 */
function assertSafePath(path: string): void {
  if (path === '') throw new Error('ZIP 条目路径不能为空')
  if (path.startsWith('/') || path.startsWith('\\')) throw new Error(`ZIP 条目路径不能以分隔符开头: ${path}`)
  if (path.includes('\\')) throw new Error(`ZIP 条目路径不能含反斜杠: ${path}`)
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new Error(`ZIP 条目路径含非法路径段: ${path}`)
  }
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

/**
 * 把条目组装成一个 ZIP 文件的字节。条目顺序即包内顺序。
 *
 * 组装是纯顺序追加：先量出总长、一次性分配一个 buffer，再按「本地文件头+数据 →
 * 中央目录 → EOCD」的顺序填。分块拼接会让这份本该线性的代码多出一串临时数组，
 * 也会让偏移量计算变得难验证。
 */
export async function buildZip(entries: readonly ZipEntry[], opts: ZipOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`ZIP 条目数 ${entries.length} 超过上限 ${MAX_ENTRIES}`)
  }
  const wantDeflate = opts.deflate ?? true

  const prepared: Prepared[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    assertSafePath(entry.path)
    if (seen.has(entry.path)) throw new Error(`ZIP 条目路径重复: ${entry.path}`)
    seen.add(entry.path)
    if (entry.data.length > MAX_UINT32) throw new Error(`ZIP 条目超 4GiB: ${entry.path}`)

    const name = ENCODER.encode(entry.path)
    const crc = crc32(entry.data)
    const { payload, method } = await compress(entry.data, wantDeflate)
    const { time, date } = dosDateTime(entry.mtime ?? Date.now())
    prepared.push({ name, data: entry.data, payload, method, crc, time, date, offset: 0 })
  }

  let localSize = 0
  let centralSize = 0
  for (const p of prepared) {
    localSize += LOCAL_HEADER_LEN + p.name.length + p.payload.length
    centralSize += CENTRAL_HEADER_LEN + p.name.length
  }
  const total = localSize + centralSize + EOCD_LEN
  if (localSize > MAX_UINT32 || total > MAX_UINT32) throw new Error('导出体积超过 ZIP 格式上限 (4GiB)')

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let pos = 0

  // 本地文件头 + 数据
  for (const p of prepared) {
    p.offset = pos
    view.setUint32(pos, LOCAL_SIG, true)
    view.setUint16(pos + 4, VERSION, true) // version needed
    view.setUint16(pos + 6, UTF8_FLAG, true) // general purpose flag
    view.setUint16(pos + 8, p.method, true)
    view.setUint16(pos + 10, p.time, true)
    view.setUint16(pos + 12, p.date, true)
    view.setUint32(pos + 14, p.crc, true)
    view.setUint32(pos + 18, p.payload.length, true)
    view.setUint32(pos + 22, p.data.length, true)
    view.setUint16(pos + 26, p.name.length, true)
    view.setUint16(pos + 28, 0, true) // extra field length
    pos += LOCAL_HEADER_LEN
    out.set(p.name, pos)
    pos += p.name.length
    out.set(p.payload, pos)
    pos += p.payload.length
  }

  // 中央目录
  const centralStart = pos
  for (const p of prepared) {
    view.setUint32(pos, CENTRAL_SIG, true)
    view.setUint16(pos + 4, VERSION, true) // version made by
    view.setUint16(pos + 6, VERSION, true) // version needed
    view.setUint16(pos + 8, UTF8_FLAG, true)
    view.setUint16(pos + 10, p.method, true)
    view.setUint16(pos + 12, p.time, true)
    view.setUint16(pos + 14, p.date, true)
    view.setUint32(pos + 16, p.crc, true)
    view.setUint32(pos + 20, p.payload.length, true)
    view.setUint32(pos + 24, p.data.length, true)
    view.setUint16(pos + 28, p.name.length, true)
    view.setUint16(pos + 30, 0, true) // extra field length
    view.setUint16(pos + 32, 0, true) // comment length
    view.setUint16(pos + 34, 0, true) // disk number start
    view.setUint16(pos + 36, 0, true) // internal attributes
    view.setUint32(pos + 38, 0, true) // external attributes
    view.setUint32(pos + 42, p.offset, true)
    pos += CENTRAL_HEADER_LEN
    out.set(p.name, pos)
    pos += p.name.length
  }
  const writtenCentralSize = pos - centralStart
  // 预量的中央目录长度与实际写进去的必须一致 —— 不一致说明条目尺寸算错了。
  if (writtenCentralSize !== centralSize) {
    throw new Error(`ZIP 中央目录长度不一致: planned ${centralSize}, wrote ${writtenCentralSize}`)
  }

  // EOCD：包尾固定 22 字节（我们从不写注释），所以解压端可以从末尾直接读它。
  view.setUint32(pos, EOCD_SIG, true)
  view.setUint16(pos + 4, 0, true) // 本卷号
  view.setUint16(pos + 6, 0, true) // 中央目录所在卷号
  view.setUint16(pos + 8, prepared.length, true) // 本卷条目数
  view.setUint16(pos + 10, prepared.length, true) // 总条目数
  view.setUint32(pos + 12, writtenCentralSize, true)
  view.setUint32(pos + 16, centralStart, true)
  view.setUint16(pos + 20, 0, true) // 注释长度
  pos += EOCD_LEN

  // 装配长度对不上就是算错偏移了 —— 宁可在这里炸，也别交出一个解不开的包。
  if (pos !== total) throw new Error(`ZIP 组装长度不一致: wrote ${pos}, allocated ${total}`)
  return out
}
