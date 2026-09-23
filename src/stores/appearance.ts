/**
 * 外观 store：主题与强调色，读写 localStorage 并把结果落到 document 的 data-* 属性上。
 *
 * 硬约束：不进 IndexedDB —— 首帧（`main.ts` 在 mount 之前）就要拿到它，那时 Dexie 还没就绪。
 * 只在浏览器里跑；store 不订阅系统 prefers-color-scheme，暗/亮由所选主题自己决定。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { applyAppearance, readStoredAppearance, storeAppearance, type Appearance } from '@/core/theme/apply.ts'
import { isAccent, themeById } from '@/core/theme/themes.ts'

export const useAppearanceStore = defineStore('appearance', () => {
  // 初值直接同步读存储：Pinia 的 setup 没有 async 阶段，等不了任何 Promise。
  const stored = readStoredAppearance()
  /** 当前主题 id，初值来自 localStorage['webvault:appearance']。 */
  const theme = ref(stored.theme)
  /** 当前强调色 id，与 theme 一起构成本次持久化的全部内容。 */
  const accent = ref(stored.accent)

  /** mode 派生自主题、不可单独设置，所以不入 state —— 避免它与 theme 各自漂移。 */
  const mode = computed(() => themeById(theme.value).mode)

  /** 应用与持久化必须成对发生，否则刷新后视觉会退回上一次的选择。 */
  function commit(): void {
    const next: Appearance = { theme: theme.value, accent: accent.value, mode: mode.value }
    applyAppearance(next)
    storeAppearance(next)
  }

  /** 未知 id 由 `themeById` 兜回默认主题；已是当前值则整条链路跳过，省掉一次 DOM 写入。 */
  function setTheme(id: string): void {
    const next = themeById(id)
    if (next.id === theme.value) return
    theme.value = next.id
    commit()
  }

  /** 非法强调色直接忽略，而不是回退默认 —— 误按不该把用户当前的配色改掉。 */
  function setAccent(id: string): void {
    if (!isAccent(id) || id === accent.value) return
    accent.value = id
    commit()
  }

  return { theme, accent, mode, setTheme, setAccent }
})
