/**
 * UI 状态 store（Pinia）：只影响界面呈现、不影响文件内容的用户偏好。
 *
 * 同步边界：全部是本机状态——不写 OPFS、不进 Gitee 同步；折叠目录、最近打开、置顶、
 * 快捷键绑定四组持久化到 Dexie 的 settings 表，其余项都是纯内存的一次性标记。
 *
 * - collapsedDirs：文件树里处于折叠态的目录路径集合，持久化 key 见 `SETTING_KEYS.collapsedDirs`。
 *   首次运行（库里没有这个 key）以空集合起步，不预置任何目录，也不回写——
 *   与「推断结果永不落盘」纪律保持一致。
 * - recentPaths / pinnedPaths：侧栏笔记分区「置顶 / 最近」标签页里的「最近打开」与
 *   「置顶」两组书签，记的是本机使用习惯，不同步；持久化 key 见下方常量，
 *   与折叠目录共用 400ms 防抖落盘。
 * - bindings：可改的全局快捷键（命令 id → 平台无关规范串，形如 `mod+k`，见 core/hotkeys.ts），
 *   出厂值来自 SHORTCUT_COMMANDS，同样只存本机、不进同步。
 *
 * 卡片盒移除时一并删掉了收集箱开关（inboxOpen/inboxCollapsed）与「光标落文末」请求
 * （requestCaretAtEnd）两组状态；Dexie settings 里可能残留的卡片盒旧键无人读取，无害。
 */
import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import { getSetting, putSetting } from '@/core/db.ts'
// 键名只在 core/vault/config-layout.ts 声明一次：那里要按键名把设置分流到
// .webvault 的 app/hotkeys/workspace 三个文件，键散在 store 里迟早和分流规则对不上。
import { SETTING_KEYS } from '@/core/vault/config-layout.ts'

/** Dexie settings 表里存放折叠目录的键名；改名会让老用户的折叠状态丢失。 */
const STORAGE_KEY = SETTING_KEYS.collapsedDirs
/** 「最近打开」的键名；同样只改名不删数据，丢的只是本机书签。 */
const RECENT_KEY = SETTING_KEYS.recentPaths
/** 「置顶」的键名。 */
const PINNED_KEY = SETTING_KEYS.pinnedPaths
/** 最近打开只留这么多条：再多就不叫「最近」，而是第二棵文件树了。 */
const RECENT_MAX = 10

/** 可改快捷键的命令：id 即存储键名，label 是设置页显示名，default 是出厂绑定（规范串）。 */
export type ShortcutId = 'picker' | 'search' | 'settings' | 'cheatsheet' | 'graph'

export const SHORTCUT_COMMANDS: ReadonlyArray<{ id: ShortcutId; label: string; default: string }> = [
  { id: 'picker', label: '链接选择器', default: 'mod+k' },
  { id: 'search', label: '全库搜索', default: 'mod+f' },
  { id: 'settings', label: '打开设置', default: 'mod+,' },
  { id: 'cheatsheet', label: '快捷键速查表', default: '?' },
  { id: 'graph', label: '关系图谱', default: 'mod+g' },
]

/** 快捷键绑定在 settings 表里的键名。 */
const SHORTCUT_KEY = SETTING_KEYS.shortcutBindings

/** 出厂绑定表；load 合并与「恢复默认」都以它打底，新增命令时它自动跟着 SHORTCUT_COMMANDS 走。 */
const DEFAULT_BINDINGS: Record<ShortcutId, string> = Object.fromEntries(
  SHORTCUT_COMMANDS.map((c) => [c.id, c.default]),
) as Record<ShortcutId, string>

/** 去重（保留首次出现的顺序）并截断到 RECENT_MAX；load 合并与 addRecent 共用同一口径。 */
function capRecent(list: string[]): string[] {
  return [...new Set(list)].slice(0, RECENT_MAX)
}

