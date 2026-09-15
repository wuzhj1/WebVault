export type ThemeMode = 'dark' | 'light'

export interface ThemeInfo {
  id: string
  label: string
  mode: ThemeMode
  hint: string
}

/** id 必须与 `styles/themes.css` 里的 `data-theme` / `data-theme-preview` 选择器一一对应。 */
export const THEMES: ThemeInfo[] = [
  { id: 'night', label: '夜阑', mode: 'dark', hint: '蓝灰深色,默认' },
  { id: 'graphite', label: '曜石', mode: 'dark', hint: '中性近黑,对比最强' },
  { id: 'nord', label: '极地', mode: 'dark', hint: '冷调蓝灰,最柔和' },
  { id: 'day', label: '白昼', mode: 'light', hint: '干净浅色' },
  { id: 'paper', label: '纸墨', mode: 'light', hint: '暖色护眼' },
]

export interface AccentInfo {
  id: string
  label: string
}

/** id 必须与 `styles/themes.css` 里的 `data-accent` 选择器一一对应。 */
export const ACCENTS: AccentInfo[] = [
  { id: 'violet', label: '紫罗兰' },
  { id: 'indigo', label: '靛蓝' },
  { id: 'sky', label: '天青' },
  { id: 'teal', label: '碧' },
  { id: 'pine', label: '松绿' },
  { id: 'orange', label: '橙' },
  { id: 'rose', label: '蔷薇' },
  { id: 'mist', label: '雾蓝' },
]

export const DEFAULT_THEME = 'night'
export const DEFAULT_ACCENT = 'violet'

export function themeById(id: string): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

export function isAccent(id: string): boolean {
  return ACCENTS.some((a) => a.id === id)
}

/**
 * 代码高亮样式必须是 Vditor `Constants.CODE_THEME` 白名单里的名字,否则会静默退回 github。
 * 这两个文件都已随 `public/vditor` 本地化,离线可用。
 */
export function codeThemeFor(mode: ThemeMode): string {
  return mode === 'dark' ? 'atom-one-dark' : 'github'
}
