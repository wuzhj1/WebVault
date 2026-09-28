/**
 * 双链改写验证（src/core/parse/rewrite.ts 与 src/core/index/resolve.ts）：
 * - resolution：把 [[链接文本]] 解析成索引里的实际路径，以及反向选出展示用的链接文本；
 * - rewriting：改名时重写正文中的目标链接，修饰成分与受限上下文（行内代码、代码块、frontmatter）
 *   必须原样保留，且整个过程幂等、无损。
 *
 * 运行：pnpm verify（第 4 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import { rewriteWikilinks } from '../src/core/parse/rewrite.ts'
import { buildResolver, resolveTarget, preferredLinkText } from '../src/core/index/resolve.ts'

let pass = 0
let fail = 0

/** 用 JSON 序列化后比较，失败时打印 expected/actual 差异。 */
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

// ---- resolution：把链接文本解析成索引里的实际路径，解析不出的一律返回 null ----
const notes = [
  { path: 'Redis.md', title: 'Redis' },
  { path: '00-收集箱/AI/Redis 面试.md', title: 'Redis 面试' },
  { path: 'db/Redis.md', title: 'Redis' },
  { path: 'a/b/c/deep.md', title: 'deep' },
].map((n) => ({ ...n, baseSha: null, localSha: null, remoteSha: null, mtime: 0, size: 0, dirty: 0 as const, cached: 1 as const, removedLocal: 0 as const, removedRemote: 0 as const }))

const r = buildResolver(notes)
// 各种链接写法 → 规范路径：精确路径优先，文件名歧义时取路径最短者，大小写不敏感，可省略扩展名
check('exact path', resolveTarget(r, 'db/Redis.md'), 'db/Redis.md')
check('basename ambiguous -> shortest', resolveTarget(r, 'Redis'), 'Redis.md')
check('basename unique', resolveTarget(r, 'deep'), 'a/b/c/deep.md')
check('case insensitive', resolveTarget(r, 'redis'), 'Redis.md')
check('path without ext', resolveTarget(r, 'db/Redis'), 'db/Redis.md')
check('nested by path', resolveTarget(r, '00-收集箱/AI/Redis 面试'), '00-收集箱/AI/Redis 面试.md')
// 解析不出的一律 null：悬空链接、附件、空串都不进解析结果
check('unresolved -> null', resolveTarget(r, '不存在的笔记'), null)
check('attachment -> null', resolveTarget(r, '图.png'), null)
check('empty -> null', resolveTarget(r, ''), null)
// 反向选词：文件名唯一就只写文件名，歧义时补上目录层级，保证链接指向唯一目标
check('preferred text unique basename', preferredLinkText(r, 'a/b/c/deep.md'), 'deep')
check('preferred text ambiguous basename', preferredLinkText(r, 'db/Redis.md'), 'db/Redis')

// ---- rewriting：改名时按规则重写正文里的 [[Redis]]，但只重写它 ----
// 规则刻意收窄：只有目标恰好是 Redis 的链接才改
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

// 逐行核对：命中的目标被换成新路径，而 |别名、#标题、#^块引用、前导 ! 全部原样保留
const out = rewriteWikilinks(doc, rule)
const lines = out.text.split('\n')

// 不该动的一律不动：别的目标、行内代码、围栏里的链接、缩进；changed 恰好等于命中次数
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

// 幂等与无损：没有匹配时逐字节不变；shouldRewrite 全 false 时往返后必须还原原文，
// 否则每次改名都会给没动过的笔记留下无谓 diff
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

// 卡片的永久地址写在元数据块里，用户自己的 `related: [[…]]` 键也可能带链接。
// 改名时若把它们一起重写，就是没人要求过的意外改动。
const metaDoc = [
  '---',
  'id: 202609151423',
  "related: '[[Redis]]'",
  'tags: [Redis, 缓存]',
  '---',
  '正文 [[Redis]] 要改。',
  '',
].join('\n')
// 因此 frontmatter 不是正文：只改正文那一处，元数据块（含 id 与 related）逐字节保留
const metaOut = rewriteWikilinks(metaDoc, rule)
check('frontmatter is not prose, so only the body link is rewritten', metaOut.changed, 1)
check('the metadata block keeps its exact bytes through a rename', metaOut.text.split('\n').slice(0, 5).join('\n'), metaDoc.split('\n').slice(0, 5).join('\n'))
check('the permanent id in particular is untouched', metaOut.text.split('\n')[1], 'id: 202609151423')
check('and the body still is', metaOut.text.split('\n')[5], '正文 [[00-数据库/Redis]] 要改。')

// 汇总：任一断言失败即以非 0 退出
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
