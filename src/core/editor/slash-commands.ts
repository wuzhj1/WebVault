/**
 * Slash-command table for the editor's `/` hint menu.
 *
 * Values are markdown fragments, not finished blocks: Vditor appends a trailing space to
 * whatever the hint inserts, which is exactly the space `#`/`-`/`>` need to become a block
 * marker. Multi-line fragments rely on `hint.parse: true`, so they go through Lute and land
 * as real IR blocks instead of collapsed HTML text.
 */
export interface SlashCommand {
  label: string
  alias: string
  insert: string | (() => string)
}

const COMMANDS: SlashCommand[] = [
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

/** Vditor's hint list renders at most 8 rows, so ordering doubles as the default ranking. */
export function slashHint(query: string): { html: string; value: string }[] {
  const q = query.trim().toLowerCase()
  return COMMANDS.filter(
    (c) => q === '' || c.label.toLowerCase().includes(q) || c.alias.toLowerCase().includes(q),
  ).map((c) => ({
    html: `<span class="slash-hint__alias">${c.alias}</span>${c.label}`,
    value: typeof c.insert === 'function' ? c.insert() : c.insert,
  }))
}
