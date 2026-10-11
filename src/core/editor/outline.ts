/**
 * 大纲（笔记的标题列表）——从 IR DOM 里读出来，供右栏「大纲」页签与「点条目跳转」共用。
 *
 * **为什么不从 markdown 源码解析**：`parse/links.ts` 的 ATX 正则（行首 `#`）抓不到两
 * 类标题，而 Vditor 会把它们照样渲染成真正的 `h1..h6`：
 *   - 引用块里的标题：`> # 标题`，原始行的行首是 `>`；
 *   - setext 下划线标题：`标题` + `===`（或 `---`），压根不是 ATX。
 * 实测同一篇里源码能抓 3 个、DOM 里有 5 个 —— 按源码顺序给 DOM 下标做跳转必然错位。
 * 所以**大纲的下标只能以 DOM 为准**：正文渲染出几个标题，就列几行。
 *
 * 反过来，代码围栏里的 `# xxx` 在 DOM 里落在 `<pre>` 内、不是 heading 元素，
 * 天然被排除，与源码那条「跳过代码块」的规则殊途同归。
 *
 * 硬约束：只读 DOM，不增删改任何原文字符；如需引入其他模块一律用相对导入，
 * 且运行时不得导入 `db.ts`（验证脚本以裸 node 直跑本文件）。
 */

/** 大纲的一条。`下标` 即它在标题序列里的位置，跳转时按这个下标回查 DOM。 */
export interface OutlineItem {
  /** 1-6，取自 `h1..h6` 标签名。 */
  level: number
  /** 洗掉 markdown 标记后的标题文字；**空标题也保留一条**，见下。 */
  text: string
}

/**
 * 所有标题元素的选择器：`h1..h6` 全算，引用块内的也不排除。
 *
 * **导出给 NoteEditor 的跳转用**：列大纲与按下标跳转必须查同一组元素，
 * 两边各写一份选择器迟早会分叉，下标就不再对应。
 *
 * 刻意不按「文字非空」过滤：空标题（`# ` 敲到一半）同样是 DOM 里的一个 heading，
 * 一旦在这里被丢掉，后续每一条的下标就整体前移一位，点第 N 行会跳到第 N-1 节。
 * 空行显示什么由视图层决定，索引这边只负责位置对齐。
 */
export const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6'

/**
 * 把标题元素的 `textContent` 洗成可读标题。
 *
 * Vditor IR 把 markdown 标记一起渲染进了文本，两者 `textContent` 里都带着标记：
 *   - ATX：`<span data-type="heading-marker"># </span>标题` → `# 标题`
 *   - setext：`标题<span data-type="heading-marker">========</span>` → `标题\n========`
 * 照抄到面板上会显示成 `# 标题` 或 `标题 =======`，所以要洗。
 *
 * 四步顺序有意义：先折叠空白（setext 的换行与多行标题都要压成一行），再依次摘标记，
 * 最后补一次 trim（摘掉尾部标记可能留下尾随空格）。
 *
 * ATX 那一步写的是 `^#{1,6}(?:\s+|$)` 而不是 `^#{1,6}\s+`：空标题（DOM 里 textContent
 * 只剩 `# `）走到这儿已经被 trim 成了单独一个 `#`，要求后面必须有空白就永远摘不掉它，
 * 面板上会显示一行字面的 `#`。放开「或行尾」不影响 `#hashtag`——那里 `#` 后面是字母。
 *
 * 刻意不碰的另一类：`C#`（`#` 前没有空白），它的 `#` 后面既不是空白也不是行尾。
 */
export function outlineTextOf(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#{1,6}(?:\s+|$)/, '')
    .replace(/\s+[=\-]{3,}$/, '')
    .replace(/\s+#{1,6}$/, '')
    .trim()
}

/**
 * 从容器里读出全部标题：顺序即文档顺序，下标可直接用于 `jumpToHeading`。
 * `root` 为 null（编辑器还没就绪）时返回空数组，而不是抛错。
 */
export function outlineOf(root: ParentNode | null): OutlineItem[] {
  if (!root) return []
  const items: OutlineItem[] = []
  for (const el of root.querySelectorAll<HTMLElement>(HEADING_SELECTOR)) {
    items.push({ level: Number(el.tagName.slice(1)), text: outlineTextOf(el.textContent ?? '') })
  }
  return items
}