export const useUiStore = defineStore('ui', () => {
  /** 折叠中的目录集合。用 shallowRef：整体替换 Set 才触发更新，避免对大集合做深层代理。 */
  const collapsedDirs = shallowRef<ReadonlySet<string>>(new Set())
  /** 最近打开的路径，队首最新；渲染时由侧栏剔除已删除的，这里只管记账。 */
  const recentPaths = ref<string[]>([])
  /** 置顶笔记的路径，顺序即用户置顶的顺序——书签的位置是用户的，不做字母排序。 */
  const pinnedPaths = ref<string[]>([])
  /** 当前快捷键绑定：命令 id → 规范串（'' = 未绑定）；出厂值打底，load 用库存快照覆盖同名项。 */
  const bindings = ref<Record<ShortcutId, string>>({ ...DEFAULT_BINDINGS })
  /** 是否已读过库，保证 load() 幂等（多组件同时调用也只查一次 Dexie）。 */
  let loaded = false

  /**
   * 从 Dexie 载入四组持久化状态。必须先置 loaded = true 再 await：多个组件可能同时调用，
   * 只允许第一次真正读库，其余直接返回（哪怕此时数据还没就绪）。
   */
  async function load(): Promise<void> {
    if (loaded) return
    loaded = true
    // 先记下内存里的既有条目再读库：启动定位可能在 load 之前就 addRecent 过一次，
    // 下面必须「合并」而不是「覆盖」，否则那一条会被库里的旧快照冲掉。
    const memRecent = recentPaths.value.length
    const [stored, storedRecent, storedPinned, storedBindings] = await Promise.all([
      getSetting<string[]>(STORAGE_KEY, []),
      getSetting<string[]>(RECENT_KEY, []),
      getSetting<string[]>(PINNED_KEY, []),
      getSetting<Partial<Record<ShortcutId, string>>>(SHORTCUT_KEY, {}),
    ])
    collapsedDirs.value = new Set(stored)
    recentPaths.value = capRecent([...recentPaths.value, ...storedRecent])
    pinnedPaths.value = [...new Set([...pinnedPaths.value, ...storedPinned])]
    // 绑定走合并而非覆盖：库里只认字符串值（坏数据宁可回落出厂键，也不能让速查表渲染时炸掉），
    // 且代码新增命令后，库存快照里没有的 id 自动拿到新出厂值。
    const sane = Object.fromEntries(
      Object.entries(storedBindings).filter(([, v]) => typeof v === 'string'),
    ) as Partial<Record<ShortcutId, string>>
    bindings.value = { ...DEFAULT_BINDINGS, ...sane }
    // load 之前就记过「最近」：合并完补一次落盘，否则要等下一次动作才会写回库。
    if (memRecent > 0) schedulePersist()
  }

  /** 展开/折叠某个目录；每次改动都走统一的 400ms 防抖落盘，连续点击只写一次。 */
  function toggle(path: string): void {
    const next = new Set(collapsedDirs.value)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    collapsedDirs.value = next
    schedulePersist()
  }

  /**
   * 四组持久化状态共用的 400ms 防抖落盘：整体快照写入，避免并发写把中间态存进库，
   * 也让「连开五篇笔记」只触发一次写。
   * loaded 守卫：还没读过库就落盘，会把尚未合并的存量冲掉——load() 合并完会自己补一次。
   */
  function schedulePersist(): void {
    if (!loaded) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      void putSetting(STORAGE_KEY, [...collapsedDirs.value])
      void putSetting(RECENT_KEY, recentPaths.value)
      void putSetting(PINNED_KEY, pinnedPaths.value)
      void putSetting(SHORTCUT_KEY, bindings.value)
    }, 400)
  }

  /**
   * 记录一次打开：新条目插到队首、去重、截断到 RECENT_MAX。
   * 所有打开都从 vault.openNote 这个唯一漏斗经过（侧栏/搜索/图谱/右栏/启动定位），
   * 所以只在这里记一次账就覆盖全部入口。
   */
  function addRecent(path: string): void {
    recentPaths.value = capRecent([path, ...recentPaths.value])
    schedulePersist()
  }

  /** 置顶状态查询；侧栏两处用它：书签行的图钉标记与右键菜单文案。 */
  function isPinned(path: string): boolean {
    return pinnedPaths.value.includes(path)
  }

  /** 置顶开关：右键菜单只有一个条目，「置顶 / 取消置顶」按当前状态翻转文案。 */
  function togglePin(path: string): void {
    pinnedPaths.value = isPinned(path)
      ? pinnedPaths.value.filter((p) => p !== path)
      : [...pinnedPaths.value, path]
    schedulePersist()
  }

  /** 清空「最近打开」：给想从导航里抹掉痕迹的用户一个一键出口（列表底部的「清空最近」）。 */
  function clearRecents(): void {
    recentPaths.value = []
    schedulePersist()
  }

  /** 某条绑定属于哪个命令：录键的冲突检测与全局触发的反查共用同一口径；无归属返回 null。 */
  function commandOf(binding: string): ShortcutId | null {
    if (binding === '') return null
    return SHORTCUT_COMMANDS.find((c) => bindings.value[c.id] === binding)?.id ?? null
  }

  /** 改绑；binding 传 '' 即解绑。整表替换触发响应式更新，再走统一防抖落盘。 */
  function setBinding(id: ShortcutId, binding: string): void {
    bindings.value = { ...bindings.value, [id]: binding }
    schedulePersist()
  }

  /** 恢复某个命令的出厂绑定。 */
  function resetBinding(id: ShortcutId): void {
    setBinding(id, DEFAULT_BINDINGS[id])
  }

  /** 落盘防抖定时器；null 表示当前无待写入。折叠/最近/置顶/绑定四组共用。 */
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  return {
    collapsedDirs,
    recentPaths,
    pinnedPaths,
    bindings,
    load,
    toggle,
    addRecent,
    isPinned,
    togglePin,
    clearRecents,
    commandOf,
    setBinding,
    resetBinding,
  }
})
