/**
 * Frontmatter gate: parsing, byte-stable patching, legacy card-id extraction, filename
 * sanitizing, id-aware link resolution and the save guard.
 *
 * 卡片盒 UI 已整体移除，但旧文件里的 id/type/created/tags 仍是 `[[id]]` 链接与标签索引的
 * 数据源，所以这里守护的全部是「链接层兼容」：解析必须认得旧 frontmatter，patching 绝不能多
 * 翻一个字节，resolver 必须继续按 zid 分桶。
 *
 * The load-bearing group is B. A note's frontmatter is its permanent address, it is written into
 * files that get pushed to Gitee, and any stray byte flips `gitBlobSha`, marks the note dirty and
 * widens the three-way merge surface. So the assertions are about bytes, not about shapes.
 */
import { parseNote } from '../src/core/parse/links.ts'
import {
  KEY_ORDER,
  OWNED_KEYS,
  encodeList,
  encodeScalar,
  frontmatterLostGuard,
  hasFrontmatter,
  parseFrontmatter,
  readList,
  readRaw,
  readScalar,
  writeKeys,
} from '../src/core/parse/frontmatter.ts'
import type { NoteMeta } from '../src/core/db.ts'
import { cardFromBody, frontmatterTagRows, isZid, parseCreated } from '../src/core/zettel/card.ts'
import { buildResolver, preferredLinkText, resolveTarget } from '../src/core/index/resolve.ts'
import { cardPath, sanitizeTitle, titleOf } from '../src/core/vault/paths.ts'

let pass = 0
let fail = 0

