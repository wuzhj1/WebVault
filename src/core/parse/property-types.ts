/**
 * 属性类型：把 frontmatter 里的一行映射成「该用哪种控件编辑它」。
 *
 * 这是纯函数模块，跟 `frontmatter.ts` 同一批硬约束：
 * 1. 只用相对导入。`scripts/verify-frontmatter.mts` 以裸 node 直跑，没有别名解析器。
 * 2. 不得在运行时导入 `../db.ts`；它在模块作用域构造 Dexie。类型用 `import type` 没问题。
 *
 * 本模块刻意**不读文件、不碰存储**，只回答一个问题：给定一个 key 和它在块里的原始 value，
 * 该渲染成什么控件。注册表（用户显式声明的类型）由调用方传进来，缺省时按值推断。
 *
 * 一条贯穿始终的原则：**引号是作者明确声明「这是字符串」**。`title: 'true'` 不是开关、
 * `version: '3'` 不是数字，哪怕解码后它们长得一样。所以推断只看**未解码**的原样值 ——
 * 推断错方向的代价不对称：把日期渲染成文本框，用户还能照样改；把一个标题渲染成开关，
 * 用户随手一碰就改坏了值。
 */
import { isValidPropertyKey, readRaw, type Frontmatter } from './frontmatter.ts'

/** 属性控件的五种类型；与 Obsidian Properties 的常用子集对齐。 */
export const PROPERTY_TYPES = ['text', 'list', 'number', 'checkbox', 'date'] as const

/** `PROPERTY_TYPES` 中某个值的字面量类型。 */
export type PropertyType = (typeof PROPERTY_TYPES)[number]

/** 每个 key 显式声明的类型；未出现的 key 按值推断（见 `resolveType`）。 */
export type PropertyTypeRegistry = Record<string, PropertyType>

/** 控件下拉里显示的名字。与类型值分开，是因为改中文标签不该动持久化数据。 */
export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  text: '文本',
  list: '列表',
  number: '数字',
  checkbox: '勾选',
  date: '日期',
}

/** 一个常被当成类型写、实则只是普通文本的值：YAML 保留字与空值。 */
const SCALAR_TRUE_FALSE = /^(true|false)$/i
/** 整数或小数。带引号的 `'3'` 不匹配 —— 引号是作者说「这是字符串」。 */
const SCALAR_NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/
/** 只认 `YYYY-MM-DD`。带时刻的 `2026-10-14 08:30` 归文本：date 控件会把时刻截掉，那是丢数据。 */
const SCALAR_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 按原样 value 推断类型；key 缺失（`raw === null`）或值为空一律文本。
 *
 * 判定顺序有讲究：flow list 先看起始括号（`[]` 也是列表），然后才是标量的三种形态。
 * 全部在**未解码**的原样值上判断，理由见模块头。
 */
export function inferType(raw: string | null): PropertyType {
  if (raw === null) return 'text'
  const value = raw.trim()
  if (value === '') return 'text'
  if (value.startsWith('[')) return 'list'
  if (SCALAR_TRUE_FALSE.test(value)) return 'checkbox'
  if (SCALAR_DATE.test(value)) return 'date'
  if (SCALAR_NUMBER.test(value)) return 'number'
  return 'text'
}

/**
 * 这个 key 该用什么控件：注册表显式声明优先，否则按块里的原样值推断。
 *
 * 注册表优先是必要的 —— 空值、新 key 都推断不出来，而用户显然希望「新配的 category 是下拉」
 * 不必等到字段里先有值才生效。
 */
export function resolveType(
  fm: Frontmatter,
  key: string,
  registry: PropertyTypeRegistry,
): PropertyType {
  const declared = registry[key] as PropertyType | undefined
  if (declared !== undefined && (PROPERTY_TYPES as readonly string[]).includes(declared)) {
    return declared
  }
  return inferType(readRaw(fm, key))
}

/**
 * 把存下来的注册表洗干净再用。设置值是 JSON，可能被手改、可能是旧版本写的、可能是同步
 * 合并出来的半截对象 —— 拿到什么就信什么的话，一个 `type: "bogus"` 会让控件渲染崩掉。
 *
 * 顺带把非法键名也挡在外面：注册表里留一个解析侧认不出的键名，就是留一条永远选不中的配置。
 */
export function parseTypeRegistry(raw: unknown): PropertyTypeRegistry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: PropertyTypeRegistry = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue
    if (!(PROPERTY_TYPES as readonly string[]).includes(value)) continue
    if (!isValidPropertyKey(key)) continue
    out[key] = value as PropertyType
  }
  return out
}
