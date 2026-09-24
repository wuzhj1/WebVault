/**
 * 应用级快捷键的规范化与展示：把一次 keydown 折算成平台无关的规范串，再按平台画回键帽。
 *
 * 规范形如 `mod+k`、`mod+shift+f`、`?`：`mod` 在 Windows/Linux 是 Ctrl、在 macOS 是 ⌘，
 * 两端物理按键不同但语义相同，所以存储与匹配只认 `mod`，展示时才分平台。
 *
 * 硬约束：纯函数、不碰 IndexedDB/OPFS——App 与设置页共用同一套判定，
 * 录制新键时算出的串必须和触发时算出的串一字不差，否则改完会「按了没反应」。
 */

/** 只按了修饰键/系统键：录键时要继续等下一个真按键，匹配时直接放行。 */
const MODIFIER_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'OS',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
])

/** 是否 macOS：决定 mod 画成 ⌘ 还是 Ctrl。 */
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

/** 单个修饰键的两平台写法；displayOfBinding 逐段查它。 */
function modLabel(part: string): string {
  if (part === 'mod') return IS_MAC ? '⌘' : 'Ctrl'
  if (part === 'shift') return IS_MAC ? '⇧' : 'Shift'
  return IS_MAC ? '⌥' : 'Alt'
}

/**
 * 一次按键 → 规范串；不足以构成绑定时返回 null（输入法合成中、Dead/Process、只按了修饰键）。
 * Shift 只在字母/数字/具名键上记账：标点的 Shift 已经体现在字符本身（Shift+/ 就是 ?），
 * 再记一次会把出厂的 '?' 算成 'shift+?'，永远匹配不上出厂值。
 */
export function bindingOfEvent(event: KeyboardEvent): string | null {
  if (event.isComposing) return null
  const key = event.key
  if (MODIFIER_KEYS.has(key) || key === 'Dead' || key === 'Process') return null

  const single = key.length === 1
  const letterOrDigit = single && /^[a-z0-9]$/i.test(key)
  const parts: string[] = []
  // Ctrl 与 ⌘ 都折成 mod：语义就是「平台主键」，匹配时不必分辨用户按的是哪一个
  if (event.ctrlKey || event.metaKey) parts.push('mod')
  if (event.shiftKey && (letterOrDigit || !single)) parts.push('shift')
  if (event.altKey) parts.push('alt')
  parts.push(single ? key.toLowerCase() : key)
  return parts.join('+')
}

/**
 * 规范串 → 键帽文案：macOS 连写（⇧⌘F），其余平台用 ` + ` 分隔（Ctrl + Shift + F）。
 * 按键本身可能是 `+`（Shift+= 的产物），朴素 split 会把它切碎，
 * 所以从左往右逐个剥修饰键，剥不动的整段就是按键本身。
 */
export function displayOfBinding(binding: string): string {
  if (binding === '') return ''
  const labels: string[] = []
  let rest = binding
  for (;;) {
    const i = rest.indexOf('+')
    const head = i === -1 ? '' : rest.slice(0, i)
    if (head === 'mod' || head === 'shift' || head === 'alt') {
      labels.push(modLabel(head))
      rest = rest.slice(i + 1)
      continue
    }
    labels.push(rest.length === 1 ? rest.toUpperCase() : rest)
    break
  }
  return labels.join(IS_MAC ? '' : ' + ')
}

/** 是否带平台主键；不带主键的裸键（如出厂的 `?`）在输入框/正文里必须放行。 */
export function hasMod(binding: string): boolean {
  return binding.startsWith('mod+')
}

/** 焦点是否在可输入处：输入框 / 文本域 / 内容可编辑区（含 Vditor 正文与表格单元格）。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
