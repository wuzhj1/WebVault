/**
 * AI 设置的 store：内存里一份 `AiConfig`，持久化到 Dexie 的 settings 表，
 * 分流落在 `.webvault/ai.json`（键名见 `SETTING_KEYS.aiSettings`）。
 *
 * 纪律与 `stores/settings.ts` 里的 Gitee token 完全同等待遇：
 * - apiKey 只存本机，字段名 `apiKey` 命中 `core/vault/redact.ts` 的 `SECRET_KEY` 正则，
 *   导出备份时被自动抹空——红名单是按字段名匹配的，这里改字段名即失去保护；
 * - 不写日志、不进任何遥测；请求时只经 `core/ai/client.ts` 发往用户自己填的地址。
 *
 * 硬约束：只能在浏览器里跑（Pinia + IndexedDB）；字段新增一律靠 `DEFAULTS` 兜底。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { getSetting, putSetting } from '@/core/db.ts'
// 键名在 core/vault/config-layout.ts 声明：它同时决定这份配置落进 .webvault/ai.json。
import { SETTING_KEYS } from '@/core/vault/config-layout.ts'
import { normalizeAiConfig, type AiConfig } from '@/core/ai/client.ts'

/** 兜底值，同时承担旧数据的向后兼容：读库时先铺一层，存过的字段覆盖其上。 */
const DEFAULTS: AiConfig = { baseUrl: '', apiKey: '', model: '' }

/** settings 表里的行键。 */
const KEY = SETTING_KEYS.aiSettings

export const useAiSettingsStore = defineStore('aiSettings', () => {
  /** 内存里的当前配置，初值即 DEFAULTS，`load` 读库后整体替换。 */
  const settings = ref<AiConfig>({ ...DEFAULTS })
  /** 是否已从 IndexedDB 读完。未读完前的默认值不能当成「用户已配置」。 */
  const loaded = ref(false)

  /** 三项都非空才算可用；有效性的最终裁判是设置页的「测试连接」。 */
  const configured = computed(
    () =>
      settings.value.baseUrl.trim() !== '' &&
      settings.value.apiKey.trim() !== '' &&
      settings.value.model.trim() !== '',
  )

  /**
   * 从 Dexie 读入整份配置（从未存过时落回 DEFAULTS），读完置 `loaded = true`。
   * 带重入守卫：面板、设置页、App 启动三处都会调，重复调用不产生第二次读库。
   */
  let loading: Promise<void> | null = null
  function load(): Promise<void> {
    if (loaded.value) return Promise.resolve()
    if (loading) return loading
    loading = (async () => {
      const stored = await getSetting<Partial<AiConfig>>(KEY, {})
      settings.value = { ...DEFAULTS, ...stored }
      loaded.value = true
    })()
    return loading
  }

  /**
   * 整体保存并立刻落盘。全部字段过 `normalizeAiConfig`：补协议、去尾斜杠、去空白——
   * 这些是粘贴地址时最常见的脏数据；apiKey 只 trim，任何多余改写都可能毁掉有效密钥。
   */
  async function save(next: AiConfig): Promise<void> {
    const fixed = normalizeAiConfig(next)
    settings.value = fixed
    await putSetting(KEY, fixed)
  }

  return { settings, loaded, configured, load, save }
})
