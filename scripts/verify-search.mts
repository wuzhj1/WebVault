import { tokenize, buildExcerpt } from '../src/core/search/text.ts'

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

check('latin lowercased', tokenize('Redis Cluster'), ['redis', 'cluster'])
check('cjk bigrams', tokenize('缓存穿透'), ['缓', '缓存', '存', '存穿', '穿', '穿透', '透'])
check('mixed', tokenize('Redis 缓存'), ['redis', '缓', '缓存', '存'])
check('empty', tokenize(''), [])
check('punctuation dropped', tokenize('a, b! c?'), ['a', 'b', 'c'])
check('numbers kept', tokenize('16384 slots'), ['16384', 'slots'])
check('single cjk char', tokenize('缓'), ['缓'])

// Searching a Chinese note by a two-character phrase must find it.
const corpusTokens = tokenize('Redis 缓存穿透与击穿的区别')
check('phrase bigram present', corpusTokens.includes('穿透'), true)
check('query bigram matches', tokenize('穿透').some((t) => corpusTokens.includes(t)), true)
check('unrelated query does not match', tokenize('集群').some((t) => corpusTokens.includes(t)), false)

const body = [
  '---',
  'title: 测试',
  '---',
  '',
  '# 标题',
  '',
  '前面的铺垫文字，用来把命中位置往后推，验证摘要会截取上下文而不是从头开始。',
  '',
  '这里提到 缓存穿透 的关键结论。',
  '',
  '```js',
  'const secret = "缓存穿透 不该出现在代码块摘要里"',
  '```',
  '',
  '参见 [[Redis|缓存三大问题]] 与 [[集群]]。',
].join('\n')

const excerpt = buildExcerpt(body, '缓存穿透')
check('excerpt finds hit', excerpt.includes('缓存穿透'), true)
check('excerpt drops frontmatter', excerpt.includes('title:'), false)
check('excerpt drops code fence', excerpt.includes('secret'), false)
check('excerpt unwraps wikilink', excerpt.includes('[['), false)
check('excerpt keeps alias-free target', excerpt.includes('集群') || excerpt.includes('Redis'), true)
check('excerpt is bounded', excerpt.length <= 145, true)

check('no-match excerpt falls back to head', buildExcerpt('abcdefgh', 'zzz'), 'abcdefgh')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
