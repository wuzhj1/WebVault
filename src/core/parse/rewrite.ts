/**
 * 重命名/移动时对双链做外科手术式改写。
 *
 * 只替换 `[[...]]` 内部的目标片段——别名、小节、块引用、周围空白以及文件的其余每一个字节
 * 都原样保留。这一点很关键：一次「顺手把笔记重新格式化」的重命名会在下次同步时变成一条
 * 无谓的 diff。
 *
 * 硬约束：只用相对导入（验证脚本以裸 node 直跑，无 `@/` 别名解析），且运行时不导入 `db.ts`。
 */
import { forEachProseLine, wikilinkSpans } from './links.ts'

/** 一条改写规则：先用 `shouldRewrite` 判定，再由 `replacement` 给出新目标文本。 */
export interface RewriteRule {
  shouldRewrite(target: string): boolean
  replacement(target: string): string
}

/** 改写产物：新文本 + 实际改动的链接数。 */
export interface RewriteResult {
  text: string
  changed: number
}

/**
 * 按 `rule` 改写整篇笔记里的双链目标，其余字节逐一保持原样。
 * 行内代码、围栏代码与 frontmatter 中形似双链的内容不会被碰（沿用 `forEachProseLine` 的屏蔽）。
 */
export function rewriteWikilinks(markdown: string, rule: RewriteRule): RewriteResult {
  const lines = markdown.split('\n')
  let changed = 0

  forEachProseLine(markdown, (i, _raw, masked) => {
    const edits: { start: number; end: number; text: string }[] = []

    for (const span of wikilinkSpans(masked)) {
      if (span.target === '' || !rule.shouldRewrite(span.target)) continue
      const next = rule.replacement(span.target)
      const current = lines[i].slice(span.targetStart, span.targetEnd)
      // 一字不差时跳过：既不改字节，也不把「本来就等于新值」计入 changed。
      if (next === current.trim() && current === next) continue
      edits.push({ start: span.targetStart, end: span.targetEnd, text: next })
    }

    if (edits.length === 0) return
    // 从右往左应用，前面的偏移才不会被后面的替换挪动。
    edits.sort((a, b) => b.start - a.start)
    let line = lines[i]
    for (const e of edits) {
      line = line.slice(0, e.start) + e.text + line.slice(e.end)
      changed++
    }
    lines[i] = line
  })

  return { text: lines.join('\n'), changed }
}
