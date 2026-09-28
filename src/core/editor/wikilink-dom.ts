/**
 * 把 Vditor IR DOM 里的 `[[双链]]` 文本装饰成可点击的样式胶囊（chip）。
 *
 * 原文的每一个字符都留在 DOM 里——括号、别名里的 `path|` 半截只用 CSS 隐藏，绝不删除。
 * IR 模式每敲一个键就把块的 HTML 序列化回 markdown，而 Lute 会把未知行内 span 的文本内容
 * 原样透传，所以 `[[a/b|别名]]` 能逐字节往返。在这里丢字符就等于悄悄改写用户的笔记。
 *
 * 光标所在的块完全不动：装饰它会拆掉选区下面的文本节点、把光标挤跑。取而代之的是给该块
 * 加一个 class，用 CSS 显示原始 markdown——这正是 Obsidian live preview 的行为。
 *
 * 装饰是增量的：调用方把 MutationObserver 记下的新增/改写节点与刚离开光标的块作为种子传入，
 * 每轮只走这些子树；光标块标记同样只动上一次那一个元素。
 *
 * 硬约束：只增删 class 与装饰 span，绝不删除、改写任何原文字符；
 * 如需引入其他模块，一律用相对导入，且运行时不得导入 `db.ts`（`import type` 安全）。
 */

/** 胶囊的三种解析状态：已解析的笔记 / 尚不存在的目标 / 附件。 */
export type WikilinkKind = 'note' | 'new' | 'asset'

/** 解析查询的结果，供胶囊决定配色与悬停提示。 */
export interface WikilinkLookup {
  kind: WikilinkKind
  /** 已解析的笔记路径；`new` 状态为 null */
  path: string | null
}

/** 给定链接目标，返回它的解析状态；由 NoteEditor 注入，模块本身不碰索引/数据库。 */
export type WikilinkResolver = (target: string) => WikilinkLookup

/** 加在当前光标所在块上的 class，使其显示为原始 markdown。 */
export const ACTIVE_BLOCK_CLASS = 'wl-active'

/** 双链（含 `!` 前缀嵌入）；与 `parse/links.ts` 的正则保持同构，括号内不做嵌套匹配。 */
const WIKILINK = /(!?)\[\[([^\[\]]+?)\]\]/g

/**
 * 文本节点是否本轮该被装饰：含 `[[`、不在代码块/胶囊里、且不属于光标所在的活动块。
 * 全量扫与按种子扫共用同一判据——两者对同一节点的结论必须一致。
 */
function acceptText(node: Text, caretBlock: HTMLElement | null, root: HTMLElement): boolean {
  const value = node.nodeValue
  if (!value || !value.includes('[[')) return false
  const parent = node.parentElement
  if (!parent || inCodeOrChip(parent, root)) return false
  if (caretBlock && (caretBlock === parent || caretBlock.contains(parent))) return false
  return true
}

/**
 * 装饰光标块之外的双链，返回构建的胶囊数量。
 *
 * `seeds` 给出本轮值得检查的子树（MutationObserver 记下的新增/改写节点、刚离开光标块的
 * 活动块）：只走这些种子，不再每次全树 TreeWalker——大文档里逐键输入的开销从 O(整篇)
 * 降到 O(被改的那个块)。`seeds` 省略时退回全量（首次兜底、全量请求）。
 */
export function decorateWikilinks(
  root: HTMLElement,
  resolve: WikilinkResolver,
  seeds?: Iterable<Node>,
): number {
  const caretBlock = blockWithCaret(root)
  /** 先收集再动手：替换文本节点会让 TreeWalker 正在遍历的树失效；Set 兼作种子重叠去重。 */
  const targets = new Set<Text>()

  const collect = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text
      if (acceptText(text, caretBlock, root)) targets.add(text)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        acceptText(n as Text, caretBlock, root) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    })
    while (walker.nextNode()) targets.add(walker.currentNode as Text)
  }

  if (seeds === undefined) {
    collect(root)
  } else {
    for (const seed of seeds) {
      // 被换掉的块（种子已脱离文档）与其不在根内的副本都不用管，对应的替换子树另有种子。
      if (!seed.isConnected || !root.contains(seed)) continue
      collect(seed)
    }
  }

  let built = 0
  for (const node of targets) built += decorateTextNode(node, resolve)
  return built
}

