/**
 * 快照抹除凭据 —— 导出备份前把敏感字段置空。
 *
 * 为什么单独成模块：`backup.ts` 依赖 Dexie + OPFS，没法被裸 node 直跑的验证脚本加载；
 * 而「备份文件绝不能带走密码」是一条安全约束，必须有断言钉住它，不能只靠肉眼看一遍
 * （同 `flush-state.ts` 从 `datafiles.ts` 抽出来的处理方式）。
 *
 * 纯模块：只用相对导入，不碰 `db.ts`，运行时不得引入任何浏览器 API。
 */

/**
 * 凭据字段名。**整串匹配**（`^…$`）而不是包含匹配 —— `tokenCount`、`lastTokenAt` 这类
 * 计数/时间戳字段不属于凭据，被误抹成空串反而毁掉快照的可读性。
 * 正则非全局，重复 `test` 不携带 `lastIndex` 状态。
 */
const SECRET_KEY = /^(token|password|secret|api[-_]?key|credential|authorization)$/i

/**
 * 递归抹空凭据字段。命中的键**置为 `''` 而不是删掉** —— 保留键才能让快照形状与
 * `.config/settings.json` 原件一致，读的人也看得出「这里本来有东西、导出时被移除了」。
 *
 * 只下钻**数组与普通对象**（原型为 `Object.prototype` 或 null）。入参通常来自 JSON.parse，
 * 但万一夹了 `Date` 之类，摊成 `{}` 会让快照凭空少一段内容 —— 非普通对象原样返回，
 * 交给 JSON.stringify 按自己的规则序列化。
 *
 * 这是个纯函数，不 mutate 入参。
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? '' : redactSecrets(item)
    }
    return out
  }
  return value
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
