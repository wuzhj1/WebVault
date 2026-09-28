/**
 * Gitee 同步配置解析验证：parseRepoUrl 要把用户可能粘贴的任何形态的仓库地址收敛成
 * owner/repo/branch（认不出的返回 null），normalizeGiteeConfig 则负责清洗配置对象——
 * 用户经常把整段 URL 粘进 owner 或 repo 栏，这里必须能从里面把字段拆回来。
 *
 * 运行：pnpm verify（第 1 个套件；裸 node 直跑本文件，import src/core/sync/gitee.ts）。
 * 全部通过输出 OK 且退出码 0，否则打印 expected/actual 差异并以 1 退出。
 */
import { normalizeGiteeConfig, parseRepoUrl } from '../src/core/sync/gitee.ts'

let pass = 0
let fail = 0

/** 用 JSON 序列化后比较，失败时打印差异；字符串化保证对象键序差异也能被暴露。 */
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

// ---- parseRepoUrl：接受的各种粘贴形态——完整/缺协议 URL、www 与尾斜杠、.git 后缀、/tree/分支、查询串 ----
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
// 退化但仍可判定的形态：只有 owner 时解析出 owner；裸 owner/repo 无协议也能解析
check('owner only', parseRepoUrl('https://gitee.com/wuzhj'), { owner: 'wuzhj' })
check('bare owner/repo', parseRepoUrl('wuzhj/my-note'), { owner: 'wuzhj', repo: 'my-note' })
// 返回 null 表示“这不是一个仓库地址”：纯用户名、别的主机（如 GitHub）、空白输入一律拒绝，
// 好让上层不要把垃圾值写进配置
check('plain owner untouched', parseRepoUrl('wuzhj'), null)
check('other host untouched', parseRepoUrl('https://github.com/wuzhj/my-note'), null)
check('empty untouched', parseRepoUrl('  '), null)

// ---- normalizeGiteeConfig：整段 URL 被粘进 owner 或 repo 栏时，从 URL 里回收各字段 ----
// 粘进 owner 栏的 URL 拆出 owner/repo；配置里已填的分支不受影响
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
// URL 自带 /tree/ 分支时以它为准，覆盖配置里手填的分支
check(
  'normalize url carries branch',
  normalizeGiteeConfig({ token: 't', owner: 'gitee.com/wuzhj/my-note/tree/main', repo: '', branch: 'master' }),
  { token: 't', owner: 'wuzhj', repo: 'my-note', branch: 'main' },
)
// 粘进 repo 栏同理：owner 不动，repo 从 URL 拆出（.git 后缀一并剥掉）
check(
  'normalize url pasted into repo',
  normalizeGiteeConfig({ token: 't', owner: 'wuzhj', repo: 'https://gitee.com/wuzhj/my-note.git', branch: 'master' }),
  { token: 't', owner: 'wuzhj', repo: 'my-note', branch: 'master' },
)
// 各字段只修剪首尾空白与 .git 后缀；token 是凭据，绝不参与解析，原样保留
check(
  'normalize trims junk',
  normalizeGiteeConfig({ token: ' t ', owner: ' wuzhj/ ', repo: ' my-note.git ', branch: ' master/ ' }),
  { token: ' t ', owner: 'wuzhj', repo: 'my-note', branch: 'master' },
)
// 已经规范的配置必须原样通过——normalize 是幂等的清洗，不是重写
check(
  'normalize leaves plain config alone',
  normalizeGiteeConfig({ token: 't', owner: 'wuzhj', repo: 'my-note', branch: 'master' }),
  { token: 't', owner: 'wuzhj', repo: 'my-note', branch: 'master' },
)

// 汇总：任一断言失败即以非 0 退出，让 `pnpm verify` 整条链失败
console.log(`${fail === 0 ? 'OK  ' : 'FAIL'} verify-config: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
