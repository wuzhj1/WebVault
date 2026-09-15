import { parseNote } from '../src/core/parse/links.ts'

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

const doc = [
  '---',
  'title: [[FrontmatterLink]]',
  'tags: [a, b]',
  '---',
  '',
  '# 标题一',
  '',
  '正文里链接 [[Redis]] 和别名 [[Redis|缓存三大问题]]。',
  '带标题 [[Redis#持久化]] 和嵌入 ![[图.png]] 和块引用 [[Redis#^abc12]]。',
  '标签 #redis/持久化 与 #面试 出现在这里。',
  '纯数字 #2024 不是标签。',
  '',
  '行内代码 `[[NotALink]]` 与 `#notatag` 应被忽略。',
  '',
  '```md',
  '[[InsideFence]] 和 #fencetag 应被忽略',
  '```',
  '',
  '## 小节 ^blockid',
  '',
  '- 列表项里的 [[ListItem]]',
  '> 引用里的 [[Quoted]]',
].join('\n')

const r = parseNote(doc)

check(
  'link targets',
  r.links.map((l) => l.target),
  ['Redis', 'Redis', 'Redis', '图.png', 'Redis', 'ListItem', 'Quoted'],
)
check(
  'embeds',
  r.links.map((l) => l.embed),
  [false, false, false, true, false, false, false],
)
check('alias', r.links[1].alias, '缓存三大问题')
check('heading', r.links[2].heading, '持久化')
check('blockRef', r.links[4].blockRef, 'abc12')
check('blockRef heading cleared', r.links[4].heading, null)
check('fence excluded', r.links.some((l) => l.target === 'InsideFence'), false)
check('frontmatter excluded', r.links.some((l) => l.target === 'FrontmatterLink'), false)
check('inline code excluded', r.links.some((l) => l.target === 'NotALink'), false)
check('tags', r.tags.map((t) => t.tag).sort(), ['redis/持久化', '面试'])
check('numeric not tag', r.tags.some((t) => t.tag === '2024'), false)
check('fence tag excluded', r.tags.some((t) => t.tag === 'fencetag'), false)
check('inline code tag excluded', r.tags.some((t) => t.tag === 'notatag'), false)
check('wikilink heading not tag', r.tags.some((t) => t.tag === '持久化'), false)
check('headings', r.headings, ['标题一', '小节 ^blockid'])
check('line numbers are real', r.links[0].line, 7)
check('context strips md', r.links[5].context, '列表项里的 ListItem')
check('context shows the alias, not the raw pipe', r.links[1].context, '正文里链接 Redis 和别名 缓存三大问题。')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