function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`)
  }
}

/** Number of line positions where two texts differ. 0 means byte-identical. */
function diffLines(a: string, b: string): number {
  const x = a.split('\n')
  const y = b.split('\n')
  if (x.length !== y.length) return Math.max(x.length, y.length)
  let n = 0
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++
  return n
}

const fm = (keys: string[], body = '# 标题\n\n正文。\n') => `---\n${keys.join('\n')}\n---\n${body}`

const FIVE = ['id: 202609151423', 'type: fleeting', 'created: 2026-09-15 14:23', 'tags: [卡片盒, 笔记法]', 'aliases: [Zettelkasten]']

const fixtures: Record<string, string> = {
  five: fm(FIVE),
  emptyBlock: '---\n---\n# 标题\n\n正文。\n',
  luteEmptyBlock: '---\n\n\n---\n# 标题\n\n正文。\n',
  noFrontmatter: '# 标题\n\n正文。\n',
  unterminated: '---\nid: 202609151423\n# 标题\n\n正文里的 [[链接]]。\n',
  bodyHrOnly: '# 标题\n\n---\n\nfoo: 1\n\n---\n\n正文。\n',
  unknownAndComment: '---\nslug: my-card\n# 这是注释\ncssclasses: wide\nid: 202609151423\n---\n# 标题\n',
  blockList: '---\nid: 202609151423\naliases:\n  - Zettelkasten\n  - 卡片盒\n---\n# 标题\n',
  quotedColon: "---\nid: 202609151423\ntitle: 'a: b'\n---\n# 标题\n",
  nestedMap: '---\nauthor:\n  name: wuzhj\nid: 202609151423\n---\n# 标题\n',
  duplicateKey: '---\nid: 202609151423\nid: 202609151424\n---\n# 标题\n',
  crlf: fm(FIVE).replace(/\n/g, '\r\n'),
  bom: '\uFEFF' + fm(FIVE),
  trailingComment: '---\nid: 202609151423 # 卡片地址\ntype: fleeting\n---\n# 标题\n',
  bareScalarList: '---\ntags: 单值\n---\n# 标题\n',
}

// --------------------------------------------------------------------------- A. parsing

console.log('A. parsing')

const none = parseFrontmatter(fixtures.noFrontmatter)
check('A1 no frontmatter -> exists false', none.exists, false)
check('A1 no frontmatter -> no line numbers', [none.openLine, none.closeLine], [-1, -1])
check('A1 no frontmatter -> no entries', none.entries, [])

const unterminated = parseFrontmatter(fixtures.unterminated)
check('A2 unterminated block is not a block', unterminated.exists, false)
// The point of A2: links.ts must agree, otherwise it hides the whole note while this parser
// thinks there is prose to patch.
check('A2 links.ts agrees, the body is prose', parseNote(fixtures.unterminated).links.map((l) => l.target), ['链接'])

const bodyHr = parseFrontmatter(fixtures.bodyHrOnly)
check('A3 only line 0 can open a block', bodyHr.exists, false)
check('A3 body --- pairs are not metadata', bodyHr.entries, [])

const empty = parseFrontmatter(fixtures.emptyBlock)
check('A4 empty block exists', [empty.exists, empty.closeLine], [true, 1])
check('A4 empty block has no entries', empty.entries, [])
check('A5 the block Lute leaves behind also parses', parseFrontmatter(fixtures.luteEmptyBlock).entries, [])

check('A6 split at the first colon only', readRaw(parseFrontmatter(fixtures.quotedColon), 'title'), "'a: b'")
check('A6 quoted value decodes whole', readScalar(parseFrontmatter("---\ntitle: 'a: b'\n---\nx\n"), 'title'), 'a: b')

const commented = parseFrontmatter(fixtures.trailingComment)
check('A7 trailing comment is stripped for reading', readScalar(commented, 'id'), '202609151423')
check('A7 trailing comment survives in the bytes', writeKeys(fixtures.trailingComment, { type: 'permanent' }).includes('# 卡片地址'), true)

check('A8 inline flow list', readList(parseFrontmatter(fixtures.five), 'tags'), ['卡片盒', '笔记法'])
check('A8 empty flow list', readList(parseFrontmatter('---\ntags: []\n---\nx\n'), 'tags'), [])
check('A9 block list', readList(parseFrontmatter(fixtures.blockList), 'aliases'), ['Zettelkasten', '卡片盒'])
check('A9 bare scalar reads as a one-item list', readList(parseFrontmatter(fixtures.bareScalarList), 'tags'), ['单值'])

check('A10 unknown keys are entries too', parseFrontmatter(fixtures.unknownAndComment).entries.map((e) => e.key), ['slug', 'cssclasses', 'id'])
check('A10 a standalone comment line is not a key', parseFrontmatter(fixtures.unknownAndComment).entries.some((e) => e.key === '#'), false)

const dup = parseFrontmatter(fixtures.duplicateKey)
check('A11 duplicate key reported', dup.duplicates, ['id'])
check('A11 readScalar takes the first', readScalar(dup, 'id'), '202609151423')

const nested = parseFrontmatter(fixtures.nestedMap)
check('A12 indented keys stay opaque', nested.entries.map((e) => e.key), ['author', 'id'])
check('A12 nested value reads as empty', readRaw(nested, 'author'), '')

check('A13 BOM does not hide the block', parseFrontmatter(fixtures.bom).exists, true)
check('A13 BOM value has no BOM', readScalar(parseFrontmatter(fixtures.bom), 'id'), '202609151423')
check('A14 CRLF block detected', parseFrontmatter(fixtures.crlf).exists, true)
check('A14 CRLF value carries no \\r', readScalar(parseFrontmatter(fixtures.crlf), 'id'), '202609151423')
check('A15 hasFrontmatter matches parseFrontmatter', Object.entries(fixtures).map(([k, v]) => [k, hasFrontmatter(v), parseFrontmatter(v).exists]), Object.entries(fixtures).map(([k, v]) => [k, parseFrontmatter(v).exists, parseFrontmatter(v).exists]))

// ------------------------------------------------------------------- B. byte stability

console.log('B. byte stability')

check('B1 an empty patch is the identity, for every fixture', Object.keys(fixtures).filter((k) => writeKeys(fixtures[k], {}) !== fixtures[k]), [])

/** The patch the store actually builds: scalars for id/type/created, lists for tags/aliases. */
function faithfulPatch(text: string): Record<string, string | string[]> {
  const p = parseFrontmatter(text)
  const patch: Record<string, string | string[]> = {}
  for (const key of ['id', 'type', 'created'] as const) {
    const v = readScalar(p, key)
    if (v !== null) patch[key] = v
  }
  for (const key of ['tags', 'aliases'] as const) {
    const v = readList(p, key)
    if (v.length > 0) patch[key] = v
  }
  return patch
}

/** The four fixtures where writing a key deliberately re-encodes it; asserted one by one below. */
const REENCODED = ['trailingComment', 'blockList', 'bareScalarList', 'crlf']

check(
  'B2 reading a value and writing it back changes nothing',
  Object.keys(fixtures)
    .filter((k) => !REENCODED.includes(k))
    .filter((k) => writeKeys(fixtures[k], faithfulPatch(fixtures[k])) !== fixtures[k]),
  [],
)

const flowified = writeKeys(fixtures.blockList, { aliases: ['Zettelkasten', '卡片盒'] })
check('B2b a block list becomes a flow list and its items go with it', flowified, '---\nid: 202609151423\naliases: [Zettelkasten, 卡片盒]\n---\n# 标题\n')
check('B2b and reads back as the same list', readList(parseFrontmatter(flowified), 'aliases'), ['Zettelkasten', '卡片盒'])
check('B2b removing a block-list key takes its items too', writeKeys(fixtures.blockList, { aliases: null }), '---\nid: 202609151423\n---\n# 标题\n')
check("B2b writing a key drops that line's trailing comment and nothing else", writeKeys(fixtures.trailingComment, { id: '202609151423' }), '---\nid: 202609151423\ntype: fleeting\n---\n# 标题\n')
check('B2b a bare scalar becomes a one-item flow list', writeKeys(fixtures.bareScalarList, { tags: ['单值'] }), '---\ntags: [单值]\n---\n# 标题\n')
check('B2b a touched CRLF line loses its \\r while its neighbours keep it', writeKeys(fixtures.crlf, { type: 'index' }).split('\n').slice(0, 4), ['---\r', 'id: 202609151423\r', 'type: index', 'created: 2026-09-15 14:23\r'])

const changed = writeKeys(fixtures.five, { type: 'permanent' })
check('B3 changing one key touches exactly one line', diffLines(fixtures.five, changed), 1)
check('B3 and it is the right line', changed.split('\n')[2], 'type: permanent')

const unknownBefore = fixtures.unknownAndComment
const unknownAfter = writeKeys(unknownBefore, { type: 'index' })
check('B4 unknown keys keep their exact bytes and line numbers', [unknownAfter.split('\n')[1], unknownAfter.split('\n')[2], unknownAfter.split('\n')[3]], ['slug: my-card', '# 这是注释', 'cssclasses: wide'])
check('B4 the new key lands after them, in KEY_ORDER', unknownAfter.split('\n').slice(0, 7), ['---', 'slug: my-card', '# 这是注释', 'cssclasses: wide', 'id: 202609151423', 'type: index', '---'])

const blankBody = writeKeys('---\nid: 1\n---\n# T\n', {})
check('B5 a standalone comment line inside the block survives', writeKeys('---\n# 顶部注释\nid: 1\n---\n# T\n', { type: 'index' }).split('\n')[1], '# 顶部注释')
check('B5 untouched block text is returned verbatim', blankBody, '---\nid: 1\n---\n# T\n')

check('B6 inserts follow KEY_ORDER', writeKeys('---\ntags: [a]\n---\n# T\n', { aliases: ['b'], id: '202609151423', created: '2026-09-15 14:23' }).split('\n').slice(0, 7), ['---', 'id: 202609151423', 'created: 2026-09-15 14:23', 'tags: [a]', 'aliases: [b]', '---', '# T'])
check('B7 an insert never reorders unknown keys', writeKeys('---\nzzz: 1\ntype: fleeting\naaa: 2\n---\n# T\n', { id: '9' }).split('\n').slice(0, 6), ['---', 'zzz: 1', 'id: 9', 'type: fleeting', 'aaa: 2', '---'])

const prepended = writeKeys('# 标题\n\n正文里的 [[链接]]。\n', { id: '202609151423', type: 'permanent' })
check('B8 a file with no block gets one prepended', prepended, '---\nid: 202609151423\ntype: permanent\n---\n# 标题\n\n正文里的 [[链接]]。\n')
check('B8 no blank line after the closing --- (Lute would eat it, guaranteeing a phantom diff)', prepended.split('\n')[3], '---')

check('B9 patching is idempotent', writeKeys(changed, { type: 'permanent' }), changed)
check('B9 prepending is idempotent', writeKeys(prepended, { id: '202609151423', type: 'permanent' }), prepended)

// `2026-09-15 14:23` 刻意不加引号：忠实回写是比「YAML 类型纯净」更硬的合同——writeKeys 对 patch
// 里的每个键总是重渲染该行，旧文件里的 created 全是裸时间戳，encodeScalar 若给它加引号，
// 「读回再写」就会改动那一行，B2 的零 diff 立刻破掉，每篇笔记每次保存都会产生无谓的脏 diff。
check('B10 encodeScalar quotes only what YAML would misread', ['a: b', 'plain', '', '#tag', 'true', '2026-09-15 14:23', '202609151423', '卡片盒', ' lead', "it's", "a: it's"].map(encodeScalar), ["'a: b'", 'plain', "''", "'#tag'", "'true'", '2026-09-15 14:23', '202609151423', '卡片盒', "' lead'", "it's", "'a: it''s'"])
check('B11 encodeList', [[], ['x'], ['x', 'y'], ['a: b']].map(encodeList), ['[]', '[x]', '[x, y]', "['a: b']"])

const body = '# 标题\n\n正文 [[Redis]] 与 #标签。\n\n```md\n[[Fenced]]\n```\n'
const withMeta = fm(['id: 202609151423', 'title: [[FrontmatterLink]]', 'tags: [a, b]'], body)
check('B12 writing metadata never creates or destroys a body link', parseNote(writeKeys(withMeta, { type: 'index' })).links.map((l) => l.target), parseNote(withMeta).links.map((l) => l.target))
check('B12 nor a body tag', parseNote(writeKeys(withMeta, { type: 'index' })).tags.map((t) => t.tag), parseNote(withMeta).tags.map((t) => t.tag))
check('B12 inserting a new key pushes the body down by exactly one line', parseNote(writeKeys(withMeta, { type: 'index' })).tags[0].line - parseNote(withMeta).tags[0].line, 1)
check('B12 nor a heading', parseNote(writeKeys(withMeta, { type: 'index' })).headings, parseNote(withMeta).headings)
check('B12 frontmatter links stay out of the graph', parseNote(withMeta).links.some((l) => l.target === 'FrontmatterLink'), false)
const created = writeKeys(body, { id: '202609151423', type: 'index' })
check('B12 prepending shifts line numbers but not the link set', parseNote(created).links.map((l) => l.target), parseNote(body).links.map((l) => l.target))
check('B12 prepending shifts line numbers by the block height', parseNote(created).links[0].line - parseNote(body).links[0].line, 4)

check('B13 a duplicated key is refused, not guessed', writeKeys(fixtures.duplicateKey, { id: '999' }), fixtures.duplicateKey)
check('B13 other keys in the same block still get written', writeKeys(fixtures.duplicateKey, { id: '999', type: 'index' }).split('\n')[3], 'type: index')
check('B14 a BOM survives patching', writeKeys(fixtures.bom, { type: 'index' }).startsWith('\uFEFF---\n'), true)

// ------------------------------------------------------------------------- C. tag merging

console.log('C. tag merging')

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

const tagBody = '# 标题\n\n正文 #卡片盒 与 #笔记法/流派。\n'
const tagged = fm(['id: 202609151423', 'type: permanent', 'created: 2026-09-15 14:23', 'tags: [卡片盒, 卢曼]'], tagBody)
const taggedParsed = parseNote(tagged)

check('C1 body and frontmatter tags merge, deduped, body order first', cardFromBody('z/卡片盒.md', tagged).tags, ['卡片盒', '笔记法/流派', '卢曼'])
check('C2 a frontmatter-only tag lands at line 0, meaning "no line to jump to"', frontmatterTagRows('z/卡片盒.md', tagged, taggedParsed.tags).map((t) => [t.tag, t.line]), [['卢曼', 0]])
check('C2 and one the body already had is not emitted twice', frontmatterTagRows('z/卡片盒.md', tagged, taggedParsed.tags).some((t) => t.tag === '卡片盒'), false)
check('C3 a nested tag keeps its slash', cardFromBody('a.md', fm(['tags: [x/y]'], tagBody)).tags, ['卡片盒', '笔记法/流派', 'x/y'])
check('C3 frontmatter declares a numeric tag the prose scanner refuses', [cardFromBody('a.md', fm(['tags: [2024]'], '# t\n\n#2024\n')).tags, parseNote('# t\n\n#2024\n').tags.map((t) => t.tag)], [['2024'], []])
check('C4 a note with no block keeps only its body tags', cardFromBody('a.md', tagBody), { path: 'a.md', zid: '', type: 'plain', created: 0, createdRaw: '', aliases: [], tags: ['卡片盒', '笔记法/流派'], parsed: 1 })
check('C5 the whole row, keys in the order they are written', cardFromBody('z/卡片盒.md', tagged), { path: 'z/卡片盒.md', zid: '202609151423', type: 'permanent', created: parseCreated('2026-09-15 14:23'), createdRaw: '2026-09-15 14:23', aliases: [], tags: ['卡片盒', '笔记法/流派', '卢曼'], parsed: 1 })
check('C5 an id that is not a zid is somebody else\'s identifier and stays out', cardFromBody('a.md', fm(['id: my-own-slug', 'type: permanent'], tagBody)).zid, '')
check('C5 an unrecognized type reads as plain rather than being guessed at', cardFromBody('a.md', fm(['type: moc'], tagBody)).type, 'plain')
check('C5 aliases come back as written', cardFromBody('a.md', fm(['aliases: [Zettelkasten, 卡片盒笔记法]'], tagBody)).aliases, ['Zettelkasten', '卡片盒笔记法'])

// ------------------------------------------------------------------------- D. ids

console.log('D. ids')

const at = new Date(2026, 8, 15, 14, 23)
check('D1 parseCreated reads a local wall-clock stamp back', parseCreated('2026-09-15 14:23'), at.getTime())
check('D1 a trailing Z means UTC', parseCreated('2026-09-15T14:23:00Z'), Date.UTC(2026, 8, 15, 14, 23))
check('D1 absent or unparseable is 0, never NaN, so ordering stays total', [parseCreated(''), parseCreated('昨天'), parseCreated('2026')], [0, 0, 0])
check('D2 isZid boundaries', ['202609151423', '202609151423a', '202609151423abc', '202609151423abcd', '20260915142', '2026091514231', '202609151423-1', '202609151423_1', ''].map(isZid), [true, true, true, false, false, false, false, false, false])

// ------------------------------------------------------------------------- E. filenames

console.log('E. filenames')

check('E1 a separator that would invent a directory becomes a space', ['a/b', 'a\\b', '../etc/passwd'].map(sanitizeTitle), ['a b', 'a b', 'etc passwd'])
check('E1 leading and trailing dots and spaces go', ['  x  ', '..x', 'x.', '.x.'].map(sanitizeTitle), ['x', 'x', 'x', 'x'])
check('E1 characters no filesystem accepts become a space', sanitizeTitle('a:b*c?d"e<f>g|h'), 'a b c d e f g h')
check('E1 control characters and newlines become a space', sanitizeTitle('a\nb\tc\0d'), 'a b c d')
check('E2 truncation is by code point, at 48', Array.from(sanitizeTitle('汉'.repeat(60))).length, 48)
const emojiTitle = sanitizeTitle('汉'.repeat(47) + '🙂🙂🙂')
check('E2 and never cuts a surrogate pair in half', [Array.from(emojiTitle).length, /\p{Surrogate}/u.test(emojiTitle)], [48, false])
check('E2 an all-illegal title is refused rather than producing a bare .md', throws(() => sanitizeTitle('///')), true)
check('E2 and so is an empty one', throws(() => sanitizeTitle('   ')), true)
check('E3 the path cannot escape the vault', throws(() => cardPath('../etc', 'a.md')), true)
check('E3 a directory joins, and an empty one is the vault root', [cardPath('notes/卡片盒', 'a.md'), cardPath('', 'a.md')], ['notes/卡片盒/a.md', 'a.md'])

// ------------------------------------------------------------------------- F. id resolution

console.log('F. id resolution')

function note(path: string, extra: Partial<NoteMeta> = {}): NoteMeta {
  return {
    path,
    title: titleOf(path),
    baseSha: null,
    localSha: null,
    remoteSha: null,
    mtime: 0,
    size: 0,
    dirty: 0,
    cached: 1,
    removedLocal: 0,
    removedRemote: 0,
    ...extra,
  }
}

const plain = [note('notes/Redis.md'), note('notes/deep/Redis.md'), note('README.md')]
check('F1 a resolver built without cards behaves exactly as it did before', [resolveTarget(buildResolver(plain), 'notes/Redis.md'), resolveTarget(buildResolver(plain), 'redis'), resolveTarget(buildResolver(plain), 'readme')], ['notes/Redis.md', 'notes/Redis.md', 'README.md'])
check('F1 and still returns null for a dangling link', resolveTarget(buildResolver(plain), '不存在'), null)

const cardNotes = [...plain, note('z/卡片盒.md')]
const withCards = buildResolver(cardNotes, [{ path: 'z/卡片盒.md', zid: '202609151423' }, { path: 'z/空.md', zid: '' }])
check('F2 an id resolves to its card', resolveTarget(withCards, '202609151423'), 'z/卡片盒.md')
check('F2 only a complete one: no prefix matching', [resolveTarget(withCards, '2026'), resolveTarget(withCards, '20260915142'), resolveTarget(withCards, '2026091514231')], [null, null, null])
check('F2 an empty id is never indexed', withCards.byZid.has(''), false)

check('F3 a note really named after the id wins on its own path', resolveTarget(buildResolver([note('202609151423.md'), note('z/卡片盒.md')], [{ path: 'z/卡片盒.md', zid: '202609151423' }]), '202609151423'), '202609151423.md')
check('F4 a tombstone keeps its id out of the index', resolveTarget(buildResolver([note('z/卡片盒.md', { removedLocal: 1 })], [{ path: 'z/卡片盒.md', zid: '202609151423' }]), '202609151423'), null)
check('F5 two files claiming one id give the same answer whichever order they arrive in', [resolveTarget(buildResolver([note('b/卡片盒.md'), note('a/卡片盒.md')], [{ path: 'b/卡片盒.md', zid: '202609151423' }, { path: 'a/卡片盒.md', zid: '202609151423' }]), '202609151423'), resolveTarget(buildResolver([note('a/卡片盒.md'), note('b/卡片盒.md')], [{ path: 'a/卡片盒.md', zid: '202609151423' }, { path: 'b/卡片盒.md', zid: '202609151423' }]), '202609151423')], ['a/卡片盒.md', 'a/卡片盒.md'])
check('F6 preferredLinkText never writes an id into a link', preferredLinkText(withCards, 'z/卡片盒.md'), '卡片盒')
check('F6 even when the title is ambiguous and it has to fall back to the path', preferredLinkText(buildResolver([note('a/卡片盒.md'), note('b/卡片盒.md')], [{ path: 'a/卡片盒.md', zid: '202609151423' }]), 'a/卡片盒.md'), 'a/卡片盒')

check('F7 titleOf keeps the id out of every label in the UI', [titleOf('z/202609151423 卡片盒.md'), titleOf('202609151423a-卡片盒.md'), titleOf('卡片盒.md')], ['卡片盒', '卡片盒', '卡片盒'])
check('F7 and leaves an existing note alone, including one named after a bare stamp', [titleOf('notes/Redis.md'), titleOf('2026.md'), titleOf('202609151423.md')], ['Redis', '2026', '202609151423'])
const prefixedNote = buildResolver([note('z/202609151423 卡片盒.md')])
check('F7 so a clean link and a prefixed one reach the same note', [resolveTarget(prefixedNote, '卡片盒'), resolveTarget(prefixedNote, '202609151423 卡片盒')], ['z/202609151423 卡片盒.md', 'z/202609151423 卡片盒.md'])

// ------------------------------------------------------------------------- G. save guard

console.log('G. save guard')

check('G1 losing the block is caught', frontmatterLostGuard('---\nid: x\n---\nbody', 'body'), true)
check('G2 no block -> no block is fine', frontmatterLostGuard('plain body', 'plain body edited'), false)
check('G3 block -> block is fine', frontmatterLostGuard('---\nid: x\n---\nbody', '---\nid: x\ntype: index\n---\nbody'), false)
check('G4 clearing the document on purpose is not caught', frontmatterLostGuard('---\nid: x\n---\nbody', ''), false)
check('G4 nor is clearing it to whitespace', frontmatterLostGuard('---\nid: x\n---\nbody', '   \n'), false)
check('G5 an unterminated block was never an identity to lose', frontmatterLostGuard('---\nid: x\nbody', 'body'), false)
check('G6 KEY_ORDER owns exactly the documented keys', [...KEY_ORDER], ['id', 'type', 'created', 'tags', 'aliases'])
check('G6 and no title key (it would go stale on every rename)', OWNED_KEYS.includes('title' as never), false)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
