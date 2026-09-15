/**
 * YAML frontmatter reading and byte-stable patching.
 *
 * This is not a YAML parser and must never become one. Vault files are also edited by other
 * tools, so the contract here is narrower and stronger: recognise the `---` block at the top of
 * a file, read five keys out of it, and write those five keys back without moving one other byte.
 * Unknown keys, comment lines, nesting, quoting style, duplicate keys and blank lines all survive
 * untouched — a rewrite that "tidies up" someone's YAML is a rewrite that silently destroys it,
 * and any stray byte flips `gitBlobSha`, marks the note dirty and widens the merge surface.
 *
 * Two hard rules for this module:
 * - relative imports only. `scripts/verify-zettel.mts` runs it under plain node, no alias resolver.
 * - never import `../db.ts` at runtime; it constructs Dexie at module scope. `import type` is fine.
 */

/** The five keys this app owns. Everything else inside the block is opaque and preserved. */
export const OWNED_KEYS = ['id', 'type', 'created', 'tags', 'aliases'] as const

export type OwnedKey = (typeof OWNED_KEYS)[number]

/** Insertion order for owned keys that do not exist yet. Unknown keys keep their own order. */
export const KEY_ORDER: readonly OwnedKey[] = OWNED_KEYS

const BOM = '\uFEFF'

/**
 * Shared with `links.ts`, which skips the same block when extracting links and tags. The two must
 * agree byte for byte or one parser will treat the other's metadata as prose.
 */
export const FRONTMATTER_DELIM = /^\s{0,3}---\s*$/

/**
 * A top-level `key: value` line. Column 0 only, so nested maps and block-list items stay opaque.
 * Split at the first colon, and require a space or end-of-line after it: that is the YAML rule, and
 * it keeps `title: 'a: b'` whole while refusing to read `tags:[a]` as a mapping.
 */
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.\-/]*):( |$)(.*)$/

/** Indented `- item` continuation of a key whose value is empty, i.e. a YAML block list. */
const BLOCK_ITEM = /^\s+-\s*(.*)$/

export interface FrontmatterEntry {
  key: string
  /** value as written: trailing comment stripped, quotes still on */
  value: string
  /** absolute line index in the document */
  line: number
}

export interface Frontmatter {
  /** true only when line 0 opens a block that a later `---` line closes */
  exists: boolean
  /** line index of the opening `---`, or -1 */
  openLine: number
  /** line index of the closing `---`, or -1 */
  closeLine: number
  /** the lines strictly between the two delimiters, so block lists can be gathered */
  body: string[]
  /** every top-level `key: value` line in file order, duplicates included */
  entries: FrontmatterEntry[]
  /** keys appearing more than once. `writeKeys` refuses to touch these; see `R3` in the plan. */
  duplicates: string[]
}

const NO_FRONTMATTER: Frontmatter = {
  exists: false,
  openLine: -1,
  closeLine: -1,
  body: [],
  entries: [],
  duplicates: [],
}

function stripBom(line: string): string {
  return line.startsWith(BOM) ? line.slice(1) : line
}

/**
 * JS regex treats `\r` as a line terminator, so `.` and `$` both stop before it and no CRLF line
 * would ever match. Parsing strips it; writing does not, so untouched lines keep their bytes.
 */
function bare(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/**
 * Line index of the `---` closing a block opened at line 0, or -1.
 *
 * An unterminated block counts as no block: CommonMark reads a leading `---` with no closer as a
 * thematic break, so the rest of the file is prose. Claiming it as metadata would hide every link
 * in the note and would let `writeKeys` prepend a second block on top of real content.
 */
export function frontmatterEnd(lines: readonly string[]): number {
  if (lines.length === 0 || !FRONTMATTER_DELIM.test(stripBom(lines[0]))) return -1
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIM.test(lines[i])) return i
  }
  return -1
}

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
    duplicates: [...seen].filter(([, n]) => n > 1).map(([k]) => k).sort(),
  }
}

export function hasFrontmatter(text: string): boolean {
  return frontmatterEnd((text.startsWith(BOM) ? text.slice(1) : text).split('\n')) !== -1
}

/** First value of `key` as written, or null. Lists come back as their raw `[a, b]` text. */
export function readRaw(fm: Frontmatter, key: string): string | null {
  const entry = fm.entries.find((e) => e.key === key)
  return entry === undefined ? null : entry.value
}

/**
 * `id`, `type`, `created`. Null when absent, and null when the key holds a list — a caller asking
 * for a scalar should not silently receive `[a, b]`.
 */
export function readScalar(fm: Frontmatter, key: string): string | null {
  const raw = readRaw(fm, key)
  if (raw === null) return null
  const decoded = decodeScalar(raw)
  return decoded.startsWith('[') ? null : decoded
}

/** `tags`, `aliases`. Handles `[]`, `[a, b]`, a bare scalar, and an indented `- item` block. */
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
 * Body indexes of the indented `- item` run belonging to the entry at absolute line `line`.
 * Reading and writing must agree on this, or replacing such a key with a flow list leaves the
 * items behind as orphans and turns the block into invalid YAML.
 */
function blockItems(fm: Frontmatter, line: number): number[] {
  const out: number[] = []
  for (let i = line - fm.openLine; i < fm.body.length; i++) {
    if (!BLOCK_ITEM.test(bare(fm.body[i]))) break
    out.push(i)
  }
  return out
}

export type FrontmatterValue = string | string[]

export type FrontmatterPatch = { [K in OwnedKey]?: FrontmatterValue | null }

