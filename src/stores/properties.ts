/**
 * 属性类型注册表的 store：`key → 控件类型`，持久化到 Dexie 的 settings 表，
 * 分流落在 `.webvault/app.json`（键名见 `SETTING_KEYS.propertyTypes`，未登记故走未知键回落）。
 *
 * 存的是**用户显式声明**的类型；没声明的 key 由 `core/parse/property-types.ts` 按值推断，
 * 所以这份注册表只需要记住「推断不出来的」与「推断错的」——不必为每个字段建档。
 *
 * 它同时兼任属性名的建议来源（Obsidian 同样是「见过就记住」）：配置过的 key 一定是用户用过的。
 * 所以这里的键名必须过 `isValidPropertyKey`，留一条解析侧认不出的键名进去，就是留一条
 * 永远选不中、也永远删不掉的配置。
 *
 * 硬约束：只能在浏览器里跑（Pinia + IndexedDB）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getSetting, putSetting } from '@/core/db.ts'
// 键名在 core/vault/config-layout.ts 声明；它决定这份配置落进 .webvault/app.json。
import { SETTING_KEYS } from '@/core/vault/config-layout.ts'
import { isValidPropertyKey } from '@/core/parse/frontmatter.ts'
import { parseTypeRegistry, type PropertyType, type PropertyTypeRegistry } from '@/core/parse/property-types.ts'

/** settings 表里的行键。 */
const KEY = SETTING_KEYS.propertyTypes

export const usePropertiesStore = defineStore('properties', () => {
  /** 内存里的注册表，初值为空（= 全部按值推断），`load` 读库后整体替换。 */
  const types = ref<PropertyTypeRegistry>({})
  /** 是否已从 IndexedDB 读完。未读完前的空表不能当成「用户没配过任何类型」。 */
  const loaded = ref(false)

  /**
   * 从 Dexie 读入整份注册表（从未存过时为空表），读完置 `loaded = true`。
   * 带重入守卫：设置页与 App 启动两处都会调，重复调用不产生第二次读库。
   */
  let loading: Promise<void> | null = null
  function load(): Promise<void> {
    if (loaded.value) return Promise.resolve()
    if (loading) return loading
    loading = (async () => {
      // 过一遍洗牌：设置值是 JSON，可能被手改、可能是旧版本写的、也可能是同步合并出来的半截对象。
      types.value = parseTypeRegistry(await getSetting<unknown>(KEY, {}))
      loaded.value = true
    })()
    return loading
  }

  /**
   * 给 `key` 声明类型并立刻落盘；传 `null` 表示撤回声明（该 key 从此按值推断）。
   *
   * 非法键名直接抛错而不是静默丢弃 —— 静默丢弃的表现是「UI 上选了、刷新后又变回去」，
   * 而那是本设计里最难查的一类失效。
   */
  async function setType(key: string, type: PropertyType | null): Promise<void> {
    if (!isValidPropertyKey(key)) throw new Error(`非法的属性名 ${JSON.stringify(key)}`)
    const next: PropertyTypeRegistry = { ...types.value }
    if (type === null) delete next[key]
    else next[key] = type
    // 再洗一次：写进去的必须是能原样读回来的形状，这条链路上任何一环都不能是例外。
    types.value = parseTypeRegistry(next)
    await putSetting(KEY, types.value)
  }

  return { types, loaded, load, setType }
})
