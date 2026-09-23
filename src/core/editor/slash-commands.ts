/**
 * 编辑器 `/` 提示菜单的命令表。
 *
 * 值是 markdown 片段而不是成品块：Vditor 会在插入内容后补一个空格，而这恰好是
 * `#`/`-`/`>` 变成块标记所需的空格。多行片段依赖 `hint.parse: true`，从而经 Lute 解析成
 * 真正的 IR 块，而不是被压扁的 HTML 文本。
 *
 * 硬约束：如需引入其他模块，一律用相对导入，且运行时不得导入 `db.ts`（`import type` 安全）。
 */

/** 一条斜杠命令：展示名、搜索别名、插入内容。没有「纯动作」条目——动作类命令随卡片盒一并移除。 */
export interface SlashCommand {
  /** 展示在提示菜单里的中文名 */
  label: string
  /** 空格分隔的搜索关键词，匹配 label 或任一关键词即命中 */
  alias: string
  /** 插入的片段；函数形式延迟到选中时才求值（如「今天日期」）。 */
  insert: string | (() => string)
}

/** 斜杠命令表；数组顺序即提示菜单的默认排序。 */
export const COMMANDS: SlashCommand[] = [
  { label: '标题 1', alias: 'h1', insert: '#' },
  { label: '标题 2', alias: 'h2', insert: '##' },
  { label: '标题 3', alias: 'h3', insert: '###' },
  { label: '无序列表', alias: 'ul list', insert: '-' },
  { label: '有序列表', alias: 'ol', insert: '1.' },
  { label: '任务列表', alias: 'todo check', insert: '- [ ]' },
  { label: '引用', alias: 'quote', insert: '>' },
  { label: '代码块', alias: 'code', insert: '```' },
  { label: '表格', alias: 'table', insert: '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |' },
  { label: '分割线', alias: 'hr', insert: '---' },
  { label: '今天日期', alias: 'date', insert: () => new Date().toISOString().slice(0, 10) },
]

/** 按 `query` 过滤命令并渲染成 Vditor 提示项；Vditor 的提示列表最多渲染 8 行，所以排序兼任默认排名。 */
export function slashHint(query: string): { html: string; value: string }[] {
  const q = query.trim().toLowerCase()
  return COMMANDS.filter(
    (c) => q === '' || c.label.toLowerCase().includes(q) || c.alias.toLowerCase().includes(q),
  ).map((c) => ({
    html: `<span class="slash-hint__alias">${c.alias}</span>${c.label}`,
    value: typeof c.insert === 'function' ? c.insert() : c.insert,
  }))
}
