/**
 * YAML frontmatter 的读取与字节稳定（byte-stable）改写。
 *
 * 这不是一个 YAML 解析器，也永远不能变成一个是。Vault 里的文件同时被其他工具编辑，所以这里的契约
 * 比通用解析更窄、更强：识别文件开头的 `---` 块、从中读出五个 key、把这五个 key 写回去且不动其他任何
 * 一个字节。未知 key、注释行、嵌套结构、引号风格、重复 key、空行都必须原样存活——一次「顺手整理」别人
 * YAML 的重写就是一次悄悄毁掉它的重写；任何一个多余字节的翻转都会改变 `gitBlobSha`、把笔记标成脏、
 * 并扩大三方合并的冲突面。
 *
 * 本模块两条硬约束：
 * 1. 只用相对导入。`scripts/verify-frontmatter.mts` 以裸 node 直跑本文件，没有别名解析器。
 * 2. 不得在运行时导入 `../db.ts`；它在模块作用域构造 Dexie。类型用 `import type` 没问题。
 */

/** 本应用持有的五个 key。块内其他一切内容都是不透明负载，原样保留。 */
export const OWNED_KEYS = ['id', 'type', 'created', 'tags', 'aliases'] as const

/** `OWNED_KEYS` 中某个 key 的字面量类型，即本模块有权读写的元数据字段名。 */
export type OwnedKey = (typeof OWNED_KEYS)[number]

/** 尚不存在的新 key 的插入顺序；未知 key 保持各自原有顺序。 */
export const KEY_ORDER: readonly OwnedKey[] = OWNED_KEYS

const BOM = '\uFEFF'

/**
 * 与 `links.ts` 共用：它在抽取链接和标签时跳过同一个块。两者必须逐字节达成一致，
 * 否则一方会把另一方的元数据当成正文来解析。
 */
export const FRONTMATTER_DELIM = /^\s{0,3}---\s*$/

/**
 * 顶层 `key: value` 行。只认第 0 列，因此嵌套 map 和 block list 条目保持不透明。
 * 在第一个冒号处切分，且要求冒号后跟空格或行尾：这是 YAML 的规则，它让 `title: 'a: b'`
 * 保持完整，同时拒绝把 `tags:[a]` 读成映射。
 */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.\-/]*):( |$)(.*)$/

/** key 值为空时以缩进 `- item` 延续的行，即 YAML block list。 */
const BLOCK_ITEM = /^\s+-\s*(.*)$/

/** 块内一行顶层 `key: value` 的解析结果。 */
export interface FrontmatterEntry {
  key: string
  /** 按原样写出的 value：尾部注释已剥离，引号仍在 */
  value: string
  /** 在整篇文档中的绝对行号 */
  line: number
}

/** 一次 frontmatter 解析的完整结果：块的位置、块体行与顶层 key 清单。 */
export interface Frontmatter {
  /** 仅当第 0 行开了一个块、且后面有 `---` 行闭合时为 true */
  exists: boolean
  /** 开头 `---` 的行号，不存在则为 -1 */
  openLine: number
  /** 结尾 `---` 的行号，不存在则为 -1 */
  closeLine: number
  /** 两个分隔符之间的行（不含分隔符），用于收集 block list */
  body: string[]
  /** 按文件顺序列出的全部顶层 `key: value` 行，含重复项 */
  entries: FrontmatterEntry[]
  /** 出现多于一次的 key。`writeKeys` 拒绝改动这些；见方案里的 `R3`。 */
  duplicates: string[]
}

/** 复用同一份空结果，避免每次未命中都新建对象。 */
const NO_FRONTMATTER: Frontmatter = {
  exists: false,
  openLine: -1,
  closeLine: -1,
  body: [],
  entries: [],
  duplicates: [],
}

/** 去掉首行可能存在的 BOM，它会让 `FRONTMATTER_DELIM` 认不出 `---`。 */
function stripBom(line: string): string {
  return line.startsWith(BOM) ? line.slice(1) : line
}

/**
 * JS 正则把 `\r` 也当行终止符，因此 `.` 和 `$` 都会在它前面停下，CRLF 行永远匹配不上。
 * 解析时剥掉它；写出时不剥，未改动的行因而保持原字节。
 */
function bare(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * 返回闭合「第 0 行开起的块」的那个 `---` 的行号，未闭合返回 -1。
 *
 * 未闭合的块按「没有块」处理：CommonMark 会把开头没有闭合符的 `---` 读成水平分割线，
 * 文件其余部分全是正文。若把它宣称成元数据，笔记里的每个链接都会被藏起来，且 `writeKeys`
 * 会在真实内容之上再压一个块。
 */
export function frontmatterEnd(lines: readonly string[]): number {
  if (lines.length === 0 || !FRONTMATTER_DELIM.test(stripBom(lines[0]))) return -1
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIM.test(lines[i])) return i
  }
  return -1
}

