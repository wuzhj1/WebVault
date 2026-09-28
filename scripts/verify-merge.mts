/**
 * 三方合并验证（src/core/sync/merge.ts）：
 * - classifySync：用 base/local/remote 三个 SHA 判定“未变 / 仅本地 / 仅远端 / 冲突”；
 * - threeWayMerge：以 base 为基准逐行合并两侧文本，不相交的修改自动合并，
 *   同行冲突时正文保底用本地、远端文本另行暴露，且绝不把冲突标记写进正文。
 *
 * 运行：pnpm verify（第 5 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import { classifySync, threeWayMerge } from '../src/core/sync/merge.ts'

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

// ---- classifySync：三个 SHA 的状态判定。null 表示该侧不存在这个文件，因而新增与删除也归这里管 ----
check('same sha', classifySync('a', 'a', 'a'), 'unchanged')
check('local only', classifySync('L', 'B', 'B'), 'local-only')
check('remote only', classifySync('B', 'B', 'R'), 'remote-only')
check('both changed', classifySync('L', 'B', 'R'), 'conflict')
check('new local file', classifySync('L', null, null), 'local-only')
check('new remote file', classifySync(null, null, 'R'), 'remote-only')
check('deleted remotely', classifySync('B', 'B', null), 'remote-only')

// ---- threeWayMerge：以下共用同一份 4 行 base，两侧各改一行 ----
const base = ['line1', 'line2', 'line3', 'line4'].join('\n')
const local = ['line1', 'LOCAL line2', 'line3', 'line4'].join('\n')
const remote = ['line1', 'line2', 'line3', 'REMOTE line4'].join('\n')

// 两侧改的是不同行 → 自动合并，两处修改都必须保留，且不产生冲突计数
const clean = threeWayMerge(local, base, remote)
check('disjoint edits merge', clean.status, 'merged')
check('disjoint edits content', clean.text, ['line1', 'LOCAL line2', 'line3', 'REMOTE line4'].join('\n'))
check('disjoint conflicts count', clean.conflicts, 0)

// 同一行两侧都改 → 冲突：正文保底用本地版本，远端版本通过 remoteText 单独交给上层展示，
// 且正文里绝不出现 <<<<<<< 之类的内联标记（那会直接写进用户的笔记）
const overlapping = threeWayMerge(
  ['line1', 'LOCAL line2', 'line3'].join('\n'),
  ['line1', 'line2', 'line3'].join('\n'),
  ['line1', 'REMOTE line2', 'line3'].join('\n'),
)
check('overlapping is conflict', overlapping.status, 'conflict')
check('conflict keeps local', overlapping.text, ['line1', 'LOCAL line2', 'line3'].join('\n'))
check('conflict exposes remote', overlapping.remoteText, ['line1', 'REMOTE line2', 'line3'].join('\n'))
check('no inline markers leak', overlapping.text.includes('<<<<<<<'), false)

// 退化输入：三者完全相同、只有一侧相对 base 变化，都应归为单侧变化而非冲突
check('identical inputs', threeWayMerge('x', 'x', 'x').status, 'merged')
check('local equals base', threeWayMerge(base, base, remote).status, 'remote-only')
check('remote equals base', threeWayMerge(local, base, base).status, 'local-only')

// 假冲突：两侧做了完全相同的修改——结果一致，就没有理由打扰用户
const same = threeWayMerge(
  ['a', 'SAME', 'c'].join('\n'),
  ['a', 'b', 'c'].join('\n'),
  ['a', 'SAME', 'c'].join('\n'),
)
check('identical edits are not a conflict', same.status, 'merged')
check('identical edits content', same.text, ['a', 'SAME', 'c'].join('\n'))

// Markdown 结构必须原样存活：围栏代码块、空行、标题都不能被行级合并搅乱
const mdBase = ['# 标题', '', '- 项目一', '- 项目二', '', '```js', 'const a = 1', '```', ''].join('\n')
const mdLocal = ['# 标题', '', '- 项目一(本地改)', '- 项目二', '', '```js', 'const a = 1', '```', ''].join('\n')
const mdRemote = ['# 标题', '', '- 项目一', '- 项目二', '', '```js', 'const a = 2', '```', ''].join('\n')
const mdMerged = threeWayMerge(mdLocal, mdBase, mdRemote)
check('markdown merge status', mdMerged.status, 'merged')
check(
  'markdown merge keeps fences and newlines',
  mdMerged.text,
  ['# 标题', '', '- 项目一(本地改)', '- 项目二', '', '```js', 'const a = 2', '```', ''].join('\n'),
)

// CRLF 与末尾换行的保真：末尾少一个 \n，就会在每次同步时制造一个不存在的差异
check('trailing newline preserved', threeWayMerge('a\n', 'a\n', 'a\nb\n').text, 'a\nb\n')

// 汇总：任一断言失败即以非 0 退出
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
