/**
 * 内容指纹验证（src/core/vault/hash.ts）：
 * - gitBlobSha / gitBlobShaBytes：sha1("blob <字节数>\0" + 内容)，必须与 `git hash-object --stdin`
 *   逐字节一致——向量用 git 现算核准（空串 / ASCII / 中文 UTF-8 各一条）；
 * - contentFingerprint：SHA-256 前 8 字节的截断指纹，16 位十六进制、确定且区分内容；
 * - conflictStamp：冲突副本后缀 YYYYMMDDTHHmmss，本地时间、单位补零。
 *
 * 运行：pnpm verify（第 10 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import { createHash } from 'node:crypto'
import { conflictStamp, contentFingerprint, gitBlobSha, gitBlobShaBytes } from '../src/core/vault/hash.ts'

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

function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else {
    fail++
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ''}`)
  }
}

/** 独立预言机：node:crypto 直接按 git 的 blob 格式拼装，与 subtle 实现互为对照。 */
function oracle(text: string): string {
  const body = Buffer.from(text, 'utf8')
  const header = Buffer.from(`blob ${body.byteLength}${String.fromCharCode(0)}`, 'utf8')
  return createHash('sha1').update(Buffer.concat([header, body])).digest('hex')
}

// ---- gitBlobSha：向量由 `git hash-object --stdin` 按精确字节算出（勿凭记忆手写）----
check('empty blob', await gitBlobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
check('ascii with newline', await gitBlobSha('hello world\n'), '3b18e512dba79e4c8300dd08aeb37f8e728b8dad')
check('CJK utf8 bytes drive the hash', await gitBlobSha('中文测试\n'), 'eeee1f4efc67a372923b7b321712aa319c6ef93b')

// ---- gitBlobShaBytes：与字符串入口等价；长度按字节数而非字符数 ----
check('bytes entry equals string entry', await gitBlobShaBytes(new TextEncoder().encode('中文测试\n')), await gitBlobSha('中文测试\n'))
check('empty bytes equals empty blob', await gitBlobShaBytes(new Uint8Array()), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')

// ---- node:crypto 预言机：多字节长文本，顺带钉死「字节数不是字符数」这条最容易写错的规则 ----
const longText = '长内容 mixed ASCII 与 emoji 🙂 的一段文本。'.repeat(200)
check('long multi-byte matches crypto oracle', await gitBlobSha(longText), oracle(longText))
// header 若按字符数（5）而非字节数（13）拼装会得到另一个值——这行钉死实现必须用 byteLength。
const charCountHeader = (() => {
  const body = Buffer.from('中文测试\n', 'utf8')
  const header = Buffer.from(`blob ${'中文测试\n'.length}${String.fromCharCode(0)}`, 'utf8')
  return createHash('sha1').update(Buffer.concat([header, body])).digest('hex')
})()
ok('char-count header would be a different hash', (await gitBlobSha('中文测试\n')) !== charCountHeader)

// ---- contentFingerprint：16 位十六进制、确定性、区分内容；不是 git 兼容值 ----
const fp1 = await contentFingerprint('a')
const fp2 = await contentFingerprint('a')
const fp3 = await contentFingerprint('b')
ok('fingerprint is 16 hex chars', /^[0-9a-f]{16}$/.test(fp1), fp1)
check('fingerprint deterministic', fp1, fp2)
ok('fingerprint distinguishes content', fp1 !== fp3)
ok('fingerprint is not the git blob sha', fp1 !== (await gitBlobSha('a')))

// ---- conflictStamp：本地时间、单位补零、格式固定 ----
check('stamp pads single digits', conflictStamp(new Date(2026, 0, 2, 3, 4, 5)), '20260102T030405')
check('stamp end of year', conflictStamp(new Date(2026, 11, 31, 23, 59, 59)), '20261231T235959')
const now = conflictStamp()
ok('live stamp matches format', /^\d{8}T\d{6}$/.test(now), now)

console.log(`${fail === 0 ? 'OK  ' : 'FAIL'} verify-hash: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
