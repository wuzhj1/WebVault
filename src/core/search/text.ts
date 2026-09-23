/**
 * 搜索用的纯文本工具：分词与摘要。
 *
 * 硬约束：不碰任何浏览器 API、没有任何 import —— Node 侧脚本可直接 import 做校验。
 *
 * MiniSearch 默认按空白切词，一整句中文会变成一个巨型 token，CJK 检索因此基本失效。
 * 这里改为「拉丁词 + CJK 单字与二元组」：二元组能拿到近似短语级的召回，又不必引入词典分词器。
 */

/** 拉丁词允许内部连字符（`state-of-the-art`），但必须以字母数字或 `_`、`$` 开头。 */
const LATIN_WORD = /[A-Za-z0-9_$][A-Za-z0-9_$-]*/g
/** CJK 连续段：扩展 A 区、基本区、兼容表意文字、假名。同一段内整体出 token，不跨段拼二元组。 */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g

/**
 * 供 MiniSearch 的 `tokenize` 选项使用；索引与查询必须走同一个函数，否则 token 对不上。
 * 统一小写 —— 大小写归一只在这里做一次。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const m of text.matchAll(LATIN_WORD)) tokens.push(m[0].toLowerCase())
  for (const m of text.matchAll(CJK_RUN)) {
    const run = m[0]
    for (let i = 0; i < run.length; i++) {
      // 每个位置同时产出单字与二元组：单字保证单字查询有结果，二元组负责区分相邻语序。
      tokens.push(run[i])
      if (i + 1 < run.length) tokens.push(run.slice(i, i + 2))
    }
  }
  return tokens
}

/** 以首次命中为中心的摘要片段，并顺手抹掉 markdown 噪声。 */
export function buildExcerpt(body: string, query: string): string {
  // 顺序敏感：先剥 frontmatter 与代码块（二者可能含成对的 `#`、```），再清理行内标记符号。
  const plain = body
    .replace(/^---[\s\S]*?^---\s*/m, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, '$1')
    .replace(/[#>*_`~[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  // 长词优先：短词（如单个 CJK 字）容易在无关位置命中，会把窗口中心带偏。
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)

  let at = -1
  for (const term of terms) {
    const found = plain.toLowerCase().indexOf(term.toLowerCase())
    if (found !== -1) {
      at = found
      break
    }
  }
  // 一个词都没命中（分词命中但未原样出现）时退回开头，好过返回空串。
  if (at === -1) return plain.slice(0, 120)

  const start = Math.max(0, at - 40)
  const end = Math.min(plain.length, at + 100)
  return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`
}