/**
 * Returns `text` with `patch` applied, changing as few bytes as possible.
 *
 * - an empty patch is the identity function, for every input;
 * - untouched lines keep their exact bytes, including indentation, quoting and comments;
 * - a key that appears more than once is left alone rather than guessing which one the user meant;
 * - new keys land in `KEY_ORDER` among the owned keys and never reorder the unknown ones;
 * - a file with no block gets one prepended, body unchanged and with no blank line after the
 *   closing `---` (Lute eats that blank line, so emitting it would guarantee a phantom diff on
 *   the note's first save).
 *
 * Two deliberate exceptions, both confined to lines the caller asked to change:
 * - writing a key that holds an indented `- item` list rewrites it as a flow list and deletes the
 *   items. Keeping them would orphan the list under the previous key and break the YAML.
 * - written lines end in `\n`, so a CRLF file keeps its `\r` only on untouched lines. Lute
 *   normalizes the whole file to LF the next time the note is saved anyway.
 */
export function writeKeys(text: string, patch: FrontmatterPatch): string {
  const requested = OWNED_KEYS.filter((k) => k in patch)
  if (requested.length === 0) return text

  const bom = text.startsWith(BOM)
  const lines = (bom ? text.slice(1) : text).split('\n')
  const fm = parseFrontmatter(text)

  // A duplicated key is what a three-way merge inside the block looks like. Rewriting either copy
  // would make the file worse than it already is, so the caller gets its other keys and a warning.
  const wanted = requested.filter((k) => patch[k] !== null && !fm.duplicates.includes(k))
  const removals = requested.filter((k) => patch[k] === null && !fm.duplicates.includes(k))
  if (wanted.length === 0 && removals.length === 0) return text

  if (!fm.exists) {
    const block = ['---', ...wanted.map((k) => renderEntry(k, patch[k] as FrontmatterValue)), '---']
    return join(bom, [...block, ...lines])
  }

  const bodyStart = fm.openLine + 1
  const existing = new Map<string, number>()
  for (const e of fm.entries) if (!existing.has(e.key)) existing.set(e.key, e.line)

  const rewritten = new Map<number, string>()
  const removed = new Set<number>()
  const dropped = new Set<number>()
  for (const key of [...wanted, ...removals]) {
    const at = existing.get(key)
    if (at === undefined) continue
    if (patch[key] === null) removed.add(at)
    else rewritten.set(at, renderEntry(key, patch[key] as FrontmatterValue))
    for (const i of blockItems(fm, at)) dropped.add(i + fm.openLine + 1)
  }

  const inserts = wanted.filter((k) => !existing.has(k))
  const insertedAt = new Map<number, string[]>()
  for (const key of inserts) {
    const line = renderEntry(key, patch[key] as FrontmatterValue)
    const at = insertBefore(fm, key)
    const bucket = insertedAt.get(at)
    if (bucket) bucket.push(line)
    else insertedAt.set(at, [line])
  }

  const out: string[] = [lines[fm.openLine]]
  for (let i = bodyStart; i < fm.closeLine; i++) {
    const extra = insertedAt.get(i)
    if (extra) out.push(...extra)
    if (removed.has(i) || dropped.has(i)) continue
    out.push(rewritten.get(i) ?? lines[i])
  }
  const tail = insertedAt.get(fm.closeLine)
  if (tail) out.push(...tail)
  out.push(...lines.slice(fm.closeLine))

  return join(bom, out)
}

/**
 * Where a brand new owned key goes: just before the first owned key that sorts after it in
 * `KEY_ORDER`, otherwise at the end of the block. Landing at the end keeps it clear of any
 * indented `- item` lines that belong to the last entry.
 */
function insertBefore(fm: Frontmatter, key: OwnedKey): number {
  const rank = KEY_ORDER.indexOf(key)
  for (const e of fm.entries) {
    if (KEY_ORDER.indexOf(e.key as OwnedKey) > rank) return e.line
  }
  return fm.closeLine
}

function renderEntry(key: OwnedKey, value: FrontmatterValue): string {
  return `${key}: ${Array.isArray(value) ? encodeList(value) : encodeScalar(value)}`
}

function join(bom: boolean, lines: string[]): string {
  const text = lines.join('\n')
  return bom ? BOM + text : text
}

/** Quote only when the bare form would change the value's meaning under YAML. */
export function encodeScalar(value: string): string {
  return needsQuotes(value) ? `'${value.replace(/'/g, "''")}'` : value
}

export function encodeList(items: readonly string[]): string {
  if (items.length === 0) return '[]'
  return `[${items.map(encodeScalar).join(', ')}]`
}

function needsQuotes(value: string): boolean {
  if (value === '') return true
  if (value !== value.trim()) return true
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return true
  if (/:\s/.test(value) || value.endsWith(':')) return true
  if (/\s#/.test(value)) return true
  return /^(true|false|yes|no|on|off|null|~)$/i.test(value)
}

function decodeScalar(raw: string): string {
  const t = raw.trim()
  const q = t[0]
  if ((q === '"' || q === "'") && t.length >= 2 && t.endsWith(q)) {
    const inner = t.slice(1, -1)
    return q === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\(["\\])/g, '$1')
  }
  return t
}

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
 * Drops a trailing ` # comment` the way YAML does, but never inside a quoted value:
 * `title: 'a # b'` is a title, not a title and a comment.
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

/**
 * True when a save is about to erase a note's identity: `prev` carried a frontmatter block and
 * `next` does not, while `next` still has content. A blank `next` means the user cleared the
 * document on purpose, which is not corruption and must not be blocked.
 *
 * Cheap by design — this runs on every `saveBody`.
 */
export function frontmatterLostGuard(prev: string, next: string): boolean {
  if (next.trim() === '') return false
  return hasFrontmatter(prev) && !hasFrontmatter(next)
}
