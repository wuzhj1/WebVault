import { DEFAULT_ACCENT, DEFAULT_THEME, isAccent, themeById, type ThemeMode } from './themes.ts'

export interface Appearance {
  theme: string
  accent: string
  mode: ThemeMode
}

/**
 * 外观存在 localStorage 而不是 IndexedDB:它必须在首帧之前就生效,而 IndexedDB 只能异步读。
 * `index.html` 里有一段内联脚本读同一个键,把属性写到 <html> 上,免得深色/浅色主题启动时闪一下。
 * 被 Safari 的防跟踪策略清掉也无所谓 —— 顶多回到默认主题,不涉及笔记数据。
 */
const KEY = 'webvault:appearance'

export function readStoredAppearance(): Appearance {
  const fallback: Appearance = { theme: DEFAULT_THEME, accent: DEFAULT_ACCENT, mode: themeById(DEFAULT_THEME).mode }
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return fallback
  }
  if (!raw) return fallback

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback

  const record = parsed as Record<string, unknown>
  const theme = typeof record.theme === 'string' ? record.theme : ''
  const accent = typeof record.accent === 'string' && isAccent(record.accent) ? record.accent : DEFAULT_ACCENT
  const info = themeById(theme)
  // 存的是不认识的主题时 themeById 会退回默认,这里跟着回退,避免属性与调色板不一致。
  return { theme: info.id, accent, mode: info.mode }
}

export function storeAppearance(appearance: Appearance): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(appearance))
  } catch {
    // 隐私模式或配额满:外观存不下不影响使用,下次启动回默认。
  }
}

export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement
  root.dataset.theme = appearance.theme
  root.dataset.mode = appearance.mode
  root.dataset.accent = appearance.accent

  // 移动端浏览器/桌面 PWA 的标题栏颜色要跟主题,否则深色主题配一条白边很割裂。
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', cssColor('--bg'))
}

let probe: HTMLElement | null = null

/**
 * 自定义属性是惰性求值的:`getPropertyValue('--accent')` 拿到的是 `var(--accent-raw)` 这种
 * 未解析的记号流,canvas 的 fillStyle 不认。挂一个隐藏探针元素,让它把变量当成真实的
 * `color` 解析出来,再读计算样式,拿到的就是 `rgb(...)`。
 */
export function cssColor(name: string): string {
  if (!probe) {
    probe = document.createElement('span')
    probe.style.display = 'none'
    document.documentElement.append(probe)
  }
  probe.style.color = `var(${name})`
  return getComputedStyle(probe).color
}
