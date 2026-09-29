/**
 * Gitee 同步设置的 store：内存里一份 `SyncSettings`，持久化到 Dexie 的 settings 表（单行 JSON）。
 * token 只存在本机（未绑定目录时是浏览器 IndexedDB，绑定后是正文目录的 `.webvault/sync.json`），
 * 从不写入代码库或日志，也不随笔记一起被同步——它是本机的凭据。
 *
 * 硬约束：只能在浏览器里跑（Pinia + IndexedDB）；store 本身不做防抖或版本迁移，字段新增一律靠
 * `DEFAULTS` 兜底 —— 旧数据缺字段时由 `{ ...DEFAULTS, ...stored }` 补齐。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getSetting, putSetting } from '@/core/db.ts'
// 键名在 core/vault/config-layout.ts 声明：它同时决定这份配置落进 .webvault/sync.json。
import { SETTING_KEYS } from '@/core/vault/config-layout.ts'
import { normalizeGiteeConfig, type GiteeConfig } from '@/core/sync/gitee.ts'

/** 同步设置的完整形状：连接信息（`GiteeConfig` 的四个字段）+ 本 store 独有的两个行为开关。 */
export interface SyncSettings extends GiteeConfig {
  /** 关闭时只做手动同步，保存笔记不再排自动推送。 */
  autoSync: boolean
  /** 一次编辑后静默多久才尝试推送。 */
  pushDelayMs: number
}

/** 兜底值，同时承担旧数据的向后兼容：读库时先铺一层，存过的字段覆盖其上。 */
const DEFAULTS: SyncSettings = {
  token: '',
  owner: '',
  repo: '',
  branch: 'master',
  autoSync: true,
  pushDelayMs: 15_000,
}

/** settings 表里的行键；整份设置合成一个 JSON 值，避免每个字段一行。 */
const KEY = SETTING_KEYS.syncSettings

export const useSettingsStore = defineStore('settings', () => {
  /** 内存里的当前设置，初值即 DEFAULTS，`load` 读库后整体替换。 */
  const settings = ref<SyncSettings>({ ...DEFAULTS })
  /** 是否已从 IndexedDB 读完。未读完前的默认值不能当成「用户已配置」来判断。 */
  const loaded = ref(false)

  /** 四项都非空才算可用；不校验 token 有效性，那要等真正打一次请求。 */
  const configured = computed(
    () =>
      settings.value.token.trim() !== '' &&
      settings.value.owner.trim() !== '' &&
      settings.value.repo.trim() !== '' &&
      settings.value.branch.trim() !== '',
  )

  /** 交给同步层的形状：全部去空白，branch 空时兜回 master，与 `normalizeGiteeConfig` 保持一致。 */
  const giteeConfig = computed<GiteeConfig>(() => ({
    token: settings.value.token.trim(),
    owner: settings.value.owner.trim(),
    repo: settings.value.repo.trim(),
    branch: settings.value.branch.trim() || 'master',
  }))

  /**
   * 从 Dexie 读入整份设置（从未存过时落回 DEFAULTS），读完置 `loaded = true`。
   * 无重入守卫：调用方约定启动时只调一次，重复调用只会用库里的最新值覆盖内存。
   */
  async function load(): Promise<void> {
    const stored = await getSetting<Partial<SyncSettings>>(KEY, {})
    settings.value = { ...DEFAULTS, ...stored }
    loaded.value = true
  }

  /**
   * 局部更新并立刻落盘。owner/repo/branch 先过 `normalizeGiteeConfig`（剥掉 URL 前后缀、去掉首尾斜杠），
   * 但 token 刻意不动 —— 任何 trim 之外的改写都可能毁掉一个有效的访问令牌。
   */
  async function save(patch: Partial<SyncSettings>): Promise<void> {
    const merged = { ...settings.value, ...patch }
    const fixed = normalizeGiteeConfig(merged)
    settings.value = { ...merged, owner: fixed.owner, repo: fixed.repo, branch: fixed.branch }
    await putSetting(KEY, settings.value)
  }

  return { settings, loaded, configured, giteeConfig, load, save }
})