/**
 * 元素是否位于代码块或已装饰的胶囊内——这两处的 `[[` 都不该再被装饰。
 * Vditor 的 IR 根节点本身就是一个 `<pre class="vditor-reset">`，裸写 `closest('pre')`
 * 会匹配到整个编辑器；只有根节点**内部**的 `pre`/`code` 才算代码块。
 */
function inCodeOrChip(el: Element, root: HTMLElement): boolean {
  if (el.closest('.wl') !== null) return true
  const host = el.closest('pre, code')
  return host !== null && host !== root
}

/** 每个根上一次被标记为活动的块；增量摘除靠它，省掉每次全树 querySelectorAll。 */
const lastActiveByRoot = new WeakMap<HTMLElement, HTMLElement | null>()

/**
 * 在正在编辑的块上显示原始 markdown。只增删 class，绝不改结构。
 *
 * 增量策略：记住每个根上次标记的块，只摘它一个；首个根（或热重载后没有记录）才全量清一次，
 * 兼容任何来源的陈旧标记。新活动块可能是刚换上来的新节点，直接加上即可。
 */
export function markActiveBlock(root: HTMLElement): HTMLElement | null {
  const active = blockWithCaret(root)
  const prev = lastActiveByRoot.get(root)
  if (prev === undefined) {
    for (const el of root.querySelectorAll<HTMLElement>(`.${ACTIVE_BLOCK_CLASS}`)) {
      if (el !== active) el.classList.remove(ACTIVE_BLOCK_CLASS)
    }
  } else if (prev && prev !== active) {
    // prev 已被 Vditor 换掉时它随旧节点一起消失了，对游离节点摘 class 是无害的空操作。
    prev.classList.remove(ACTIVE_BLOCK_CLASS)
  }
  active?.classList.add(ACTIVE_BLOCK_CLASS)
  lastActiveByRoot.set(root, active)
  return active
}

/** 事件命中的胶囊；正在编辑的块里的胶囊不算数（那里显示的是原始 markdown）。 */
export function chipFromEvent(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const chip = target.closest<HTMLElement>('.wl')
  if (!chip) return null
  return chip.closest(`.${ACTIVE_BLOCK_CLASS}`) === null ? chip : null
}

/**
 * 光标当前所在的顶层块；拿不到光标时退回「最后一个标记为 active 的块」，
 * 这样单纯移动焦点（如勾选任务）不会导致展开状态闪烁。
 */
function blockWithCaret(root: HTMLElement): HTMLElement | null {
  const selection = document.getSelection()
  const anchor = selection && selection.rangeCount > 0 ? selection.anchorNode : null
  if (anchor && anchor !== root && root.contains(anchor)) {
    // 聚焦复选框时，选区锚在 <li> 上、偏移指向 <input>，那并不是光标，
    // 因此保持现有展开状态不动。
    const pointed = anchor.nodeType === Node.ELEMENT_NODE
      ? (anchor as HTMLElement).childNodes[selection?.anchorOffset ?? 0] ?? anchor
      : anchor
    if (pointed instanceof HTMLInputElement) {
      return root.querySelector<HTMLElement>(`.${ACTIVE_BLOCK_CLASS}`)
    }
    return blockOf(root, anchor)
  }
  const focused = document.activeElement
  if (!(focused instanceof HTMLElement) || focused === root || !root.contains(focused)) return null
  // 勾选任务复选框会移动焦点但不移动光标。若因此展开（或折叠）该行，
  // 链接胶囊的颜色会闪一下，所以维持当前展开状态。
  if (focused.tagName === 'INPUT') return root.querySelector<HTMLElement>(`.${ACTIVE_BLOCK_CLASS}`)
  return blockOf(root, focused)
}

