import { classifySync, threeWayMerge } from '../src/core/sync/merge.ts'

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

// ---- classifySync ----
check('same sha', classifySync('a', 'a', 'a'), 'unchanged')
check('local only', classifySync('L', 'B', 'B'), 'local-only')
check('remote only', classifySync('B', 'B', 'R'), 'remote-only')
check('both changed', classifySync('L', 'B', 'R'), 'conflict')
check('new local file', classifySync('L', null, null), 'local-only')
check('new remote file', classifySync(null, null, 'R'), 'remote-only')
check('deleted remotely', classifySync('B', 'B', null), 'remote-only')

// ---- threeWayMerge ----
const base = ['line1', 'line2', 'line3', 'line4'].join('\n')
const local = ['line1', 'LOCAL line2', 'line3', 'line4'].join('\n')
const remote = ['line1', 'line2', 'line3', 'REMOTE line4'].join('\n')

const clean = threeWayMerge(local, base, remote)
check('disjoint edits merge', clean.status, 'merged')
check('disjoint edits content', clean.text, ['line1', 'LOCAL line2', 'line3', 'REMOTE line4'].join('\n'))
check('disjoint conflicts count', clean.conflicts, 0)

const overlapping = threeWayMerge(
  ['line1', 'LOCAL line2', 'line3'].join('\n'),
  ['line1', 'line2', 'line3'].join('\n'),
  ['line1', 'REMOTE line2', 'line3'].join('\n'),
)
check('overlapping is conflict', overlapping.status, 'conflict')
check('conflict keeps local', overlapping.text, ['line1', 'LOCAL line2', 'line3'].join('\n'))
check('conflict exposes remote', overlapping.remoteText, ['line1', 'REMOTE line2', 'line3'].join('\n'))
check('no inline markers leak', overlapping.text.includes('<<<<<<<'), false)

check('identical inputs', threeWayMerge('x', 'x', 'x').status, 'merged')
check('local equals base', threeWayMerge(base, base, remote).status, 'remote-only')
check('remote equals base', threeWayMerge(local, base, base).status, 'local-only')

// false conflict: both sides made the same edit
const same = threeWayMerge(
  ['a', 'SAME', 'c'].join('\n'),
  ['a', 'b', 'c'].join('\n'),
  ['a', 'SAME', 'c'].join('\n'),
)
check('identical edits are not a conflict', same.status, 'merged')
check('identical edits content', same.text, ['a', 'SAME', 'c'].join('\n'))

// markdown structure must survive intact
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

// CRLF and trailing-newline fidelity
check('trailing newline preserved', threeWayMerge('a\n', 'a\n', 'a\nb\n').text, 'a\nb\n')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
