import { normalizeGiteeConfig, parseRepoUrl } from '../src/core/sync/gitee.ts'

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

check('full url', parseRepoUrl('https://gitee.com/wuzhj/my-note'), { owner: 'wuzhj', repo: 'my-note' })
check('no scheme', parseRepoUrl('gitee.com/wuzhj/my-note'), { owner: 'wuzhj', repo: 'my-note' })
check('www + trailing slash', parseRepoUrl('https://www.gitee.com/wuzhj/my-note/'), {
  owner: 'wuzhj',
  repo: 'my-note',
})
check('git suffix', parseRepoUrl('https://gitee.com/wuzhj/my-note.git'), { owner: 'wuzhj', repo: 'my-note' })
check('tree branch', parseRepoUrl('https://gitee.com/wuzhj/my-note/tree/main'), {
  owner: 'wuzhj',
  repo: 'my-note',
  branch: 'main',
})
check('query string', parseRepoUrl('https://gitee.com/wuzhj/my-note?foo=1'), { owner: 'wuzhj', repo: 'my-note' })
check('owner only', parseRepoUrl('https://gitee.com/wuzhj'), { owner: 'wuzhj' })
check('bare owner/repo', parseRepoUrl('wuzhj/my-note'), { owner: 'wuzhj', repo: 'my-note' })
check('plain owner untouched', parseRepoUrl('wuzhj'), null)
check('other host untouched', parseRepoUrl('https://github.com/wuzhj/my-note'), null)
check('empty untouched', parseRepoUrl('  '), null)

check(
  'normalize pasted url in owner',
  normalizeGiteeConfig({
    token: 't',
    owner: 'https://gitee.com/wuzhj/my-note',
    repo: 'my-note',
    branch: 'master',
  }),
  { token: 't', owner: 'wuzhj', repo: 'my-note', branch: 'master' },
)
check(
  'normalize url carries branch',
  normalizeGiteeConfig({ token: 't', owner: 'gitee.com/wuzhj/my-note/tree/main', repo: '', branch: 'master' }),
  { token: 't', owner: 'wuzhj', repo: 'my-note', branch: 'main' },
)
check(
  'normalize url pasted into repo',
  normalizeGiteeConfig({ token: 't', owner: 'wuzhj', repo: 'https://gitee.com/wuzhj/my-note.git', branch: 'master' }),
  { token: 't', owner: 'wuzhj', repo: 'my-note', branch: 'master' },
)
check(
  'normalize trims junk',
  normalizeGiteeConfig({ token: ' t ', owner: ' wuzhj/ ', repo: ' my-note.git ', branch: ' master/ ' }),
  { token: ' t ', owner: 'wuzhj', repo: 'my-note', branch: 'master' },
)
check(
  'normalize leaves plain config alone',
  normalizeGiteeConfig({ token: 't', owner: 'wuzhj', repo: 'my-note', branch: 'master' }),
  { token: 't', owner: 'wuzhj', repo: 'my-note', branch: 'master' },
)

console.log(`${fail === 0 ? 'OK  ' : 'FAIL'} verify-config: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
