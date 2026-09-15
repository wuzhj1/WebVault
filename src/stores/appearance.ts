import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { applyAppearance, readStoredAppearance, storeAppearance, type Appearance } from '@/core/theme/apply.ts'
import { isAccent, themeById } from '@/core/theme/themes.ts'

export const useAppearanceStore = defineStore('appearance', () => {
  const stored = readStoredAppearance()
  const theme = ref(stored.theme)
  const accent = ref(stored.accent)

  const mode = computed(() => themeById(theme.value).mode)

  function commit(): void {
    const next: Appearance = { theme: theme.value, accent: accent.value, mode: mode.value }
    applyAppearance(next)
    storeAppearance(next)
  }

  function setTheme(id: string): void {
    const next = themeById(id)
    if (next.id === theme.value) return
    theme.value = next.id
    commit()
  }

  function setAccent(id: string): void {
    if (!isAccent(id) || id === accent.value) return
    accent.value = id
    commit()
  }

  return { theme, accent, mode, setTheme, setAccent }
})
