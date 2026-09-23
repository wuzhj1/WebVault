/**
 * 主题与强调色的元数据表：5 套主题、8 种强调色的 id、显示名与深浅模式，外加代码高亮配色的选法。
 *
 * 硬约束：
 * 1. 只用相对导入且不含任何浏览器 API——`scripts/verify-theme.mts` 以 plain node 直跑本文件。
 * 2. id 是与 `styles/themes.css` 的 `data-theme` / `data-accent` 选择器之间的契约，也是已持久化的
 *    用户配置：改名等于让所有人的外观回到默认。
 */
export type ThemeMode = 'dark' | 'light'

/** 单套主题的元数据。 */
export interface ThemeInfo {
  /** 与 CSS 选择器、存储值一一对应的主题 id。 */
  id: string
  /** 设置面板里的展示名。 */
  label: string
  /** 深浅模式，决定基础色板与代码高亮的配色。 */
  mode: ThemeMode
  /** 展示名下的一句提示。 */
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

/** 单种强调色的元数据。 */
export interface AccentInfo {
  /** 与 CSS 选择器、存储值一一对应的颜色 id。 */
  id: string
  /** 设置面板里的展示名。 */
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

/** 出厂默认主题（夜阑）。 */
export const DEFAULT_THEME = 'night'
/** 出厂默认强调色（紫罗兰）。 */
export const DEFAULT_ACCENT = 'violet'

/** 按 id 取主题；不认识的 id 一律退回第一项，调用方永不拿到 undefined。 */
export function themeById(id: string): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

/** 强调色 id 是否在白名单内。 */
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
