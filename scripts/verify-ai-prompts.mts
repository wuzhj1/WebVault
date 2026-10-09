/**
 * AI 纯模块验证（src/core/ai/{marks,prompts}.ts + client 的纯函数）：
 * - 标记层（marks）：`isAiPath` 的前缀边界（`aifoo/x.md` 不能误判）、frontmatter 标记的
 *   形状与可解析性、引用块**每一行**都带 `>` 前缀（空行写成 `>`，多段输出不越狱）、
 *   标题推导与唯一名退让（含 sanitizeTitle 会抛的边角）；
 * - 提示词层（prompts）：动作注册表的 id 唯一性、未知动作 id 回落、上下文裁剪的头尾保留、
 *   引用笔记的定界包裹、双链建议超量时如实声明截断；
 * - client 的纯函数：baseUrl 归一化（补协议、去尾斜杠）、端点拼接（不重复叠
 *   `/chat/completions`）、`AiError` 形状与 `isAborted` 判定——这三条是「配置粘错」类
 *   报错的全部来源，钉死它们等于钉死一半的失败提示；
 * - 纪律：AI 内容的两个出口（`aiQuoteBlock` / `buildAiNoteContent`）都必须带 🤖 标记，
 *   没有裸插路径。
 *
 * 运行：pnpm verify（第 16 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import {
  AI_DIR,
  AI_ICON,
  aiFrontmatter,
  aiQuoteBlock,
  buildAiNoteContent,
  deriveTitle,
  isAiPath,
  readAiModel,
  uniqueAiPath,
} from '../src/core/ai/marks.ts'
import {
  AI_COPY,
  MAX_CONTEXT_CHARS,
  MAX_TITLES,
  NOTE_ACTIONS,
  SELECTION_ACTIONS,
  SYSTEM_PROMPT,
  buildLinkSuggestPrompt,
  buildNotePrompt,
  buildSelectionPrompt,
  buildUserMessage,
  clip,
  wrapNoteContext,
} from '../src/core/ai/prompts.ts'
import {
  AI_PRESETS,
  AiError,
  endpointOf,
  isAborted,
  normalizeAiConfig,
} from '../src/core/ai/client.ts'
import { parseFrontmatter, splitFrontmatter } from '../src/core/parse/frontmatter.ts'

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

// ---- 1. isAiPath 的前缀边界：判定文件树角标与「产出」列表，误判 = 给用户的笔记贴 AI 标签 ----
check('ai/x.md is ai path', isAiPath('ai/x.md'), true)
check('top-level ai dir itself', isAiPath('ai'), true)
check('nested under ai/', isAiPath('ai/sub/y.md'), true)
check('aifoo/x.md is NOT ai path', isAiPath('aifoo/x.md'), false)
check('notes/ai/x.md is NOT ai path (must be top-level)', isAiPath('notes/ai/x.md'), false)
check('ai.md file is NOT ai path', isAiPath('ai.md'), false)
check('other dir is NOT ai path', isAiPath('notes/x.md'), false)

// ---- 2. frontmatter 标记：形状稳定、可解析、模型名带特殊字符时按 YAML 引号编码 ----
const fm = aiFrontmatter({ model: 'deepseek-chat', at: '2026-10-08T06:03:11.123Z', source: 'chat' })
check('ai frontmatter is closed by ---', fm.startsWith('---\n'), true)
check(
  'ai frontmatter lines',
  fm.split('\n'),
  ['---', 'ai:', '  model: deepseek-chat', '  at: 2026-10-08T06:03:11.123Z', '  source: chat', '---', '', ''],
)
// `fm + body === 文件内容`：NoteEditor/存盘都按这个契约拼接，缺了尾部空行就丢一个空行
const full = `${fm}# 标题\n\n正文\n`
check('fm + body roundtrip via splitFrontmatter', splitFrontmatter(full), { fm, body: '# 标题\n\n正文\n' })
const parsed = parseFrontmatter(full)
check('fm parses as frontmatter', parsed.exists, true)
// 模型名含 ": " 会改变 YAML 语义，encodeScalar 必须加引号——否则老工具读出来是另一个值
const quoted = aiFrontmatter({ model: 'weird: model #1', at: '2026-10-08T00:00:00Z', source: 'selection' })
ok('model with ": " is quoted', quoted.includes("  model: 'weird: model #1'"), quoted)

// ---- 3. 引用块标记：每一行都带 >，空行写成 >，多段输出不越狱 ----
const quote = aiQuoteBlock('第一段\n\n第二段', 'deepseek-chat')
const quoteLines = quote.split('\n')
ok(
  'every quote line starts with >',
  quoteLines.every((l) => l.startsWith('>')),
  JSON.stringify(quoteLines),
)
ok('empty source line becomes a bare >', quoteLines.includes('>'), JSON.stringify(quoteLines))
ok('head carries icon + model', quote.startsWith(`> ${AI_ICON} **AI（deepseek-chat）**`), quote)
ok(
  'label variant shows source',
  aiQuoteBlock('x', 'm', '总结').startsWith(`> ${AI_ICON} **AI（m · 总结）**`),
  '',
)
// 纪律：两个插入出口都必带标记——裸文本没有进笔记的路径
ok('quote block carries AI icon', quote.includes(AI_ICON), quote)
const note = buildAiNoteContent({
  mark: { model: 'm', at: '2026-10-08T00:00:00Z', source: 'note' },
  title: '标题',
  body: '正文',
})
ok('note content carries AI icon notice', note.includes(`${AI_ICON} 由 m 生成`), note)
ok('note content starts with frontmatter', note.startsWith('---\n'), note)
ok('note content has H1 title', note.includes('\n# 标题\n'), note)
check('note content roundtrip body', splitFrontmatter(note).body, '# 标题\n\n> 🤖 由 m 生成于 2026-10-08，来源 note；本篇为 AI 产出，非作者原稿。\n\n正文\n')
// readAiModel 是展示辅助，跟 frontmatter 打架在这里就会暴露
check('readAiModel reads nested model', readAiModel(note), 'm')
check('readAiModel on non-ai note returns null', readAiModel('# 普通笔记\n'), null)

// ---- 4. 标题推导与唯一名退让 ----
check('deriveTitle strips heading marks', deriveTitle('## 你好,  世界'), '你好, 世界')
check('deriveTitle strips bold/list junk', deriveTitle('**加粗** 的标题'), '加粗 的标题')
check('deriveTitle picks first non-empty line', deriveTitle('\n\n第二行才是'), '第二行才是')
check('deriveTitle unwraps wikilink', deriveTitle('[[目标|别名]] 之后'), '目标 之后')
check('deriveTitle truncates by code points', deriveTitle('😀😀😀😀', 2), '😀😀')
check('deriveTitle of empty text', deriveTitle('   \n  '), '')
check('unique path without collision', uniqueAiPath('我的笔记', () => false), `${AI_DIR}/我的笔记.md`)
let calls = 0
check(
  'unique path dodges occupied names',
  uniqueAiPath('我的笔记', (p) => {
    calls++
    return p === `${AI_DIR}/我的笔记.md` || p === `${AI_DIR}/我的笔记 2.md`
  }),
  `${AI_DIR}/我的笔记 3.md`,
)
ok('collision probe is sequential', calls === 3, `calls=${calls}`)
// sanitizeTitle 会抛的边角：剥完只剩禁用字符 / 点号,沉淀是收尾动作,不能在这里炸
check('unique path of forbidden-only title', uniqueAiPath('///', () => false), `${AI_DIR}/AI 笔记.md`)
check('unique path of dots-only title', uniqueAiPath('..', () => false), `${AI_DIR}/AI 笔记.md`)
check('unique path of empty title', uniqueAiPath('', () => false), `${AI_DIR}/AI 笔记.md`)

// ---- 5. 动作注册表：面板按它渲染,prompt 按它组装,一处一个 id ----
check('selection action count', SELECTION_ACTIONS.length, 6)
check('note action count', NOTE_ACTIONS.length, 3)
check(
  'selection action ids are unique',
  new Set(SELECTION_ACTIONS.map((a) => a.id)).size,
  SELECTION_ACTIONS.length,
)
check(
  'note action ids are unique',
  new Set(NOTE_ACTIONS.map((a) => a.id)).size,
  NOTE_ACTIONS.length,
)
ok(
  'every action has label and hint',
  [...SELECTION_ACTIONS, ...NOTE_ACTIONS].every((a) => a.label !== '' && a.hint !== ''),
  '',
)

// ---- 6. prompt 组装：定界包裹、未知 id 回落、裁剪 ----
const selPrompt = buildSelectionPrompt('rewrite', '原文片段')
ok('selection prompt has task line', selPrompt.includes('改写下面这段文本'), selPrompt)
ok('selection prompt delimits selection', selPrompt.includes('<选中文本>\n原文片段\n</选中文本>'), selPrompt)
ok('selection prompt demands bare output', selPrompt.includes('只输出结果本体'), selPrompt)
ok(
  'unknown selection action falls back to rewrite',
  buildSelectionPrompt('不存在的动作', 'x').includes('改写下面这段文本'),
  '',
)
const notePrompt = buildNotePrompt('note-tags', '正文', '笔记标题')
ok('note prompt carries title', notePrompt.includes('笔记标题：笔记标题'), notePrompt)
ok('note prompt mentions tags', notePrompt.includes('#标签'), notePrompt)
ok(
  'unknown note action falls back to summary',
  buildNotePrompt('不存在', 'x').includes('总结下面这篇笔记的要点'),
  '',
)

check('clip keeps short text identical', clip('短文本'), '短文本')
const long = '头'.repeat(8000) + '腰'.repeat(8000) + '尾'.repeat(8000)
const clipped = clip(long)
ok('clip keeps head', clipped.startsWith('头'.repeat(4000)), `len=${clipped.length}`)
ok('clip keeps tail', clipped.endsWith('尾'.repeat(4000)), '')
ok('clip marks the elision', clipped.includes('中间省略'), '')
ok('clip respects the budget (plus marker)', clipped.length < MAX_CONTEXT_CHARS + 40, `len=${clipped.length}`)

check('buildUserMessage without quote is identity', buildUserMessage('你好', null), '你好')
const wrapped = buildUserMessage('总结一下', { path: 'notes/a.md', body: '正文' })
check(
  'buildUserMessage wraps quote context',
  wrapped,
  '<引用笔记 path="notes/a.md">\n正文\n</引用笔记>\n\n总结一下',
)
ok('wrapNoteContext clips the body', wrapNoteContext('x', 'p', long).length < MAX_CONTEXT_CHARS + 200, '')

// ---- 7. 双链建议：标题索引是模型感知库的唯一通道,超量必须如实声明 ----
const linkPrompt = buildLinkSuggestPrompt('正文', ['A', 'B'])
ok('link prompt lists titles', linkPrompt.includes('- A\n- B'), linkPrompt)
ok('link prompt demands real titles only', linkPrompt.includes('不要编造'), linkPrompt)
ok('link prompt shows wikilink form', linkPrompt.includes('[[标题]]'), linkPrompt)
const many = Array.from({ length: MAX_TITLES + 50 }, (_, i) => `标题${i}`)
const cut = buildLinkSuggestPrompt('正文', many)
ok('link prompt truncates over budget', !cut.includes(`- 标题${MAX_TITLES}`), '')
ok('link prompt declares truncation honestly', cut.includes(`仅列出前 ${MAX_TITLES} 条`), '')

// ---- 8. 系统提示词与文案：输出纪律写进 prompt,空态文案集中一处 ----
ok('system prompt demands bare output', SYSTEM_PROMPT.includes('只输出结果本体'), SYSTEM_PROMPT)
ok('system prompt pins language', SYSTEM_PROMPT.includes('简体中文'), SYSTEM_PROMPT)
ok('system prompt forbids fabrication', SYSTEM_PROMPT.includes('不要编造'), SYSTEM_PROMPT)
check('AI_COPY empty state', AI_COPY.empty, '问点什么，或引用一篇笔记开始。')
ok('AI_COPY unconfigured mentions settings', AI_COPY.unconfigured.includes('设置'), '')

// ---- 9. client 纯函数：配置粘错的报错全从这里来 ----
check(
  'normalize adds https and trims',
  normalizeAiConfig({ baseUrl: ' api.deepseek.com/v1 ', apiKey: ' k ', model: ' m ' }),
  { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'm' },
)
check(
  'normalize strips trailing slashes',
  normalizeAiConfig({ baseUrl: 'https://x.com/v1///', apiKey: '', model: '' }).baseUrl,
  'https://x.com/v1',
)
check('normalize keeps existing protocol', normalizeAiConfig({ baseUrl: 'http://x', apiKey: '', model: '' }).baseUrl, 'http://x')
check('endpointOf appends suffix', endpointOf('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions')
check('endpointOf tolerates trailing slash', endpointOf('https://x.com/v1/'), 'https://x.com/v1/chat/completions')
check(
  'endpointOf does not double-append',
  endpointOf('https://x.com/v1/chat/completions'),
  'https://x.com/v1/chat/completions',
)
check(
  'endpointOf case-insensitive on existing suffix',
  endpointOf('https://x.com/v1/Chat/Completions'),
  'https://x.com/v1/Chat/Completions',
)

const err = new AiError(429, '稍后重试', true)
check('AiError carries status', err.status, 429)
check('AiError carries retryable', err.retryable, true)
ok('AiError is an Error', err instanceof Error, '')
ok('isAborted true for user abort', isAborted(new AiError(0, '已停止', false)), '')
ok('isAborted false for other failures', !isAborted(new AiError(500, '挂了', true)), '')
ok('isAborted false for non-AiError', !isAborted(new Error('已停止')), '')
// 预设只回填地址与模型建议,能不能用以「测试连接」为准——名字与地址不能重复,否则按钮同名分不清
check('preset count', AI_PRESETS.length, 4)
check('preset names unique', new Set(AI_PRESETS.map((p) => p.name)).size, AI_PRESETS.length)
check('preset baseUrls unique', new Set(AI_PRESETS.map((p) => p.baseUrl)).size, AI_PRESETS.length)
ok(
  'every preset is https and non-empty model',
  AI_PRESETS.every((p) => p.baseUrl.startsWith('https://') && p.model !== ''),
  JSON.stringify(AI_PRESETS),
)

const total = pass + fail
console.log(`OK   verify-ai-prompts: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
if (total < 70) {
  console.error(`FAIL verify-ai-prompts: ${total} assertions run, expected at least 70`)
  process.exit(1)
}
