/**
 * 路径与标题工具验证（src/core/vault/paths.ts）：
 * - normalizePath：全应用唯一的落盘入口，归一化斜杠/`.`/`..`，空串、NUL、盘符、越界一律拒绝；
 * - titleOf/dirOf/joinPath/ancestorDirs：文件树、双链分桶与 OPFS 建目录共用的纯字符串运算；
 * - ensureMdExt/isNotePath/sanitizeTitle/cardPath/comparePath：新建笔记、改名与排序的入口。
 *
 * 运行：npm run verify（第 9 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import {
  UnsafePathError,
  ancestorDirs,
  cardPath,
  comparePath,
  dirOf,
  ensureMdExt,
  isNotePath,
  joinPath,
  normalizePath,
  sanitizeTitle,
  titleOf,
} from '../src/core/vault/paths.ts'

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

/** 断言 fn 抛出 UnsafePathError——「拒绝而不是修正」是 normalizePath 的核心契约。 */
function checkUnsafe(name: string, fn: () => unknown) {
  try {
    fn()
    fail++
    console.log(`FAIL ${name}\n  expected UnsafePathError, but returned normally`)
  } catch (err) {
    if (err instanceof UnsafePathError && err.name === 'UnsafePathError') {
      pass++
    } else {
      fail++
      console.log(`FAIL ${name}\n  expected UnsafePathError, got: ${err}`)
    }
  }
}

/** 断言 fn 抛出任意 Error（用于 sanitizeTitle 的空标题）。 */
function checkThrows(name: string, fn: () => unknown) {
  try {
    fn()
    fail++
    console.log(`FAIL ${name}\n  expected to throw, but returned normally`)
  } catch (err) {
    if (err instanceof Error) pass++
    else {
      fail++
      console.log(`FAIL ${name}\n  expected Error, got: ${err}`)
    }
  }
}

// ---- normalizePath：折叠顺序是关键——先折叠再判空，字符串级 startsWith 防护拦不住 a/../../etc ----
check('plain path stays', normalizePath('notes/sub/a.md'), 'notes/sub/a.md')
check('backslashes become slashes', normalizePath('.\\notes\\sub\\a.md'), 'notes/sub/a.md')
check('one leading slash stripped, doubles collapsed', normalizePath('/notes//a.md'), 'notes/a.md')
check('middle .. folds within root', normalizePath('a/b/../c.md'), 'a/c.md')
check('dot segments dropped', normalizePath('a/./b'), 'a/b')
check('trailing slash dropped', normalizePath('a/'), 'a')
checkUnsafe('escape above root', () => normalizePath('a/../../etc/passwd'))
checkUnsafe('leading ..', () => normalizePath('../a.md'))
checkUnsafe('leading .. after slash strip', () => normalizePath('/../a.md'))
checkUnsafe('drive letter with slash', () => normalizePath('C:/x/a.md'))
checkUnsafe('drive letter without slash', () => normalizePath('c:x'))
checkUnsafe('NUL byte', () => normalizePath(`a${String.fromCharCode(0)}b.md`))
checkUnsafe('empty string', () => normalizePath(''))
checkUnsafe('whitespace only', () => normalizePath('   '))
checkUnsafe('only dot segments', () => normalizePath('./'))
checkUnsafe('only slashes', () => normalizePath('///'))

// ---- isNotePath / ensureMdExt：大小写判定统一走 toLowerCase（OPFS 在 Windows 上大小写不敏感）----
check('isNotePath .md', isNotePath('a.md'), true)
check('isNotePath .MD', isNotePath('a.MD'), true)
check('isNotePath .txt', isNotePath('a.txt'), false)
check('isNotePath bare md', isNotePath('md'), false)
check('ensureMdExt appends', ensureMdExt('a'), 'a.md')
check('ensureMdExt keeps existing', ensureMdExt('a.md'), 'a.md')
check('ensureMdExt keeps upper ext', ensureMdExt('A.MD'), 'A.MD')
check('ensureMdExt trims', ensureMdExt(' a '), 'a.md')

// ---- titleOf：剥 zettel id 前缀，让 [[卡片盒]] 与 [[202609151423 卡片盒]] 指向同一篇 ----
check('titleOf basic', titleOf('notes/sub/a.md'), 'a')
check('titleOf strips id + space', titleOf('202609151423 卡片盒.md'), '卡片盒')
check('titleOf strips id + letter suffix', titleOf('202609151423a_标题.md'), '标题')
check('bare id has no separator so is the title', titleOf('202609151423.md'), '202609151423')
check('stripping to empty falls back to stem', titleOf('202609151423 -.md'), '202609151423 -')

// ---- dirOf / joinPath / ancestorDirs：根目录用空串表示，不是 `.` ----
check('dirOf nested', dirOf('a/b/c.md'), 'a/b')
check('dirOf root file', dirOf('c.md'), '')
check('dirOf no slash', dirOf('a'), '')
check('joinPath bare', joinPath('', 'x.md'), 'x.md')
check('joinPath slash-only dir', joinPath('/', 'x.md'), 'x.md')
check('joinPath trims dir', joinPath(' a ', 'x.md'), 'a/x.md')
check('joinPath then normalize heals doubles', normalizePath(joinPath('a/', 'x.md')), 'a/x.md')
check('ancestorDirs nested', ancestorDirs('a/b/c.md'), ['a', 'a/b'])
check('ancestorDirs root file', ancestorDirs('c.md'), [])
check('ancestorDirs one deep', ancestorDirs('a/c.md'), ['a'])

// ---- sanitizeTitle：/ 和 \ 必须去掉，否则标题会凭空造出子目录；截断按码点，不切半个代理对 ----
check('slash becomes space', sanitizeTitle('a/b'), 'a b')
check('collapse and trim', sanitizeTitle('  hello   world  '), 'hello world')
check('dot segments cannot escape', sanitizeTitle('../evil'), 'evil')
check('forbidden chars collapsed', sanitizeTitle('<a>:"b"?'), 'a b')
check('truncate by codepoint', sanitizeTitle('字'.repeat(60)), '字'.repeat(48))
check('no dot left behind after truncation', sanitizeTitle('x'.repeat(47) + '.' + 'y'.repeat(20)), 'x'.repeat(47))
checkThrows('empty title throws', () => sanitizeTitle(''))
checkThrows('only forbidden chars throws', () => sanitizeTitle('/*?'))

// ---- cardPath：复用 normalizePath 的拒绝语义 ----
check('cardPath basic', cardPath('a', 'b.md'), 'a/b.md')
check('cardPath root', cardPath('', 'b.md'), 'b.md')
checkUnsafe('cardPath escaping dir', () => cardPath('..', 'b.md'))

// ---- comparePath：中文自然序，numeric 让 2 排在 10 前 ----
check('natural numeric order', comparePath('a2', 'a10') < 0, true)
check('plain order', comparePath('b', 'a') > 0, true)
check('equal', comparePath('a', 'a'), 0)

console.log(`${fail === 0 ? 'OK  ' : 'FAIL'} verify-paths: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
