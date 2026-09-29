/**
 * 凭据抹除验证（src/core/vault/redact.ts）：
 * - 真实的 settings 行形状进去，Gitee token 必须变空串、其余字段原样保留；
 * - 匹配是大小写不敏感的整串匹配：`Token` / `PASSWORD` / `api_key` 都要被抹，
 *   而 `tokenCount` / `lastTokenAt` / `secretary` 这类只「含」这些词的字段**不能**被误伤 ——
 *   误抹等于把一份正常快照悄悄改坏，比漏抹更难发现；
 * - 形状守恒：抹完的键必须还在（值变 ''），键的集合与原对象一致；
 * - 纯函数：入参不被 mutate；
 * - 非普通对象（Date 等）原样返回，不能被摊成 `{}`。
 *
 * 运行：pnpm verify（第 14 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import { redactSecrets } from '../src/core/vault/redact.ts'

let pass = 0
let fail = 0

/** 用 JSON 序列化后比较，失败时打印 expected/actual 差异。 */
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`)
  }
}

function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else {
    fail++
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ''}`)
  }
}

// ---- 真实形状：settings 表的一行，Gitee 配置整个裹在 value 里 ----
const giteeRow = [
  {
    key: 'gitee',
    value: {
      owner: 'someone',
      repo: 'notes',
      branch: 'main',
      basePath: 'notes',
      token: 'ghp_THIS_MUST_NOT_LEAK',
    },
  },
  { key: 'last-open-path', value: 'notes/想法.md' },
]
const cleaned = redactSecrets(giteeRow) as typeof giteeRow
check('gitee token is blanked', cleaned[0].value.token, '')
check(
  'everything around the token survives',
  { owner: cleaned[0].value.owner, repo: cleaned[0].value.repo, branch: cleaned[0].value.branch, basePath: cleaned[0].value.basePath },
  { owner: 'someone', repo: 'notes', branch: 'main', basePath: 'notes' },
)
check('unrelated setting row is untouched', cleaned[1], giteeRow[1])

// ---- 形状守恒：键还在，只是值空了 ----
check(
  'keys are preserved, not deleted',
  Object.keys(cleaned[0].value).sort(),
  Object.keys(giteeRow[0].value).sort(),
)

// ---- 各种凭据字段名，大小写不敏感 ----
const SECRET_NAMES = ['token', 'Token', 'TOKEN', 'password', 'PASSWORD', 'secret', 'ApiKey', 'api_key', 'apikey', 'credential', 'authorization']
for (const name of SECRET_NAMES) {
  const out = redactSecrets({ [name]: 's3cret', keep: 1 }) as Record<string, unknown>
  check(`redacts key "${name}"`, out[name], '')
  check(`keeps sibling of "${name}"`, out.keep, 1)
}

// ---- 整串匹配：含这些词但不是凭据的字段不许被误伤 ----
const HARMLESS = ['tokenCount', 'lastTokenAt', 'tokens', 'secretary', 'passwordless', 'x-api-key-cache', 'api-key-rotated-at', 'credentialId']
for (const name of HARMLESS) {
  const out = redactSecrets({ [name]: 42 }) as Record<string, unknown>
  check(`does not touch "${name}"`, out[name], 42)
}

// ---- 深层嵌套 ----
const deep = { a: { b: [{ c: { token: 'x', d: { password: 'y' } } }] } }
check('redacts at arbitrary depth', JSON.stringify(redactSecrets(deep)), JSON.stringify({ a: { b: [{ c: { token: '', d: { password: '' } } }] } }))

// ---- 标量与空容器：原样返回 ----
check('null passes through', redactSecrets(null), null)
check('number passes through', redactSecrets(42), 42)
check('a bare string that reads "token" is not a key', redactSecrets('token'), 'token')
check('empty object', redactSecrets({}), {})
check('empty array', redactSecrets([]), [])

// ---- 纯函数：入参不能被改 ----
const before = JSON.stringify(giteeRow)
redactSecrets(giteeRow)
check('input is not mutated', JSON.stringify(giteeRow), before)
ok('input still holds the original token', giteeRow[0].value.token === 'ghp_THIS_MUST_NOT_LEAK')

// ---- 非普通对象不摊平：Date 要能原样交给 JSON.stringify ----
const withDate = redactSecrets({ at: new Date('2026-09-29T00:00:00.000Z'), token: 'x' }) as { at: unknown; token: string }
ok('Date is left as a Date, not flattened to {}', withDate.at instanceof Date, `got ${typeof withDate.at}`)
check('Date still serializes to ISO', JSON.stringify(withDate), JSON.stringify({ at: '2026-09-29T00:00:00.000Z', token: '' }))

console.log(`${fail === 0 ? 'OK  ' : 'FAIL'} verify-redact: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
