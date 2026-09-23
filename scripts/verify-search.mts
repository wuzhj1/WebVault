/**
 * 搜索验证（src/core/search/text.ts）：
 * - tokenize：索引与查询必须共用同一套分词规则——拉丁词转小写，CJK 用“单字 + 二元组”切分，
 *   这样中文词组才能被查询命中（中文没有空格可依）；
 * - buildExcerpt：摘要只截正文——剥掉 frontmatter 与代码块、把 wiki 链接退化成纯文本、限制长度。
 *
 * 运行：npm run verify（第 7 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import { tokenize, buildExcerpt } from '../src/core/search/text.ts'

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

// ---- tokenize：基本分词契约——小写、标点丢弃、数字保留、CJK 单字+二元组、空输入返回空 ----
check('latin lowercased', tokenize('Redis Cluster'), ['redis', 'cluster'])
check('cjk bigrams', tokenize('缓存穿透'), ['缓', '缓存', '存', '存穿', '穿', '穿透', '透'])
check('mixed', tokenize('Redis 缓存'), ['redis', '缓', '缓存', '存'])
check('empty', tokenize(''), [])
check('punctuation dropped', tokenize('a, b! c?'), ['a', 'b', 'c'])
check('numbers kept', tokenize('16384 slots'), ['16384', 'slots'])
check('single cjk char', tokenize('缓'), ['缓'])

// 用二字词组搜中文笔记必须搜得到：查询侧与文档侧要切出同样的二元组，无关词组则不许命中
const corpusTokens = tokenize('Redis 缓存穿透与击穿的区别')
check('phrase bigram present', corpusTokens.includes('穿透'), true)
check('query bigram matches', tokenize('穿透').some((t) => corpusTokens.includes(t)), true)
check('unrelated query does not match', tokenize('集群').some((t) => corpusTokens.includes(t)), false)

// 摘要样本：命中点刻意放到正文中部（验证截取的是上下文而非开头），
// 并在代码块里再埋一个同词，验证它不会混进摘要
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

// ---- buildExcerpt：含命中、去元数据与代码块、展开 wiki 链接、长度有上限 ----
const excerpt = buildExcerpt(body, '缓存穿透')
check('excerpt finds hit', excerpt.includes('缓存穿透'), true)
check('excerpt drops frontmatter', excerpt.includes('title:'), false)
check('excerpt drops code fence', excerpt.includes('secret'), false)
check('excerpt unwraps wikilink', excerpt.includes('[['), false)
check('excerpt keeps alias-free target', excerpt.includes('集群') || excerpt.includes('Redis'), true)
check('excerpt is bounded', excerpt.length <= 145, true)

// 未命中时退回文档开头，而不是给用户一个空片段
check('no-match excerpt falls back to head', buildExcerpt('abcdefgh', 'zzz'), 'abcdefgh')

// 汇总：任一断言失败即以非 0 退出
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