/** 从节点沿父链上溯到 `root` 的直接子节点，即它所属的顶层块。 */
function blockOf(root: HTMLElement, node: Node): HTMLElement | null {
  let current: Node = node
  while (current.parentNode && current.parentNode !== root) current = current.parentNode
  return current instanceof HTMLElement ? current : null
}

/**
 * 把一个含双链的文本节点切成「普通文本 + 胶囊」的片段并整体替换。
 * 普通文本原样搬过去，因此除双链自身外没有任何字节丢失。
 */
function decorateTextNode(node: Text, resolve: WikilinkResolver): number {
  const value = node.nodeValue ?? ''
  const matches = [...value.matchAll(WIKILINK)]
  if (matches.length === 0) return 0

  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const match of matches) {
    const start = match.index ?? 0
    if (start > cursor) fragment.append(document.createTextNode(value.slice(cursor, start)))
    fragment.append(buildChip(match[1] === '!', match[2], resolve))
    cursor = start + match[0].length
  }
  if (cursor < value.length) fragment.append(document.createTextNode(value.slice(cursor)))

  node.replaceWith(fragment)
  return matches.length
}

/**
 * 构建一颗胶囊：`!`、`[[`、路径、锚点标记、锚点、`|`、别名、`]]` 按原文顺序逐个落位，
 * 只有括号和 `|` 带 `wl__bracket` class 交给 CSS 隐藏——原文字符一个都不能少。
 */
function buildChip(embed: boolean, inner: string, resolve: WikilinkResolver): HTMLElement {
  const pipe = inner.indexOf('|')
  const targetPart = pipe === -1 ? inner : inner.slice(0, pipe)
  const alias = pipe === -1 ? '' : inner.slice(pipe + 1)

  const cut = anchorCut(targetPart)
  const path = cut === -1 ? targetPart : targetPart.slice(0, cut)
  const anchorMarker = cut === -1 ? '' : targetPart[cut]
  const anchor = cut === -1 ? '' : targetPart.slice(cut + 1)

  const { kind, path: resolved } = resolve(path)

  const el = document.createElement('span')
  el.className = `wl wl--${kind}`
  if (embed) el.classList.add('wl--embed')
  if (alias.trim() !== '') el.classList.add('wl--alias')
  el.dataset.target = path
  el.dataset.resolved = resolved ?? ''
  el.title =
    kind === 'note'
      ? `打开 ${resolved}`
      : kind === 'new'
        ? `创建 ${path}`
        : '附件暂不支持预览'

  if (embed) el.append(bracket('!'))
  el.append(bracket('[['))
  el.append(part(path, 'wl__path'))
  if (anchorMarker !== '') {
    el.append(bracket(anchorMarker))
    el.append(part(anchor, 'wl__anchor'))
  }
  if (pipe !== -1) {
    el.append(bracket('|'))
    el.append(part(alias, 'wl__alias'))
  }
  el.append(bracket(']]'))
  return el
}

/** 用 `wl__bracket` class 包裹的原文字符（视觉隐藏但仍在序列化里）。 */
function bracket(text: string): HTMLElement {
  return part(text, 'wl__bracket')
}

/** 把一段原文包成带指定 class 的行内 span。 */
function part(text: string, className: string): HTMLElement {
  const el = document.createElement('span')
  el.className = className
  el.append(document.createTextNode(text))
  return el
}

/** 目标里锚点（`#小节` 或 `^块`）的起始下标；两者都有取更早的那个，都没有返回 -1。 */
function anchorCut(target: string): number {
  const hash = target.indexOf('#')
  const caret = target.indexOf('^')
  if (hash === -1) return caret
  if (caret === -1) return hash
  return Math.min(hash, caret)
}