/**
 * 解析整篇文本的 frontmatter 块。无块时返回共享的 `NO_FRONTMATTER`；
 * 只扫块内的行，块外内容一概不看。
 */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = (text.startsWith(BOM) ? text.slice(1) : text).split('\n')
  const closeLine = frontmatterEnd(lines)
  if (closeLine === -1) return NO_FRONTMATTER

  const body = lines.slice(1, closeLine)
  const entries: FrontmatterEntry[] = []
  const seen = new Map<string, number>()

  body.forEach((raw, i) => {
    const m = bare(raw).match(KEY_LINE)
    if (!m) return
    const key = m[1]
    entries.push({ key, value: stripComment(m[3]), line: i + 1 })
    seen.set(key, (seen.get(key) ?? 0) + 1)
  })

  return {
    exists: true,
    openLine: 0,
    closeLine,
    body,
    entries,
    // 排序是为了让 `duplicates` 稳定可比：Map 迭代顺序随插入顺序变化，测试与告警都不该依赖它。
    duplicates: [...seen].filter(([, n]) => n > 1).map(([k]) => k).sort(),
  }
}

/** 文件是否以合法的（有闭合符的）frontmatter 块开头。 */
export function hasFrontmatter(text: string): boolean {
  return frontmatterEnd((text.startsWith(BOM) ? text.slice(1) : text).split('\n')) !== -1
}

/**
 * 元数据块与其后的正文，切分保证对任何输入都有 `fm + body === raw`。
 *
 * 编辑器只持有 `body`。卡片的元数据是它的永久地址，而不是写作时要读的东西；把它挡在 DOM 之外，
 * 才让按键、undo 和斜杠命令都碰不到它。整个要点在于按切片偏移量切分而非重拼行：重拼就得还原原始
 * 换行符、可能缺失的末尾换行和 BOM，任何一次还原失败都是对别人笔记的无声截断。用切片的话，这个
 * 恒等式靠构造成立——包括那些没人想到要写 fixture 的输入。
 */
export function splitFrontmatter(raw: string): { fm: string; body: string } {
  const lines = raw.split('\n')
  const closeLine = frontmatterEnd(lines)
  if (closeLine === -1) return { fm: '', body: raw }

  let offset = 0
  for (let i = 0; i <= closeLine; i++) offset += lines[i].length + 1
  // 惯例上分隔块与正文的那个空行归块所有，编辑器因此不会以一个空段落开头。只吃一个：
  // 第二个空行是作者自己的段落分隔。`writeKeys` 写出的文件根本没有这个空行；而当闭合
  // 分隔符是文件最后一行且其后无换行时，`slice` 会自行钳制越界。
  if (raw[offset] === '\n') offset++

  return { fm: raw.slice(0, offset), body: raw.slice(offset) }
}

/** `key` 第一个条目的原样 value，不存在返回 null。列表按原始 `[a, b]` 文本返回。 */
export function readRaw(fm: Frontmatter, key: string): string | null {
  const entry = fm.entries.find((e) => e.key === key)
  return entry === undefined ? null : entry.value
}

/**
 * 读 `id`、`type`、`created` 这类标量。缺失时为 null；key 挂的是列表时也是 null——
 * 要标量的调用方不该悄悄拿到 `[a, b]`。
 */
export function readScalar(fm: Frontmatter, key: string): string | null {
  const raw = readRaw(fm, key)
  if (raw === null) return null
  const decoded = decodeScalar(raw)
  return decoded.startsWith('[') ? null : decoded
}

/** 读 `tags`、`aliases`。处理 `[]`、`[a, b]`、裸标量，以及缩进 `- item` 块。 */
export function readList(fm: Frontmatter, key: string): string[] {
  const entry = fm.entries.find((e) => e.key === key)
  if (entry === undefined) return []

  const value = entry.value
  if (value.startsWith('[')) return parseFlowList(value)
  if (value !== '') return [decodeScalar(value)]

  const out: string[] = []
  for (const i of blockItems(fm, entry.line)) {
    const m = bare(fm.body[i]).match(BLOCK_ITEM)
    if (!m) continue
    const item = decodeScalar(stripComment(m[1]))
    if (item !== '') out.push(item)
  }
  return out
}

/**
 * 绝对行号 `line` 处的条目所隶属的那段缩进 `- item` 在 body 中的下标。
 * 读和写必须在这件事上达成一致，否则把这种 key 换成 flow list 会把条目剩成孤儿，
 * 让整个块变成非法 YAML。
 */
function blockItems(fm: Frontmatter, line: number): number[] {
  const out: number[] = []
  for (let i = line - fm.openLine; i < fm.body.length; i++) {
    if (!BLOCK_ITEM.test(bare(fm.body[i]))) break
    out.push(i)
  }
  return out
}

