import { rewriteWikilinks } from '../src/core/parse/rewrite.ts'
import { buildResolver, resolveTarget, preferredLinkText } from '../src/core/index/resolve.ts'

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

// ---- resolution ----
const notes = [
  { path: 'Redis.md', title: 'Redis' },
  { path: '00-收集箱/AI/Redis 面试.md', title: 'Redis 面试' },
  { path: 'db/Redis.md', title: 'Redis' },
  { path: 'a/b/c/deep.md', title: 'deep' },
].map((n) => ({ ...n, baseSha: null, localSha: null, remoteSha: null, mtime: 0, size: 0, dirty: 0 as const, cached: 1 as const, removedLocal: 0 as const, removedRemote: 0 as const }))

const r = buildResolver(notes)
check('exact path', resolveTarget(r, 'db/Redis.md'), 'db/Redis.md')
check('basename ambiguous -> shortest', resolveTarget(r, 'Redis'), 'Redis.md')
check('basename unique', resolveTarget(r, 'deep'), 'a/b/c/deep.md')
check('case insensitive', resolveTarget(r, 'redis'), 'Redis.md')
check('path without ext', resolveTarget(r, 'db/Redis'), 'db/Redis.md')
check('nested by path', resolveTarget(r, '00-收集箱/AI/Redis 面试'), '00-收集箱/AI/Redis 面试.md')
check('unresolved -> null', resolveTarget(r, '不存在的笔记'), null)
check('attachment -> null', resolveTarget(r, '图.png'), null)
check('empty -> null', resolveTarget(r, ''), null)
check('preferred text unique basename', preferredLinkText(r, 'a/b/c/deep.md'), 'deep')
check('preferred text ambiguous basename', preferredLinkText(r, 'db/Redis.md'), 'db/Redis')

// ---- rewriting ----
const rule = {
  shouldRewrite: (t: string) => t === 'Redis',
  replacement: () => '00-数据库/Redis',
}

const doc = [
  '普通链接 [[Redis]] 结尾。',
  '别名 [[Redis|缓存三大问题]] 保留。',
  '标题 [[Redis#持久化]] 保留。',
  '块引用 [[Redis#^abc12]] 保留。',
  '嵌入 ![[Redis]] 保留感叹号。',
  '同一行两个 [[Redis]] 和 [[Redis|二]]。',
  '不该动 [[Redis 面试]] 与 [[db/Redis]]。',
  '行内代码 `[[Redis]]` 不动。',
  '```',
  '[[Redis]] 在代码块里不动',
  '```',
  '缩进列表:',
  '  - [[Redis]] 项',
].join('\n')

const out = rewriteWikilinks(doc, rule)
const lines = out.text.split('\n')

check('plain', lines[0], '普通链接 [[00-数据库/Redis]] 结尾。')
check('alias kept', lines[1], '别名 [[00-数据库/Redis|缓存三大问题]] 保留。')
check('heading kept', lines[2], '标题 [[00-数据库/Redis#持久化]] 保留。')
check('blockref kept', lines[3], '块引用 [[00-数据库/Redis#^abc12]] 保留。')
check('embed kept', lines[4], '嵌入 ![[00-数据库/Redis]] 保留感叹号。')
check('two on one line', lines[5], '同一行两个 [[00-数据库/Redis]] 和 [[00-数据库/Redis|二]]。')
check('other targets untouched', lines[6], '不该动 [[Redis 面试]] 与 [[db/Redis]]。')
check('inline code untouched', lines[7], '行内代码 `[[Redis]]` 不动。')
check('fence untouched', lines[9], '[[Redis]] 在代码块里不动')
check('indent preserved', lines[12], '  - [[00-数据库/Redis]] 项')
check('change count', out.changed, 8)

const untouched = '没有链接的普通文本\n第二行  **粗体** 与 `代码`。\n'
check(
  'idempotent when nothing matches',
  rewriteWikilinks(untouched, rule).text,
  untouched,
)
check(
  'round-trip fidelity of untouched doc',
  rewriteWikilinks(doc, { shouldRewrite: () => false, replacement: (t) => t }).text,
  doc,
)

// A card's permanent address lives in the metadata block, and so might somebody's own
// `related: [[…]]` key. A rename rewriting either would be a surprise nobody asked for.
const metaDoc = [
  '---',
  'id: 202609151423',
  "related: '[[Redis]]'",
  'tags: [Redis, 缓存]',
  '---',
  '正文 [[Redis]] 要改。',
  '',
].join('\n')
const metaOut = rewriteWikilinks(metaDoc, rule)
check('frontmatter is not prose, so only the body link is rewritten', metaOut.changed, 1)
check('the metadata block keeps its exact bytes through a rename', metaOut.text.split('\n').slice(0, 5).join('\n'), metaDoc.split('\n').slice(0, 5).join('\n'))
check('the permanent id in particular is untouched', metaOut.text.split('\n')[1], 'id: 202609151423')
check('and the body still is', metaOut.text.split('\n')[5], '正文 [[00-数据库/Redis]] 要改。')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
