import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getSetting, putSetting } from '@/core/db.ts'
import type { GiteeConfig } from '@/core/sync/gitee.ts'

export interface SyncSettings extends GiteeConfig {
  autoSync: boolean
  /** Idle time after an edit before a push is attempted. */
  pushDelayMs: number
}

const DEFAULTS: SyncSettings = {
  token: '',
  owner: '',
  repo: '',
  branch: 'master',
  autoSync: true,
  pushDelayMs: 15_000,
}

const KEY = 'sync-settings'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<SyncSettings>({ ...DEFAULTS })
  const loaded = ref(false)

  const configured = computed(
    () =>
      settings.value.token.trim() !== '' &&
      settings.value.owner.trim() !== '' &&
      settings.value.repo.trim() !== '' &&
      settings.value.branch.trim() !== '',
  )

  const giteeConfig = computed<GiteeConfig>(() => ({
    token: settings.value.token.trim(),
    owner: settings.value.owner.trim(),
    repo: settings.value.repo.trim(),
    branch: settings.value.branch.trim() || 'master',
  }))

  async function load(): Promise<void> {
    const stored = await getSetting<Partial<SyncSettings>>(KEY, {})
    settings.value = { ...DEFAULTS, ...stored }
    loaded.value = true
  }

  async function save(patch: Partial<SyncSettings>): Promise<void> {
    settings.value = { ...settings.value, ...patch }
    await putSetting(KEY, settings.value)
  }

  return { settings, loaded, configured, giteeConfig, load, save }
})
