/**
 * Card identity: the permanent id, the filename that carries it, and the row the index keeps.
 *
 * A Zettelkasten rests on the address of a card never changing, so the id lives in the file's
 * frontmatter — the only place that travels to Gitee — and the filename is just appearance. A
 * user may rename `202609151423 卡片盒.md` to `卡片盒.md` and `[[202609151423]]` still resolves.
 *
 * Relative imports only: `scripts/verify-zettel.mts` runs this under plain node with no alias
 * resolver. `../db.ts` is imported for types only — at runtime it constructs Dexie at module
 * scope, which throws outside a browser.
 */
import type { CardRow, TagRow } from '../db.ts'
import { parseFrontmatter, readList, readScalar } from '../parse/frontmatter.ts'
import { parseNote, type ParsedTag } from '../parse/links.ts'
import { joinPath, normalizePath } from '../vault/paths.ts'

export type CardType = 'plain' | 'fleeting' | 'literature' | 'permanent' | 'index'

/**
 * What a user can choose. `plain` is not in the list: it is what a note with no usable metadata
 * reports, never a value written into a file.
 */
export const CARD_TYPES = ['fleeting', 'literature', 'permanent', 'index'] as const

/** Chinese is UI only. Files, indexes and frontmatter stay English: they are the interchange. */
export const CARD_TYPE_LABELS: Record<CardType, string> = {
  plain: '普通',
  fleeting: '闪念',
  literature: '文献',
  permanent: '永久',
  index: '索引',
}

const ZID = /^\d{12}[a-z]{0,3}$/

/** `202609151423`, `202609151423a`. Not `202609151423-1`: a hyphen makes the id two words. */
export function isZid(value: string): boolean {
  return ZID.test(value)
}

export function isCardType(value: string): value is CardType {
  return (CARD_TYPES as readonly string[]).includes(value)
}

/** Local time, not UTC: this records when the author had the thought, not when the server did. */
export function zidStamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`
}

/** `2026-09-15 14:23`. Bare on purpose — see `encodeScalar`, which leaves it unquoted. */
export function createdStamp(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Epoch ms for sorting, or 0 when absent or unparseable so the order stays deterministic.
 * A trailing `Z` or explicit offset means UTC; anything else is the local wall clock the stamp
 * was written against.
 */
export function parseCreated(raw: string): number {
  const text = raw.trim()
  if (text === '') return 0
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const utc = Date.parse(text)
    return Number.isNaN(utc) ? 0 : utc
  }
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/)
  if (!m) return 0
  const local = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
  ).getTime()
  return Number.isNaN(local) ? 0 : local
}

/**
 * The first unused id derived from `base`, using letter suffixes.
 *
 * Letters rather than `-1`/`_2` because a hyphen or underscore reads as a word boundary to
 * `titleOf` and to the resolver, while a letter suffix sorts straight after the bare stamp under
 * `localeCompare(..., { numeric: true })`.
 */
export function nextFreeZid(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let i = 0; i < 30; i++) {
    const candidate = base + letterSuffix(i)
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`一分钟内创建的卡片太多,无法为 ${base} 分配新的 ID`)
}

/** 0 -> a, 25 -> z, 26 -> aa, 27 -> ab. Three letters is far more room than 30 tries needs. */
function letterSuffix(i: number): string {
  let n = i
  let out = ''
  do {
    out = String.fromCharCode(97 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/** The id a filename carries, whether or not the file has frontmatter. Null when it carries none. */
export function zidFromPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
  const m = base.match(/^(\d{12}[a-z]{0,3})(?=$|[ _-])/)
  return m ? m[1] : null
}

/** Characters that would let a title invent a subdirectory, or that no filesystem accepts. */
const FORBIDDEN_TITLE = /[\\/:*?"<>|\u0000-\u001f]/g
const TITLE_MAX_CHARS = 48

/**
 * What the user typed into a tag field, as the list that goes into `tags: [...]`.
 *
 * Accepts both comma widths and plain spaces as separators because neither is obviously wrong to
 * type, and strips a leading `#` since that is how tags are written in prose. Lowercased and
 * deduped to match `mergeTags`, so a tag entered here is byte-identical to one read back later.
 */
