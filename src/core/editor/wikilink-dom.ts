/**
 * Turns `[[wikilink]]` text inside Vditor's IR DOM into styled, clickable chips.
 *
 * Every original character stays in the DOM — brackets and the `path|` half of an alias
 * are hidden with CSS, never removed. IR mode serializes the block's HTML back to
 * markdown on every keystroke, and Lute passes unknown inline spans through as their
 * text content, so `[[a/b|别名]]` round-trips byte for byte. Dropping characters here
 * would silently rewrite the user's note.
 *
 * The block that holds the caret is left alone entirely: decorating it would split the
 * text nodes under the selection and move the caret. Instead that block gets a class
 * that reveals the raw markdown via CSS, which is how Obsidian's live preview behaves.
 */

export type WikilinkKind = 'note' | 'new' | 'asset'

export interface WikilinkLookup {
  kind: WikilinkKind
  /** resolved note path, null for `new` */
  path: string | null
}

export type WikilinkResolver = (target: string) => WikilinkLookup

/** Class put on the block currently holding the caret, so it renders as raw markdown. */
export const ACTIVE_BLOCK_CLASS = 'wl-active'

const WIKILINK = /(!?)\[\[([^\[\]]+?)\]\]/g

/** Decorates every wikilink outside the caret's block. Returns how many chips were built. */
export function decorateWikilinks(root: HTMLElement, resolve: WikilinkResolver): number {
  const caretBlock = blockWithCaret(root)
  const targets: Text[] = []

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue
      if (!value || !value.includes('[[')) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (!parent || inCodeOrChip(parent, root)) return NodeFilter.FILTER_REJECT
      if (caretBlock && (caretBlock === parent || caretBlock.contains(parent))) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  // Collected before mutating: replacing a text node invalidates the walk.
  while (walker.nextNode()) targets.push(walker.currentNode as Text)

  let built = 0
  for (const node of targets) built += decorateTextNode(node, resolve)
  return built
}

/**
 * Vditor's IR root is itself a `<pre class="vditor-reset">`, so a bare `closest('pre')`
 * would match the whole editor. Only a `pre`/`code` *inside* the root is a code block.
 */
function inCodeOrChip(el: Element, root: HTMLElement): boolean {
  if (el.closest('.wl') !== null) return true
  const host = el.closest('pre, code')
  return host !== null && host !== root
}

/** Reveals raw markdown in the block being edited. Only toggles a class, never structure. */
export function markActiveBlock(root: HTMLElement): HTMLElement | null {
  const active = blockWithCaret(root)
  for (const el of root.querySelectorAll<HTMLElement>(`.${ACTIVE_BLOCK_CLASS}`)) {
    if (el !== active) el.classList.remove(ACTIVE_BLOCK_CLASS)
  }
  active?.classList.add(ACTIVE_BLOCK_CLASS)
  return active
}

/** The chip an event landed on, ignoring chips inside the block being edited. */
export function chipFromEvent(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const chip = target.closest<HTMLElement>('.wl')
  if (!chip) return null
  return chip.closest(`.${ACTIVE_BLOCK_CLASS}`) === null ? chip : null
}

function blockWithCaret(root: HTMLElement): HTMLElement | null {
  const selection = document.getSelection()
  const anchor = selection && selection.rangeCount > 0 ? selection.anchorNode : null
  if (anchor && anchor !== root && root.contains(anchor)) {
    // Focusing a checkbox leaves the selection anchored on the <li> with an offset pointing
    // at the <input>; that is not a caret, so keep the unfold state as it is.
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
  // Toggling a task checkbox moves focus without moving the caret. Unfolding (or folding)
  // the line for that would flash the link chips' colors, so keep the current unfold state.
  if (focused.tagName === 'INPUT') return root.querySelector<HTMLElement>(`.${ACTIVE_BLOCK_CLASS}`)
  return blockOf(root, focused)
}

function blockOf(root: HTMLElement, node: Node): HTMLElement | null {
  let current: Node = node
  while (current.parentNode && current.parentNode !== root) current = current.parentNode
  return current instanceof HTMLElement ? current : null
}

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

function bracket(text: string): HTMLElement {
  return part(text, 'wl__bracket')
}

function part(text: string, className: string): HTMLElement {
  const el = document.createElement('span')
  el.className = className
  el.append(document.createTextNode(text))
  return el
}

function anchorCut(target: string): number {
  const hash = target.indexOf('#')
  const caret = target.indexOf('^')
  if (hash === -1) return caret
  if (caret === -1) return hash
  return Math.min(hash, caret)
}
