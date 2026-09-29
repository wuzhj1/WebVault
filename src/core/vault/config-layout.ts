/**
 * `.webvault/` 配置目录的**形状**：目录叫什么、每张表落成哪个文件、settings 按键名怎么分流。
 *
 * 形状对齐 Obsidian 的 `.obsidian/` —— 库根只放 `.md` 与子目录，全部元数据、索引、设置收进一个
 * 隐藏配置目录；配置再按职责拆成多个小文件，而不是挤在一个 `settings.json` 里：高频变动的工作区
 * 状态（打开的文件、最近、置顶、折叠）单独一个 `workspace.json`，静态配置进 `app.json`，
 * 含明文令牌的同步配置单独成 `sync.json` —— 共享整个库之前只需清这一个文件。
 *
 * 单独成模块、不写死在 datafiles 里的三条理由：
 * - datafiles 依赖 Dexie + OPFS，验证脚本裸 node 跑不起来；本模块纯函数、只用相对导入，
 *   `scripts/verify-config-layout.mts` 能直接把「键名 → 文件」的分流钉死；
 * - datafiles 的落盘与 `backup.ts` 的导出快照共用同一份映射，包内文件名与库内原件逐字同名、
 *   可以逐字 diff；两边各写一份迟早漂移；
 * - settings 的键名在这里声明，stores 反过来 import —— 键改名而分流规则没跟上，会把设置写进
 *   另一个文件，用户看到的就是「改了个设置却找不着它」。
 *
 * 硬约束：只用相对导入，运行时不得 import `db.ts`。
 */

/** 配置目录名（对标 Obsidian 的 `.obsidian`）：带应用名，不与 Linux 的 XDG `.config` 撞名。 */
export const CONFIG_DIR = '.webvault'

/** 旧版配置目录名。启动时一次性搬迁进 `CONFIG_DIR` 后删掉，见 datafiles 的 migrateLegacyConfigDir。 */
export const LEGACY_CONFIG_DIR = '.config'

/** 旧版把全部设置挤在一个文件里；搬迁时按 `settingsFileOf` 拆成下面四个。 */
export const LEGACY_SETTINGS_FILE = 'settings.json'

/**
 * settings 表的键名注册表。改名即丢数据（老键从此没人读），所以只有这里有权声明它们；
 * stores 一律 `import { SETTING_KEYS }` 取用。值同时是分流依据，见 `settingsFileOf`。
 */
export const SETTING_KEYS = {
  /** Gitee 同步配置，value 里裹着明文 token（stores/settings.ts）。 */
  syncSettings: 'sync-settings',
  /** 上次打开的笔记，App.vue 启动时定位、stores/vault.ts 防抖写入。 */
  lastOpenPath: 'last-open-path',
  /** 侧栏「最近打开」书签（stores/ui.ts）。 */
  recentPaths: 'ui-recent-paths',
  /** 侧栏「置顶」书签（stores/ui.ts）。 */
  pinnedPaths: 'ui-pinned-paths',
  /** 文件树里处于折叠态的目录（stores/ui.ts）。 */
  collapsedDirs: 'ui-collapsed-dirs',
  /** 可改快捷键的绑定（stores/ui.ts）。 */
  shortcutBindings: 'ui-shortcut-bindings',
} as const

/**
 * 表 → 文件名清单（都落在 `CONFIG_DIR` 下）。config 表存目录句柄、存不进文件，故不在其中。
 * 统一「行数组」形状：`parseRows` 解出来的必须是数组，否则按损坏回退。
 *
 * hydrate、flush、导出备份三处都按这张表遍历 —— 加一张表就自动落盘、自动进备份，
 * 不存在「加了表忘了配文件」。
 */
export const TABLE_FILES: readonly (readonly [table: string, files: readonly string[]])[] = [
  ['notes', ['notes.json']],
  ['links', ['links.json']],
  ['tags', ['tags.json']],
  ['cards', ['cards.json']],
  ['settings', ['sync.json', 'app.json', 'hotkeys.json', 'workspace.json']],
  ['syncLog', ['sync-log.json']],
]

/** 工作区类设置：每开一篇笔记就写一次，Obsidian 把同类放 `workspace.json` 并建议 git 忽略它。 */
const WORKSPACE_KEYS: ReadonlySet<string> = new Set([
  SETTING_KEYS.lastOpenPath,
  SETTING_KEYS.recentPaths,
  SETTING_KEYS.pinnedPaths,
  SETTING_KEYS.collapsedDirs,
])

/**
 * settings 表的一个键该落进哪个文件。
 * **未知键一律回落 `app.json`** —— 新增设置忘了登记只会落错档，绝不会丢。
 */
export function settingsFileOf(key: string): string {
  if (key === SETTING_KEYS.syncSettings) return 'sync.json'
  if (key === SETTING_KEYS.shortcutBindings) return 'hotkeys.json'
  if (WORKSPACE_KEYS.has(key)) return 'workspace.json'
  return 'app.json'
}

/** 一张表的文件清单；表没登记返回空数组（调用方据此跳过，而不是写到一个 undefined 路径上）。 */
export function filesOf(table: string): readonly string[] {
  return TABLE_FILES.find(([name]) => name === table)?.[1] ?? []
}

/**
 * 一行 → 归属文件。除 settings 外都是一表一档，行归谁没有歧义；
 * settings 按键名分流，行缺 key 时按未知键归 `app.json`。
 */
export function fileOfRow(table: string, files: readonly string[], row: unknown): string {
  if (table !== 'settings') return files[0] ?? ''
  const key = (row as { key?: unknown } | null)?.key
  return settingsFileOf(typeof key === 'string' ? key : '')
}

/**
 * 把一张表的行按文件分桶。桶按 `files` 顺序预先建好，只往已有的桶里放 ——
 * 分流结果不在本表清单里时**不放进任何桶**，好让调用方数得出行数差额。
 *
 * 「每行都必须有桶」是硬不变量：漏一行等于悄悄丢设置。datafiles 的 flush 会用
 * `placed === rows.length` 复核，对不上就整体判失败而不是把半份写出去。
 */
export function partitionRows(
  table: string,
  files: readonly string[],
  rows: readonly unknown[],
): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>()
  for (const file of files) out.set(file, [])
  for (const row of rows) out.get(fileOfRow(table, files, row))?.push(row)
  return out
}

/**
 * 解析一份数据文件为行数组；不是数组（JSON 坏了、或顶层是对象/字符串）一律返回 null ——
 * 调用方按「损坏」留证并回退浏览器数据，绝不拿半个结构去覆盖表。
 */
export function parseRows(text: string): unknown[] | null {
  try {
    const rows: unknown = JSON.parse(text)
    return Array.isArray(rows) ? rows : null
  } catch {
    return null
  }
}
