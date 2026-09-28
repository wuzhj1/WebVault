/**
 * 链接与标签解析验证（src/core/parse/links.ts）：parseNote 从整篇文档提取 wiki 链接
 * （目标、别名、#标题、#^块引用、!嵌入）、行内 #标签与标题行，并且必须正确跳过
 * frontmatter、行内代码和围栏代码块——这些地方的链接/标签不是笔记间的引用，进了索引就是脏数据。
 *
 * 运行：pnpm verify（第 2 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import { parseNote } from '../src/core/parse/links.ts'

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

// 样本文档：刻意混入各种写法（别名/标题/块引用/嵌入、列表与引用里的链接），
// 以及必须被忽略的干扰项（frontmatter 链接、行内代码、围栏里的链接与标签、纯数字标签）
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

// ---- 链接：按出现顺序给出目标，并标记哪一条是嵌入 ----
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
// 三种修饰各自落到对应字段；块引用会顶掉 #标题（两者不会同时存在）
check('alias', r.links[1].alias, '缓存三大问题')
check('heading', r.links[2].heading, '持久化')
check('blockRef', r.links[4].blockRef, 'abc12')
check('blockRef heading cleared', r.links[4].heading, null)
// 三类上下文必须被排除：围栏代码块、frontmatter、行内代码——否则双链图里会多出幽灵节点
check('fence excluded', r.links.some((l) => l.target === 'InsideFence'), false)
check('frontmatter excluded', r.links.some((l) => l.target === 'FrontmatterLink'), false)
check('inline code excluded', r.links.some((l) => l.target === 'NotALink'), false)
// ---- 标签：只认正文里的 #标签，且要排除纯数字、围栏/行内代码里的 #，
// 以及 wiki 链接 #标题 里的“#”（那是标题锚点，不是标签）----
check('tags', r.tags.map((t) => t.tag).sort(), ['redis/持久化', '面试'])
check('numeric not tag', r.tags.some((t) => t.tag === '2024'), false)
check('fence tag excluded', r.tags.some((t) => t.tag === 'fencetag'), false)
check('inline code tag excluded', r.tags.some((t) => t.tag === 'notatag'), false)
check('wikilink heading not tag', r.tags.some((t) => t.tag === '持久化'), false)
// ---- 标题行与展示用的上下文：行号要对应真实物理行（供“跳转到来源”用），
// context 是给搜索结果展示的窗口，须剥掉 markdown 符号、显示别名而非原始管道符 ----
check('headings', r.headings, ['标题一', '小节 ^blockid'])
check('line numbers are real', r.links[0].line, 7)
check('context strips md', r.links[5].context, '列表项里的 ListItem')
check('context shows the alias, not the raw pipe', r.links[1].context, '正文里链接 Redis 和别名 缓存三大问题。')

// 汇总：任一断言失败即以非 0 退出
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