/** frontmatter 里能出现的值：标量或字符串列表。 */
export type FrontmatterValue = string | string[]

/** 一次改写请求；值为 null 表示删除该 key，缺 key 表示不动该 key。 */
export type FrontmatterPatch = { [K in OwnedKey]?: FrontmatterValue | null }

/**
 * 返回应用了 `patch` 后的 `text`，尽量少改字节。
 *
 * - 空 patch 对任何输入都是恒等函数；
 * - 未改动的行保持精确字节，包括缩进、引号风格和注释；
 * - 出现多于一次的 key 一律不碰，不去猜用户指的是哪一个；
 * - 新 key 按 `KEY_ORDER` 落在其他 owned key 之间，绝不重排未知 key；
 * - 没有块的文件会在开头补一个，正文不变，且闭合 `---` 后不留空行（Lute 会吃掉那个空行，
 *   写出来就等于保证笔记第一次保存即产生幻影 diff）。
 *
 * 两个有意为之的例外，都限定在调用方要求改动的行内：
 * - 改写一个挂着缩进 `- item` 列表的 key，会把它重写为 flow list 并删掉那些条目。留着它们
 *   会把列表孤儿化到前一个 key 之下，破坏 YAML 结构。
 * - 被写出的行以 `\n` 结尾，因此 CRLF 文件只在未改动的行上保留 `\r`。反正 Lute 下次保存
 *   整篇笔记时本来就会把全文件归一成 LF。
 */
export function writeKeys(text: string, patch: FrontmatterPatch): string {
  const requested = OWNED_KEYS.filter((k) => k in patch)
  if (requested.length === 0) return text

  const bom = text.startsWith(BOM)
  const lines = (bom ? text.slice(1) : text).split('\n')
  const fm = parseFrontmatter(text)

  // 块内出现重复 key，正是三方合并落在这个块里的产物。重写任何一份都会让文件比现状更糟，
  // 所以调用方拿到的是其余 key 加一条告警。
  const wanted = requested.filter((k) => patch[k] !== null && !fm.duplicates.includes(k))
  const removals = requested.filter((k) => patch[k] === null && !fm.duplicates.includes(k))
  if (wanted.length === 0 && removals.length === 0) return text

  if (!fm.exists) {
    const block = ['---', ...wanted.map((k) => renderEntry(k, patch[k] as FrontmatterValue)), '---']
    return join(bom, [...block, ...lines])
  }

  const bodyStart = fm.openLine + 1
  // 每个 key 只记第一次出现的行号，重复项已在上面被过滤掉。
  const existing = new Map<string, number>()
  for (const e of fm.entries) if (!existing.has(e.key)) existing.set(e.key, e.line)

  // rewritten：就地替换的行；removed：删掉的 key 行；dropped：随该 key 一起清掉的 block list 条目。
  const rewritten = new Map<number, string>()
  const removed = new Set<number>()
  const dropped = new Set<number>()
  for (const key of [...wanted, ...removals]) {
    const at = existing.get(key)
    if (at === undefined) continue
    if (patch[key] === null) removed.add(at)
    else rewritten.set(at, renderEntry(key, patch[key] as FrontmatterValue))
    // 改写或删除一个挂着缩进列表的 key 时，必须连同它的 `- item` 行一起处理，否则留下孤儿。
    for (const i of blockItems(fm, at)) dropped.add(i + fm.openLine + 1)
  }

  // 新 key 按 insertBefore 选定的插入点归桶；同一插入点的多个 key 保持 wanted 内的相对顺序。
  const inserts = wanted.filter((k) => !existing.has(k))
  const insertedAt = new Map<number, string[]>()
  for (const key of inserts) {
    const line = renderEntry(key, patch[key] as FrontmatterValue)
    const at = insertBefore(fm, key)
    const bucket = insertedAt.get(at)
    if (bucket) bucket.push(line)
    else insertedAt.set(at, [line])
  }

  // 重建块体：开头 `---` 原样保留，逐行输出「插入桶 → 跳过删除行 → 原行或重写行」。
  const out: string[] = [lines[fm.openLine]]
  for (let i = bodyStart; i < fm.closeLine; i++) {
    const extra = insertedAt.get(i)
    if (extra) out.push(...extra)
    if (removed.has(i) || dropped.has(i)) continue
    out.push(rewritten.get(i) ?? lines[i])
  }
  // 排在最后一个 owned key 之后的新 key，落在闭合 `---` 前一行。
  const tail = insertedAt.get(fm.closeLine)
  if (tail) out.push(...tail)
  out.push(...lines.slice(fm.closeLine))

  return join(bom, out)
}

