/**
 * ZIP 打包验证（src/core/vault/zip.ts）：
 * - crc32 必须与 `node:zlib` 的 crc32 逐位一致（独立预言机，不看自己的实现）；
 * - 本地文件头 / 中央目录 / EOCD 三段的字段（魔数、方法、标志位、尺寸、偏移、条目数）
 *   按 ZIP 规范用一套**独立的读取路径**反读回来，与构造器互为对照；
 * - deflate 产物必须能被 `zlib.inflateRawSync` 解回原文 —— 压缩流的正确性由外部实现裁决；
 * - 最终交给外部解压器（Windows/macOS 的 bsdtar、7z，或 Linux 的 python3 zipfile）
 *   真正解压一次，逐字节比对正文并核对还原的修改时间 —— 这是完全外部的解压端；store
 *   与 deflate 两条路径都要过这一关；
 * - 护栏：绝对路径、`..`、反斜杠、空段、重复条目、超量条目一律拒绝（zip slip 防护）。
 *
 * 运行：pnpm verify（第 13 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 as zlibCrc32, inflateRawSync } from 'node:zlib'
import { buildZip, crc32 } from '../src/core/vault/zip.ts'

let pass = 0
let fail = 0

/** 用 JSON 序列化后比较，失败时打印 expected/actual 差异。 */
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`)
  }
}

function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else {
    fail++
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 独立读取路径：按规范从包尾反读，不复用构造器的任何逻辑
// ---------------------------------------------------------------------------

interface ParsedEntry {
  path: string
  method: number
  flags: number
  crc: number
  compSize: number
  uncompSize: number
  /** 中央目录里记录的本地头偏移。 */
  localOffset: number
  time: number
  date: number
  /** 从本地头顺下来取到的压缩数据。 */
  payload: Uint8Array
}

interface ParsedZip {
  entries: ParsedEntry[]
  centralStart: number
  centralSize: number
  count: number
}

const u16 = (b: Uint8Array, off: number) => b[off] | (b[off + 1] << 8)
const u32 = (b: Uint8Array, off: number) =>
  (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0

/** 反读整个包。没有注释时 EOCD 固定在末尾 22 字节 —— 这正是本实现给自己定的契约。 */
function parseZip(bytes: Uint8Array): ParsedZip {
  const eocdStart = bytes.length - 22
  if (eocdStart < 0) throw new Error('包比 EOCD 还短')
  if (u32(bytes, eocdStart) !== 0x06054b50) throw new Error(`EOCD 魔数不对 @${eocdStart}`)
  const count = u16(bytes, eocdStart + 10)
  const centralSize = u32(bytes, eocdStart + 12)
  const centralStart = u32(bytes, eocdStart + 16)
  if (u16(bytes, eocdStart + 8) !== count) throw new Error('本卷条目数与总数不一致')
  if (u16(bytes, eocdStart + 20) !== 0) throw new Error('不该有包尾注释')

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const entries: ParsedEntry[] = []
  let pos = centralStart
  for (let i = 0; i < count; i++) {
    if (u32(bytes, pos) !== 0x02014b50) throw new Error(`中央目录第 ${i} 条魔数不对 @${pos}`)
    const flags = u16(bytes, pos + 8)
    const method = u16(bytes, pos + 10)
    const time = u16(bytes, pos + 12)
    const date = u16(bytes, pos + 14)
    const crc = u32(bytes, pos + 16)
    const compSize = u32(bytes, pos + 20)
    const uncompSize = u32(bytes, pos + 24)
    const nameLen = u16(bytes, pos + 28)
    const extraLen = u16(bytes, pos + 30)
    const commentLen = u16(bytes, pos + 32)
    const localOffset = u32(bytes, pos + 42)
    const path = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen))

    // 回到本地头独立地再读一遍文件名 —— 能抓出「中央目录与本地头不一致」这类错。
    if (u32(bytes, localOffset) !== 0x04034b50) throw new Error(`本地头魔数不对 @${localOffset}`)
    const localNameLen = u16(bytes, localOffset + 26)
    const localExtraLen = u16(bytes, localOffset + 28)
    const localPath = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLen))
    if (localPath !== path) throw new Error(`本地头与中央目录的路径不一致: ${localPath} vs ${path}`)
    const payloadStart = localOffset + 30 + localNameLen + localExtraLen
    const payload = bytes.subarray(payloadStart, payloadStart + compSize)

    entries.push({ path, method, flags, crc, compSize, uncompSize, localOffset, time, date, payload })
    pos += 46 + nameLen + extraLen + commentLen
  }
  if (pos !== centralStart + centralSize) throw new Error(`中央目录走完的位置不对: ${pos}`)
  return { entries, centralStart, centralSize, count }
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** 条目工厂：`mtime` 省略即取打包那一刻的时间。 */
function entry(path: string, text: string, mtime?: number) {
  return { path, data: enc.encode(text), mtime }
}

/** 固定的本地时间戳，用来核对 DOS 时间的编解码与时区无关性。 */
const STAMP_MS = new Date(2026, 0, 2, 3, 4, 6).getTime()

// ---------------------------------------------------------------------------
// crc32 对 node:zlib
// ---------------------------------------------------------------------------

const crcVectors: (string | Uint8Array)[] = [
  '',
  'a',
  'hello world\n',
  '中文测试 · Mixed ASCII 与 emoji 🙂\n',
  new Uint8Array(256).map((_, i) => i),
  '长内容'.repeat(5000),
]
for (let i = 0; i < crcVectors.length; i++) {
  const v = crcVectors[i]
  check(`crc32 vector ${i} matches zlib`, crc32(typeof v === 'string' ? enc.encode(v) : v), zlibCrc32(
    typeof v === 'string' ? Buffer.from(v, 'utf8') : v,
  ))
}
// 空输入必须是规范钉死的 0，而不是忘记末尾取反得到的 0xffffffff。
check('crc32 empty is 0', crc32(new Uint8Array(0)), 0)

// ---------------------------------------------------------------------------
// 空包
// ---------------------------------------------------------------------------

const empty = await buildZip([])
check('empty zip is exactly the 22-byte EOCD', empty.length, 22)
const emptyParsed = parseZip(empty)
check('empty zip reports 0 entries', emptyParsed.count, 0)
check('empty zip has no central directory', [emptyParsed.centralStart, emptyParsed.centralSize], [0, 0])

// ---------------------------------------------------------------------------
// store 路径：字段逐项核对
// ---------------------------------------------------------------------------

const STORE_CASES = [
  entry('root.md', '# 根笔记\n', STAMP_MS),
  entry('notes/想法/双链.md', '# 双链\n\n正文里带 [[另一篇]]。\n'),
  entry('notes/empty.md', ''),
  // 长路径要真能落到文件系统上：Linux 单个文件名组件限 255 **字节**（中文 UTF-8 每字
  // 3 字节），Windows 限 255 字符 —— 按两边都过取 60 字。超了外部解压器会 ENAMETOOLONG，
  // 整组字节比对与 mtime 断言都被跳过，覆盖率悄悄下降。
  entry(`notes/中文目录/${'很长'.repeat(30)}.md`, '重复段落验证长路径\n'.repeat(30)),
]

const storeZip = await buildZip(STORE_CASES, { deflate: false })
const storeParsed = parseZip(storeZip)
check('store: entry count', storeParsed.count, STORE_CASES.length)
check(
  'store: paths keep input order',
  storeParsed.entries.map((e) => e.path),
  STORE_CASES.map((e) => e.path),
)
for (let i = 0; i < STORE_CASES.length; i++) {
  const got = storeParsed.entries[i]
  const want = STORE_CASES[i]
  check(`store[${i}] method is 0`, got.method, 0)
  check(`store[${i}] sets the UTF-8 filename flag`, (got.flags & 0x0800) !== 0, true)
  check(`store[${i}] crc matches zlib`, got.crc, zlibCrc32(Buffer.from(want.data)))
  check(`store[${i}] compressed size equals raw size`, got.compSize, want.data.length)
  check(`store[${i}] uncompressed size`, got.uncompSize, want.data.length)
  check(`store[${i}] payload is byte-identical`, dec.decode(got.payload), dec.decode(want.data))
  check(`store[${i}] local offset points at a local header`, u32(storeZip, got.localOffset), 0x04034b50)
}

// ---------------------------------------------------------------------------
// DOS 时间：把时间戳解回 16 位字段
// ---------------------------------------------------------------------------

const timeZip = await buildZip([entry('t.md', 'x', STAMP_MS)], { deflate: false })
const stampEntry = parseZip(timeZip).entries[0]
check('dos time packs hh:mm:ss/2', stampEntry.time, (3 << 11) | (4 << 5) | (6 >> 1))
check('dos date packs yyyy-mm-dd from 1980', stampEntry.date, ((2026 - 1980) << 9) | (1 << 5) | 2)

// 1980 之前的年份要钳到 1980 而不是算出负数位。年份占高 7 位，钉死它是 0 即可 ——
// 用具体月日断言会随浏览器时区漂移（Date.UTC 与本地读数差一天）。
const oldZip = await buildZip([entry('old.md', 'x', Date.UTC(1969, 5, 1))], { deflate: false })
check('pre-1980 year is clamped to 1980', parseZip(oldZip).entries[0].date >>> 9, 0)

// ---------------------------------------------------------------------------
// deflate 路径：压缩流由 zlib 裁决
// ---------------------------------------------------------------------------

const BIG = '这是一段有重复模式的正文，用来确保 deflate 一定能压小。'.repeat(400)
const DEFLATE_CASES = [
  entry('big.md', BIG),
  entry('sub/dir/also-big.md', BIG),
  // 一个字节：deflate 的头尾比它还大，必须自行退回 store —— 这正是混合方法的来源。
  entry('tiny.md', 'x'),
  entry('empty.md', ''),
]

const deflated = await buildZip(DEFLATE_CASES)
const deflatedParsed = parseZip(deflated)
check('deflate: entry count', deflatedParsed.count, DEFLATE_CASES.length)
const methods = deflatedParsed.entries.map((e) => e.method)
ok('deflate actually engaged', methods.filter((m) => m === 8).length >= 2, `methods=${JSON.stringify(methods)}`)
ok('tiny entry fell back to store', methods[2] === 0, `method=${methods[2]}`)
ok('empty entry fell back to store', methods[3] === 0, `method=${methods[3]}`)

for (let i = 0; i < DEFLATE_CASES.length; i++) {
  const got = deflatedParsed.entries[i]
  const want = DEFLATE_CASES[i]
  // 无论走哪条路，长度与内容都必须自洽。
  check(`deflate[${i}] crc matches zlib`, got.crc, zlibCrc32(Buffer.from(want.data)))
  check(`deflate[${i}] uncompressed size`, got.uncompSize, want.data.length)
  if (got.method === 8) {
    let roundTrip: string | null
    try {
      roundTrip = dec.decode(inflateRawSync(Buffer.from(got.payload)))
    } catch (err) {
      roundTrip = null
      console.log(`  inflate failed on entry ${i}: ${String(err)}`)
    }
    check(`deflate[${i}] inflates back to the original`, roundTrip, dec.decode(want.data))
    ok(`deflate[${i}] actually shrank`, got.compSize < got.uncompSize, `${got.compSize} vs ${got.uncompSize}`)
  } else {
    check(`deflate[${i}] store payload is byte-identical`, dec.decode(got.payload), dec.decode(want.data))
  }
}

// ---------------------------------------------------------------------------
// 护栏：任何会让解压端写出目标目录之外的路径都必须被拒
// ---------------------------------------------------------------------------

const BAD_PATHS = [
  '',
  '/abs.md',
  'notes//double.md',
  'notes/./self.md',
  '../escape.md',
  'notes/../../escape.md',
  'notes\\windows.md',
  '..\\escape.md',
  'notes/ends/',
]
for (const bad of BAD_PATHS) {
  let threw = false
  let message = ''
  try {
    await buildZip([{ path: bad, data: enc.encode('x') }])
  } catch (err) {
    threw = true
    message = err instanceof Error ? err.message : String(err)
  }
  ok(`rejects unsafe path ${JSON.stringify(bad)}`, threw, message)
}

// 重复路径会产出两个同名条目 —— 解压时后者静默覆盖前者，必须当场拦下。
let dupThrew = false
try {
  await buildZip([entry('same.md', '1'), entry('same.md', '2')])
} catch {
  dupThrew = true
}
ok('rejects duplicate paths', dupThrew)

// 条目数超过 65534：16 位计数器的上限，0xFFFF 是 zip64 哨兵值。宁可报错也不写残包。
let tooManyThrew = false
try {
  await buildZip(Array.from({ length: 65535 }, (_, i) => entry(`f${i}.md`, 'x')))
} catch {
  tooManyThrew = true
}
ok('rejects more than 65534 entries', tooManyThrew)

// ---------------------------------------------------------------------------
// 端到端：交给外部解压器真正解压，逐字节比对
// ---------------------------------------------------------------------------

/**
 * 挑一个真能解 zip 的外部命令，按序试：
 *
 * 1. `tar -xf` —— 只在 bsdtar（Windows 自带的 libarchive、macOS）下认 zip；
 *    Ubuntu 的 GNU tar 报 "This does not look like a tar archive"，自动落到下一个。
 * 2. `7z` —— 保留 mtime，多数 runner 没装，试一下不亏。
 * 3. `python3 -m` 风格的 zipfile —— Ubuntu runner 必有，且**正确处理 UTF-8 文件名标志**。
 *
 * 刻意不用 Info-ZIP 的 `unzip`：它不认 ZIP 的 UTF-8 名字标志（bit 11），把我们写入的
 * UTF-8 字节当 CP437 再转成 locale 编码 —— 「很长」6 字节能膨胀成 18 字节，60 字的中文名
 * 越过 255 字节上限报 ENAMETOOLONG，短中文目录也会被建成乱码目录、随后读正文 ENOENT。
 * 这不是我们 zip 的问题，是解压端的编码缺陷，所以排除掉。
 *
 * `restoresMtime`：bsdtar/7z 会把打包时写入的 DOS 时间还原到文件系统，python3 的
 * extractall 不还原（写成当前时间）。mtime 断言只在能还原的工具上做。
 */
function extractZip(zipPath: string, outDir: string): { tool: string; restoresMtime: boolean } {
  const attempts: { tool: string; restoresMtime: boolean; run: () => void }[] = [
    {
      tool: 'tar',
      restoresMtime: true,
      run: () => execFileSync('tar', ['-xf', zipPath, '-C', outDir], { stdio: 'pipe' }),
    },
    {
      tool: '7z',
      restoresMtime: true,
      run: () => execFileSync('7z', ['x', '-y', `-o${outDir}`, zipPath], { stdio: 'pipe' }),
    },
    {
      tool: 'python3-zipfile',
      restoresMtime: false,
      // `python3 -m zipfile -e` 是 CPython 自带的命令行解压接口（3.3+），底层即
      // ZipFile.extractall：按 ZIP 的 UTF-8 名字标志解码，中文名原样落盘。
      run: () => execFileSync('python3', ['-m', 'zipfile', '-e', zipPath, outDir], { stdio: 'pipe' }),
    },
  ]
  const errors: string[] = []
  for (const a of attempts) {
    try {
      a.run()
      return { tool: a.tool, restoresMtime: a.restoresMtime }
    } catch (err) {
      errors.push(`${a.tool}: ${String(err)}`)
    }
  }
  throw new Error(`没有可用的 zip 解压器\n  ${errors.join('\n  ')}`)
}

const root = await mkdtemp(join(tmpdir(), 'webvault-zip-'))
try {
  const externalCases: [string, Uint8Array<ArrayBuffer>, typeof STORE_CASES][] = [
    ['store', storeZip, STORE_CASES],
    ['deflate', deflated, DEFLATE_CASES],
  ]
  for (const [label, bytes, cases] of externalCases) {
    const zipPath = join(root, `${label}.zip`)
    const outDir = join(root, `out-${label}`)
    await writeFile(zipPath, Buffer.from(bytes))
    await mkdir(outDir, { recursive: true })
    let extracted = true
    let tool = ''
    let restoresMtime = false
    try {
      const r = extractZip(zipPath, outDir)
      tool = r.tool
      restoresMtime = r.restoresMtime
    } catch (err) {
      extracted = false
      fail++
      // 文件名字节数用 Buffer.byteLength 直接量，不受日志编码影响 —— 失败时能一眼
      // 判断是不是撞了 255 字节的文件名上限。
      const lens = cases.map((c) => `${Buffer.byteLength(c.path.split('/').pop()!)}B`).join(' ')
      console.log(`FAIL ${label}: 无法解压 (名字字节数: ${lens})\n  ${String(err)}`)
    }
    if (!extracted) continue

    for (const c of cases) {
      const text = await readFile(join(outDir, ...c.path.split('/')), 'utf8')
      check(`${label} (${tool}) extracts ${c.path} byte-identical`, text, dec.decode(c.data))
    }
    if (label === 'store') {
      // DOS 时间是本地时间、2 秒精度 —— 容差取 3 秒，超了就是时间字段编错了。
      if (!restoresMtime) {
        console.log(`SKIP ${label} mtime: ${tool} 不还原修改时间（结构与字节已由上面的断言覆盖）`)
      } else {
        const restored = (await stat(join(outDir, 'root.md'))).mtimeMs
        ok(`${tool} restores the mtime we packed`, Math.abs(restored - STAMP_MS) < 3000, `restored=${restored} packed=${STAMP_MS}`)
      }
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`${fail === 0 ? 'OK  ' : 'FAIL'} verify-zip: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