export function parseTagList(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[,，\s]+/)) {
    const tag = part.replace(/^#+/, '').trim().toLowerCase()
    if (tag !== '' && !out.includes(tag)) out.push(tag)
  }
  return out
}

/**
 * A title safe to use as a filename.
 *
 * `/` and `\` must go: `normalizePath` only guards against `..` escapes, so without this a title
 * of `a/b` would silently create a folder. Truncation is by code point, never mid-surrogate.
 */
export function sanitizeTitle(raw: string): string {
  const collapsed = raw
    .replace(FORBIDDEN_TITLE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (collapsed === '') throw new Error('标题不能为空,也不能只包含 / \\ : * ? " < > | 等字符')

  const chars = [...collapsed]
  const cut = chars.length > TITLE_MAX_CHARS ? chars.slice(0, TITLE_MAX_CHARS).join('') : collapsed
  const trimmed = cut.replace(/[.\s]+$/, '')
  if (trimmed === '') throw new Error('标题不能为空,也不能只包含 / \\ : * ? " < > | 等字符')
  return trimmed
}

/**
 * `202609151423 卡片盒.md`, or `卡片盒.md` when the id prefix setting is off.
 *
 * The 48-code-point cap in `sanitizeTitle` bounds this at 163 UTF-8 bytes worst case (48 CJK
 * characters plus a 15-character id), comfortably under git's 255-byte path segment limit, so
 * there is no length branch here to test.
 */
export function cardFilename(zid: string, title: string, opts: { idPrefix: boolean }): string {
  const clean = sanitizeTitle(title)
  return opts.idPrefix ? `${zid} ${clean}.md` : `${clean}.md`
}

/** Throws `UnsafePathError` when `dir` tries to escape the vault. */
export function cardPath(dir: string, filename: string): string {
  return normalizePath(joinPath(dir, filename))
}

/**
 * The index row for one note body.
 *
 * Every note gets a row, not just cards: `parsed` is how the resumable backfill knows what it has
 * already read, and "not a card" is only distinguishable from "not read yet" if both have a row.
 * `type: 'plain'` means the note is not a card.
 */
export function cardFromBody(path: string, content: string): CardRow {
  const fm = parseFrontmatter(content)
  const id = readScalar(fm, 'id') ?? ''
  const type = readScalar(fm, 'type') ?? ''
  const createdRaw = readScalar(fm, 'created') ?? ''

  const bodyTags = parseNote(content).tags
  const merged = mergeTags(bodyTags, readList(fm, 'tags'))

  return {
    path,
    // An id that is not a zid is somebody else's identifier. Keep it out of the index rather than
    // let it collide with a real one in the by-zid lookup.
    zid: isZid(id) ? id : '',
    type: isCardType(type) ? type : 'plain',
    created: parseCreated(createdRaw),
    createdRaw,
    aliases: readList(fm, 'aliases'),
    tags: merged,
    parsed: 1,
  }
}

/**
 * Frontmatter tags that the body did not already supply, as extra rows at line 0.
 *
 * Deliberately a separate function rather than a change to `parseNote`: that contract is "scan the
 * prose, skip the frontmatter", and `verify-parse.mts` pins it. Line 0 is the marker for "this tag
 * came from the metadata block, it has no line to jump to".
 */
export function frontmatterTagRows(
  path: string,
  content: string,
  bodyTags: readonly ParsedTag[],
): TagRow[] {
  const fm = parseFrontmatter(content)
  const have = new Set(bodyTags.map((t) => t.tag.toLowerCase()))
  const rows: TagRow[] = []
  const seen = new Set<string>()
  for (const raw of readList(fm, 'tags')) {
    // Frontmatter is an explicit declaration, so `tags: [2024]` counts even though the prose
    // scanner rejects `#2024` for having no non-digit.
    const tag = raw.trim().toLowerCase()
    if (tag === '' || have.has(tag) || seen.has(tag)) continue
    seen.add(tag)
    rows.push({ tag, path, line: 0 })
  }
  return rows
}

/** Body tags keep their order and win the line number; frontmatter tags are appended after. */
function mergeTags(bodyTags: readonly ParsedTag[], fmTags: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of bodyTags) {
    if (t.tag === '' || seen.has(t.tag)) continue
    seen.add(t.tag)
    out.push(t.tag)
  }
  for (const raw of fmTags) {
    const tag = raw.trim().toLowerCase()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}