/**
 * 全新 owned key 的落点：紧跟在 `KEY_ORDER` 中排在它后面的第一个 owned key 之前，
 * 否则落在块尾。落到末尾可以避开属于最后一个条目的任何缩进 `- item` 行。
 */
function insertBefore(fm: Frontmatter, key: OwnedKey): number {
  const rank = KEY_ORDER.indexOf(key)
  for (const e of fm.entries) {
    if (KEY_ORDER.indexOf(e.key as OwnedKey) > rank) return e.line
  }
  return fm.closeLine
}

/** 把一个 owned key 渲染成 `key: value` 行；列表走 flow list，标量走 encodeScalar。 */
function renderEntry(key: OwnedKey, value: FrontmatterValue): string {
  return `${key}: ${Array.isArray(value) ? encodeList(value) : encodeScalar(value)}`
}

/** 重拼输出：若原文件带 BOM 则补回，未改动行的 `\r` 已在 lines 里原样保留。 */
function join(bom: boolean, lines: string[]): string {
  const text = lines.join('\n')
  return bom ? BOM + text : text
}

/**
 * 保存安全网的判定：编辑器交回来的正文把原本的 frontmatter 块弄丢了才返回 true。
 *
 * 为什么需要它：fm 块从不进编辑器，保存时靠「旧块 + 新正文」拼接；一旦拼接路径被改坏
 * （块没拼回去），这次保存会把文件的永久地址静默冲掉并推到 Gitee 上——灾难且不可见。
 * 拦下来并还原，把不可见的失败变成可见可恢复的（编辑器 flushSave 的拒绝保存分支即依赖此语义）。
 *
 * 三条豁免各有理由：
 * - before 本来就没块：它从来不是文件身份的一部分，无从丢；
 * - after 还有块：正常的改写（哪怕键全变了、块变矮了）都不算丢；
 * - after 被清空成空白：这是用户故意清空整篇，拦住反而挡路。
 */
export function frontmatterLostGuard(before: string, after: string): boolean {
  if (!parseFrontmatter(before).exists) return false
  if (parseFrontmatter(after).exists) return false
  return after.trim() !== ''
}

/** 仅当裸写法在 YAML 下会改变值的含义时才加引号。 */
export function encodeScalar(value: string): string {
  return needsQuotes(value) ? `'${value.replace(/'/g, "''")}'` : value
}

/** 编码为 YAML flow list；空列表写成 `[]`。 */
export function encodeList(items: readonly string[]): string {
  if (items.length === 0) return '[]'
  return `[${items.map(encodeScalar).join(', ')}]`
}

/** 判断裸写法是否会改变 YAML 语义（空串、首尾空白、指示符开头、`: `/` #`、布尔类词等）。 */
function needsQuotes(value: string): boolean {
  if (value === '') return true
  if (value !== value.trim()) return true
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return true
  if (/:\s/.test(value) || value.endsWith(':')) return true
  if (/\s#/.test(value)) return true
  return /^(true|false|yes|no|on|off|null|~)$/i.test(value)
}

/** 解码标量：剥外层引号；单引号按 YAML 规则把 `''` 还原为 `'`，双引号只处理 `\X` 转义子集。 */
function decodeScalar(raw: string): string {
  const t = raw.trim()
  const q = t[0]
  if ((q === '"' || q === "'") && t.length >= 2 && t.endsWith(q)) {
    const inner = t.slice(1, -1)
    return q === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\(["\\])/g, '$1')
  }
  return t
}

/**
 * 解析 flow list `[a, 'b, c']`：逐字符扫描、按引号外的逗号切分——简单 split 会把带逗号的
 * 引号值切碎。用 `lastIndexOf(']')` 定右界，容忍闭合括号后的尾部垃圾；非法输入退化为空列表。
 */
function parseFlowList(raw: string): string[] {
  const close = raw.lastIndexOf(']')
  if (close === -1) return []
  const inner = raw.slice(raw.indexOf('[') + 1, close).trim()
  if (inner === '') return []

  const parts: string[] = []
  let current = ''
  let quote: string | null = null
  for (const ch of inner) {
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === ',') {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)

  return parts
    .map((p) => decodeScalar(stripComment(p.trim())))
    .filter((p) => p !== '')
}

/**
 * 按 YAML 的方式剥掉行尾 ` # comment`，但绝不在引号内的值里动手：
 * `title: 'a # b'` 的值是 `a # b` 整体，而不是「标题 + 注释」。
 */
function stripComment(value: string): string {
  const t = value.trim()
  const q = t[0]
  if (q === '"' || q === "'") {
    const close = t.indexOf(q, 1)
    return close === -1 ? t : t.slice(0, close + 1)
  }
  const at = t.search(/\s#/)
  return at === -1 ? t : t.slice(0, at).trim()
}
