/**
 * 大纲文本与下标对齐验证（src/core/editor/outline.ts）：
 * - `outlineTextOf` 的四步洗字：折叠空白 → 摘 ATX `#` → 摘 setext 下划线 → 摘闭合 `#`；
 *   以及刻意**不**碰的两类（`#hashtag`、`C#`）；
 * - `outlineOf` 的下标契约：级数取自标签名（大小写都要认）、**空标题必须留位**——
 *   这一条是整个「点第 N 行跳第 N 节」的地基，丢一条后面全部错位。
 *
 * `outlineOf` 走的是鸭子类型的假根（只为覆盖取数循环与下标规则）：引入 jsdom 违背
 * 「不引依赖」的纪律，而真正的渲染对齐由浏览器冒烟负责。
 *
 * 运行：pnpm verify（第 18 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import { outlineOf, outlineTextOf } from '../src/core/editor/outline.ts'

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

// ---- ATX：`# ` 标记与闭合 `#` 都要摘掉 ----
check('h1 strips marker', outlineTextOf('# 标题一'), '标题一')
check('h2 strips marker', outlineTextOf('## 二级标题'), '二级标题')
check('h6 strips marker', outlineTextOf('###### 六级标题'), '六级标题')
check('closing hashes stripped', outlineTextOf('## 标题 ##'), '标题')
check('single closing hash stripped', outlineTextOf('# 标题 #'), '标题')

// ---- setext：下划线渲染进了 textContent，是另一种形态的标记 ----
check('setext equals underline', outlineTextOf('设置标题\n========'), '设置标题')
check('setext dash underline', outlineTextOf('破折标题\n--------'), '破折标题')
check('setext underline after collapse', outlineTextOf('设置标题   ========'), '设置标题')
check('setext heading keeps inner hash', outlineTextOf('标题 # 标签\n==='), '标题 # 标签')

// ---- 引用块里的标题：源码正则抓不到，DOM 里却是真标题 ----
check('blockquote heading', outlineTextOf('# 引用里的标题'), '引用里的标题')

// ---- 空白折叠：多行标题压成一行，首尾不留空格 ----
check('newlines collapse', outlineTextOf('## 多行\n标题'), '多行 标题')
check('inner spaces collapse', outlineTextOf('#   多   空格  标题'), '多 空格 标题')
check('outer spaces trimmed', outlineTextOf('   #   标题   '), '标题')

// ---- 刻意不碰：`#` 后没空白不是标记，`#` 前没空白也不是 ----
check('hashtag untouched', outlineTextOf('#hashtag'), '#hashtag')
check('csharp untouched', outlineTextOf('C# 语言'), 'C# 语言')
check('short dash untouched', outlineTextOf('标题 -'), '标题 -')
// 只有 `#` 的裸串按「行尾的 ATX 标记」处理成空标题——它是标记不是文字
check('marker-only hashes empty out', outlineTextOf('###'), '')
check('heading whose text is hashes keeps them', outlineTextOf('# ###'), '###')

// ---- 空值：空标题在 DOM 里占位，但不该炸 ----
check('empty stays empty', outlineTextOf(''), '')
check('whitespace only empties', outlineTextOf('   \n  '), '')

// ---- outlineOf：级数取自标签名、下标即 DOM 顺序 ----
/** 假根：只提供 querySelectorAll，覆盖取数循环与下标/级数规则。 */
function fakeRoot(nodes: Array<{ tagName: string; textContent: string }>) {
  return {
    querySelectorAll: () => nodes,
  } as unknown as ParentNode
}

const root = fakeRoot([
  { tagName: 'H1', textContent: '# 标题一' },
  { tagName: 'H2', textContent: '## 二级标题' },
  { tagName: 'H3', textContent: '### 三级标题' },
  { tagName: 'H1', textContent: '# 引用里的标题' },
  { tagName: 'H1', textContent: '设置标题\n========' },
])
check('levels from tag names', outlineOf(root).map((h) => h.level), [1, 2, 3, 1, 1])
check(
  'texts cleaned in order',
  outlineOf(root).map((h) => h.text),
  ['标题一', '二级标题', '三级标题', '引用里的标题', '设置标题'],
)
check('index is document order', outlineOf(root)[3], { level: 1, text: '引用里的标题' })

// 下标契约：空标题必须占一位，否则它之后每一条都往前错一格
const withEmpty = fakeRoot([
  { tagName: 'H1', textContent: '# 第一' },
  { tagName: 'H2', textContent: '# ' },
  { tagName: 'H1', textContent: '# 第三' },
])
check('empty heading keeps its slot', outlineOf(withEmpty).map((h) => h.text), ['第一', '', '第三'])
check('slot count matches dom count', outlineOf(withEmpty).length, 3)

// 小写标签名（XML 语境）同样要认，级数不能算成 NaN
const lower = fakeRoot([{ tagName: 'h4', textContent: '#### 四级' }])
check('lowercase tag name', outlineOf(lower), [{ level: 4, text: '四级' }])

// 编辑器没就绪（root 为 null）返回空表而不是抛错
check('null root yields empty', outlineOf(null), [])
check('null root length', outlineOf(null).length, 0)

console.log(`OK   verify-outline: ${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
