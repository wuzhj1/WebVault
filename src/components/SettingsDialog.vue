<script setup lang="ts">
/**
 * 设置对话框：Gitee 同步、AI、外观、数据与日志、快捷键、关于六个标签页。
 *
 * emits `close` —— 焦点陷阱、ESC 关闭、遮罩点击都由外层 Modal.vue 负责，本组件只提供内容区。
 * 依赖 settings(同步配置)、aiSettings(AI 连接)、sync(连接/同步/日志)、vault(笔记索引)、
 * appearance(主题与强调色)、ui(快捷键绑定:可改的全局键存在 ui.bindings,本组件负责录键、冲突提示与恢复默认)。
 *
 * 关键约束：表单改的是 draft 副本，点「保存」才落盘，dirty 用来决定按钮是否可点；
 * 外观页是唯一例外——选项点击即写入本机存储、立刻生效，没有草稿也没有保存按钮。
 * Gitee token 只落在本机(未绑定目录时是浏览器 IndexedDB,绑定后是正文目录的 .webvault/sync.json),
 * 不会随笔记上传,也不会同步到其他设备(故 sync tab 顶部有醒目警告)。
 * AI 的 apiKey 同等待遇：明文存本机 `.webvault/ai.json`，只发往用户自己填的地址（ai tab 顶部同款警告）。
 */
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { bindingOfEvent, displayOfBinding } from '@/core/hotkeys.ts'
// 文件读写在本组件里承担五件维护动作：目录绑定/解除、探测持久化授权、重建索引时逐篇读正文、
// 清空本机正文、导出 zip 备份；导出本身在 core/vault/backup.ts，本组件只负责按钮与回执。
import * as opfs from '@/core/vault/opfs.ts'
import { buildBackup, downloadZip } from '@/core/vault/backup.ts'
import { ACCENTS, THEMES } from '@/core/theme/themes.ts'
import { useAppearanceStore } from '@/stores/appearance.ts'
import { useAiSettingsStore } from '@/stores/aiSettings.ts'
// AI 预设与探活都在 core/ai/client.ts；本组件只管按钮、草稿与回执。
import { AI_PRESETS, normalizeAiConfig, testAiConnection, type AiConfig, type AiPreset } from '@/core/ai/client.ts'
import { useSettingsStore, type SyncSettings } from '@/stores/settings.ts'
import { useSyncStore } from '@/stores/sync.ts'
import { SHORTCUT_COMMANDS, useUiStore, type ShortcutId } from '@/stores/ui.ts'
import { useVaultStore } from '@/stores/vault.ts'
import Modal from './Modal.vue'

/** 唯一对外事件：由 Modal 的关闭按钮/遮罩/ESC 冒泡上来后转给父组件卸载本对话框。 */
const emit = defineEmits<{ (e: 'close'): void }>()

/** 打开时落位的页签；App 的 ? 快捷键直达「快捷键」页，不传则默认同步页。 */
const props = defineProps<{ initialTab?: Tab }>()

/**
 * 提示图标：⚠(warn) / ⓘ(info) 两态，一处定义、全页复用。
 * 语义由旁边的文字承载，图标纯装饰（aria-hidden）；颜色走 currentColor，
 * 由 kind 决定的 `tip__ico--warn` / `tip__ico--info` 类着色（var(--warn) / var(--text-muted)，
 * 写死颜色会被 verify-theme 当场拦下）。16 网格、线宽 1.5，与顶栏/侧栏内联 SVG 同规格。
 */
const TipIcon = defineComponent({
  props: { kind: { type: String, default: 'info' } },
  setup(iconProps) {
    const base = {
      viewBox: '0 0 16 16',
      width: 15,
      height: 15,
      'aria-hidden': 'true',
      // 颜色挂在图标自己身上而不是容器上:同一枚 ⚠ 既出现在 callout 里也出现在段落提示里,
      // 靠容器选择器分色会在「普通 callout + warn 图标」的组合上染错。
      class: iconProps.kind === 'warn' ? 'tip__ico tip__ico--warn' : 'tip__ico tip__ico--info',
    }
    return () =>
      iconProps.kind === 'warn'
        ? h('svg', base, [
            h('path', { d: 'M8 1.8 L14.8 13.9 H1.2 Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }),
            h('path', { d: 'M8 6.1 v3.4', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }),
            h('circle', { cx: 8, cy: 11.7, r: 0.95, fill: 'currentColor' }),
          ])
        : h('svg', base, [
            h('circle', { cx: 8, cy: 8, r: 6.3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }),
            h('path', { d: 'M8 7.2 v4', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }),
            h('circle', { cx: 8, cy: 4.9, r: 0.95, fill: 'currentColor' }),
          ])
  },
})

const settings = useSettingsStore()
const aiSettings = useAiSettingsStore()
const sync = useSyncStore()
const vault = useVaultStore()
const appearance = useAppearanceStore()
const ui = useUiStore()

/** 标签页 id，顺序即导航栏顺序；`Tab` 由数组字面量推导出联合类型，避免和模板里的 v-if 拼错。 */
const TABS = ['sync', 'ai', 'appearance', 'data', 'shortcuts', 'about'] as const
type Tab = (typeof TABS)[number]

/** 标签页显示名，只在导航按钮上用，正文各段自带小标题。 */
const TAB_LABELS: Record<Tab, string> = {
  sync: 'Gitee 同步',
  ai: 'AI',
  appearance: '外观',
  data: '数据与日志',
  shortcuts: '快捷键',
  about: '关于',
}

/**
 * 侧栏导航图标：16 网格单路径，stroke=currentColor、线宽 1.5，与 TipIcon 同一规格。
 * 每项只存 d 串，模板统一渲染 <path>；换图标只改这里，不动模板。
 */
const TAB_ICONS: Record<Tab, string> = {
  // 上下双箭头：推送 / 拉取的往复
  sync: 'M4.8 13V3.4M4.8 3.4 2.6 5.6M4.8 3.4 7 5.6M11.2 3v9.6M11.2 12.6 9 10.4M11.2 12.6 13.4 10.4',
  // 四角星：AI 的通用「闪」
  ai: 'M8 2.2 9.45 6.55 13.8 8 9.45 9.45 8 13.8 6.55 9.45 2.2 8 6.55 6.55Z',
  // 太阳：主题 / 明暗
  appearance:
    'M5.4 8a2.6 2.6 0 1 0 5.2 0 2.6 2.6 0 1 0-5.2 0M8 1.9v1.3M8 12.8v1.3M1.9 8h1.3M12.8 8h1.3M3.7 3.7l.9.9M11.4 11.4l.9.9M12.3 3.7l-.9.9M4.6 11.4l-.9.9',
  // 数据库圆柱：存储与日志
  data: 'M3 4.4C3 3.1 5.2 2.1 8 2.1s5 1 5 2.3-2.2 2.3-5 2.3S3 5.7 3 4.4ZM3 4.4v7.2C3 12.9 5.2 13.9 8 13.9s5-1 5-2.3V4.4M3 8c0 1.3 2.2 2.3 5 2.3s5-1 5-2.3',
  // 键盘：键帽框 + 三颗键位点 + 空格
  shortcuts: 'M2.5 5.4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM5 7h.01M8 7h.01M11 7h.01M5.2 9.6h5.6',
  // 信息圈：与 TipIcon 的 ⓘ 同几何
  about: 'M1.7 8a6.3 6.3 0 1 0 12.6 0 6.3 6.3 0 1 0-12.6 0M8 7.2v4M8 4.7v.1',
}

/** 当前标签页，切换只影响渲染哪一段，不重置各段自己的草稿状态。初值来自 ? 快捷键的落位。 */
const tab = ref<Tab>(props.initialTab ?? 'sync')

/** 导航容器；方向键切换选中后把焦点挪到新项上（tablist 的 roving tabindex 约定）。 */
const navEl = ref<HTMLElement | null>(null)

/**
 * tablist 键盘漫游：上下 / 左右切页、首尾循环。Enter、Space 走 button 原生点击，不另监听；
 * Esc 留给 Modal 关闭，这里不抢。
 */
function onNavKey(event: KeyboardEvent): void {
  const delta =
    event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : 0
  if (delta === 0) return
  event.preventDefault()
  const i = TABS.indexOf(tab.value)
  tab.value = TABS[(i + delta + TABS.length) % TABS.length]
  void nextTick(() => navEl.value?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus())
}
/** 同步设置的编辑副本：只有点「保存」才写回 store，避免边打字边落盘。 */
const draft = ref<SyncSettings>({ ...settings.settings })
/** token 输入框是否在 text / password 之间切成明文，仅为当场核对粘贴对不对。 */
const showToken = ref(false)

// ---- AI 标签页的状态：与同步页同构（草稿 + 脏标记 + 保存/测试），但独立一套，互不吞草稿 ----
/** AI 设置的编辑副本：点「保存」才写回 aiSettings store。 */
const aiDraft = ref<AiConfig>({ ...aiSettings.settings })
/** apiKey 输入框的明暗切换，理由同 showToken。 */
const showAiKey = ref(false)
/** 探活进行中；按钮文案与 disabled 都靠它。 */
const aiBusy = ref(false)
/** 测试/保存的回执；`aiOk` 决定渲染成成功色还是错误色。 */
const aiInfo = ref<string | null>(null)
const aiOk = ref(false)
/** 「已保存」闪现，与同步页的 saved 各管各的。 */
const aiSaved = ref(false)
/** 「已保存」提示的闪现开关，由 save() 里的定时器收回。 */
const saved = ref(false)
/** 保存、清空正文或目录操作抛出的错误文案；下次动作开始时会清掉，防止旧错误一直挂着。 */
const error = ref<string | null>(null)
/** 存储用量的一行人类可读文本，由 refreshUsage() 填充。 */
const usage = ref<string>('')
/** 持久化存储授权：null 表示还没测出来（navigator.storage.persisted 是异步的）。 */
const persisted = ref<boolean | null>(null)
/** 重建链接/标签索引进行中；按钮文案与 disabled 都靠它。 */
const reindexing = ref(false)
/** 重建索引完成后写入处理篇数；用 null 区分「还没跑过」和「跑了但 0 篇」。 */
const reindexed = ref<number | null>(null)
/** 打包导出进行中；按钮文案与 disabled 都靠它。 */
const exporting = ref(false)
/** 导出成功后的回执（篇数 / 体积 / 文件名）；失败走 sync.notify，两者不会同时出现。 */
const exportMsg = ref<string | null>(null)
/** 清空本机正文的进行中标志：按钮文案与 disabled 都靠它。 */
const wipeBusy = ref(false)
/**
 * 危险动作的「预备」态：第一次点只上膛、不执行，第二次点才真跑。
 * 这两个动作都不可逆（清空要等重新下载、解除绑定要重走授权），而原来的按钮是
 * 一次点击直接执行 —— 手滑一下就得靠同步慢慢补。预备态超时自动收回，
 * 免得用户上膛后切走忘了，回头误以为点一下就会执行。
 */
const wipeArmed = ref(false)
const unbindArmed = ref(false)
/** 上膛后未确认的自动收回计时器，两者共用一个句柄（同一时刻只会有一个处于预备态）。 */
let disarmTimer: ReturnType<typeof setTimeout> | null = null

/** 上膛并起一个 8 秒的自动收回；再次点击由各自的 on*Click 先 disarm 再执行。 */
function arm(kind: 'wipe' | 'unbind'): void {
  wipeArmed.value = kind === 'wipe'
  unbindArmed.value = kind === 'unbind'
  if (disarmTimer) clearTimeout(disarmTimer)
  disarmTimer = setTimeout(() => {
    wipeArmed.value = false
    unbindArmed.value = false
    disarmTimer = null
  }, 8_000)
}

/** 收回预备态（执行前、切页、卸载都调），顺带清掉计时器。 */
function disarm(): void {
  wipeArmed.value = false
  unbindArmed.value = false
  if (disarmTimer) {
    clearTimeout(disarmTimer)
    disarmTimer = null
  }
}

/** 目录绑定操作（选择 / 迁移 / 解除）的进行中标志：三者共用一个，避免并发切换后端。 */
const dirBusy = ref(false)
/** 目录操作成功后的回执文案（复制了多少、跳过多少）。 */
const dirMsg = ref<string | null>(null)
/** 目录选择器可用性；Safari / Firefox 没有该 API，渲染静态提示而不是一个点了没反应的按钮。 */
const dirPickerOk = opfs.isDirPickerSupported()

/** 推送延迟的可选项；值用数字字面量分隔符写，方便和 setTimeout 的毫秒数对上。 */
const DELAYS: { ms: number; label: string }[] = [
  { ms: 5_000, label: '5 秒' },
  { ms: 15_000, label: '15 秒' },
  { ms: 60_000, label: '1 分钟' },
  { ms: 300_000, label: '5 分钟' },
  { ms: 1_800_000, label: '30 分钟' },
]

/**
 * 快捷键速查表数据：分组 → (键帽序列, 说明)，模板渲染成左键帽右说明的两列。
 *
 * - 键帽写平台无关形态（`Ctrl / ⌘`），模板用 `+` 串起来；说明只写纯文本，不嵌 HTML。
 * - 「编辑」「表格」两组是 Vditor 内建按键，照抄 `node_modules/vditor` 的
 *   `fixBrowserBehavior.ts`(表格) 与 `processKeydown.ts`(标题)——应用不再另造按键，
 *   只负责把它们写清楚；同一按键在不同上下文含义不同（如 `Ctrl/⌘ + =`），靠分组区分。
 * - 改这里须同步 README 的「快捷键」小节：两处都是用户会查的文档，漏一处就有人按不出来。
 */
const FIXED_SHORTCUTS: { group: string; rows: { keys: string[]; desc: string }[] }[] = [
  {
    group: '固定',
    rows: [{ keys: ['Esc'], desc: '关闭搜索 / 图谱 / 设置 / 各类弹窗' }],
  },
  {
    group: '链接与输入',
    rows: [
      { keys: ['单击'], desc: '编辑器里的双链胶囊:跳转,目标不存在则直接创建' },
      { keys: ['Ctrl / ⌘', '单击'], desc: '光标所在行展开为原始 markdown 后,点该行里的链接:跳转或创建' },
      { keys: ['[', '['], desc: '连续输入两个 [ 触发链接补全' },
      { keys: ['/'], desc: '行首输入斜杠:标题、列表、任务、引用、代码块、表格、分割线、日期' },
    ],
  },
  {
    group: '编辑(Vditor 内建)',
    rows: [
      { keys: ['Ctrl / ⌘', 'B'], desc: '加粗' },
      { keys: ['Ctrl / ⌘', 'I'], desc: '斜体' },
      { keys: ['Ctrl / ⌘', 'Z'], desc: '撤销' },
      { keys: ['Ctrl / ⌘', 'Y'], desc: '重做' },
      { keys: ['Ctrl / ⌘', '='], desc: '光标在标题里:升一级(少一个 #)' },
      { keys: ['Ctrl / ⌘', '-'], desc: '光标在标题里:降一级(多一个 #)' },
    ],
  },
  {
    group: '表格(光标在单元格内,Vditor 内建)',
    rows: [
      { keys: ['Tab'], desc: '跳到下一格' },
      { keys: ['Shift', 'Tab'], desc: '跳回上一格' },
      { keys: ['Ctrl / ⌘', 'Shift', 'F'], desc: '上方插一行' },
      { keys: ['Ctrl / ⌘', '='], desc: '下方插一行' },
      { keys: ['Ctrl / ⌘', 'Shift', 'G'], desc: '左侧插一列' },
      { keys: ['Ctrl / ⌘', 'Shift', '='], desc: '右侧插一列(部分键盘需按 Shift 才能出 =)' },
      { keys: ['Ctrl / ⌘', '-'], desc: '删除当前行' },
      { keys: ['Ctrl / ⌘', 'Shift', '-'], desc: '删除当前列' },
      { keys: ['Ctrl / ⌘', 'Shift', 'L / C / R'], desc: '当前列 左 / 中 / 右 对齐' },
    ],
  },
]

/** 录制中的命令 id;null = 没在录。录制期间按键由 onRecordKey 在捕获阶段截走,绕开全局快捷键。 */
const recording = ref<ShortcutId | null>(null)
/** 录制失败的原因(如组合被别的命令占用),成功或取消时清掉。 */
const recordError = ref<string | null>(null)

/** 出厂绑定查询;列表按 SHORTCUT_COMMANDS 渲染,id 必然存在,查不到只是不显示「恢复默认」。 */
function defaultOf(id: ShortcutId): string {
  return SHORTCUT_COMMANDS.find((c) => c.id === id)?.default ?? ''
}

/** 当前绑定是否已偏离出厂值:决定「恢复默认」按钮与「默认 xxx」注记显不显示。 */
function isChanged(id: ShortcutId): boolean {
  return ui.bindings[id] !== defaultOf(id)
}

/** 命令显示名;冲突提示里指名道姓说是哪条占了这个组合。 */
function labelOf(id: ShortcutId): string {
  return SHORTCUT_COMMANDS.find((c) => c.id === id)?.label ?? id
}

/** 点「修改」开始录键;再点一次取消。换一行录会直接改 recording,监听器是同一个函数不会重复挂。 */
function toggleRecord(id: ShortcutId): void {
  if (recording.value === id) {
    stopRecord()
    return
  }
  recordError.value = null
  recording.value = id
  window.addEventListener('keydown', onRecordKey, true)
}

/** 退出录制:清状态并摘掉捕获监听,否则弹窗关了按键还在被吞。 */
function stopRecord(): void {
  recording.value = null
  recordError.value = null
  window.removeEventListener('keydown', onRecordKey, true)
}

/**
 * 录键:捕获阶段截走按键,既拿到原始组合,也顺手挡住 App 的全局快捷键与浏览器默认行为
 * (录制时按 Ctrl+F 不会弹搜索)。Esc 只做取消——它保留给关闭弹窗,永远不可被绑定;
 * Backspace / Delete 解绑。
 */
function onRecordKey(event: KeyboardEvent): void {
  event.preventDefault()
  event.stopPropagation()
  const id = recording.value
  if (id === null) {
    stopRecord()
    return
  }
  if (event.key === 'Escape') {
    stopRecord()
    return
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    ui.setBinding(id, '')
    stopRecord()
    return
  }
  const binding = bindingOfEvent(event)
  if (binding === null) return // 输入法合成中 / 只按了修饰键:继续等下一个键
  const owner = ui.commandOf(binding)
  if (owner !== null && owner !== id) {
    recordError.value = `${displayOfBinding(binding)} 已被「${labelOf(owner)}」占用,先改掉那一条或换个组合`
    return
  }
  ui.setBinding(id, binding)
  stopRecord()
}

// 录制中切页 / 关弹窗都要摘监听:不然界面上看不见,按键却一直被吞。
// 顺带收回危险动作的预备态:切到别的页还亮着「再点一次执行」，回来时很容易误触。
watch(tab, () => {
  stopRecord()
  disarm()
})
onBeforeUnmount(() => {
  stopRecord()
  disarm()
})

/** 数据页与危险区用的三计数：排除「本机已删除」的墓碑笔记，只算真正还在库里的。 */
const stats = computed(() => {
  const all = vault.notes.filter((n) => !n.removedLocal)
  return {
    total: all.length,
    cached: all.filter((n) => n.cached).length,
    pending: vault.pendingUpload,
  }
})

/** 「正文存放」一行的文案，随绑定状态即时切换。 */
const backendLabel = computed(() => {
  if (vault.storageBackend === 'dir') return `用户目录:${vault.storageDirName}`
  if (vault.storageBackend === 'blocked') return `用户目录:${vault.storageDirName}(待授权)`
  return '浏览器内置存储(OPFS)'
})

/** 草稿是否偏离了 store：用序列化比较代替逐字段比对；脏的时候才允许保存，也用来阻止外部值覆盖。 */
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(settings.settings))
/** AI 草稿的同款判定，与同步页的 dirty 互不影响。 */
const aiDirty = computed(
  () => JSON.stringify(aiDraft.value) !== JSON.stringify(aiSettings.settings),
)
/** footer 的脏提示只跟当前页走：切页后草稿仍在，但提示不跨页指错地方。 */
const footDirty = computed(() => (tab.value === 'sync' ? dirty.value : tab.value === 'ai' ? aiDirty.value : false))

/** 读取浏览器存储配额与持久化授权；API 缺失时给出说明文本而不是抛错（部分浏览器不实现 estimate）。 */
async function refreshUsage(): Promise<void> {
  // 绑定目录后正文不占浏览器配额，持久化授权也只对内置 OPFS 有意义 —— 直接给说明文案，
  // 顺手把 persisted 置回 null，模板据此隐藏授权那一行。
  if (vault.storageBackend !== 'opfs') {
    usage.value = '正文在所选目录,不计入浏览器配额(索引等派生数据仍占浏览器存储)。'
    persisted.value = null
    return
  }
  if (typeof navigator.storage?.estimate !== 'function') {
    usage.value = '当前浏览器不提供存储用量信息。'
    return
  }
  const est = await navigator.storage.estimate()
  const used = est.usage ?? 0
  const quota = est.quota ?? 0
  usage.value = quota
    ? `已用 ${(used / 1048576).toFixed(1)} MB,浏览器配额约 ${(quota / 1073741824).toFixed(1)} GB`
    : `已用 ${(used / 1048576).toFixed(1)} MB`
  persisted.value = await opfs.persistedStorageGranted()
}

/** 把整份 draft 交给 store 落盘（owner/repo 的拆解与校验在 store 里做），成功后用规范化结果回填草稿。 */
async function save(): Promise<void> {
  error.value = null
  saved.value = false
  const wasConfigured = settings.configured
  try {
    await settings.save({ ...draft.value })
    // 重新取 store 的值而不是沿用 draft：store 可能改写过字段（如从完整地址拆出 owner/repo），
    // 回填后 dirty 才会归位成 false，否则按钮一直亮着。
    draft.value = { ...settings.settings }
    saved.value = true
    setTimeout(() => {
      saved.value = false
    }, 2000)
    // 第一次填完且已联网时顺手拉一次远端并预热正文缓存，省掉用户再点「立即同步」。
    // syncNow 失败要冒出来显示错误，startPreheat 是后台填充，故意 fire-and-forget。
    if (!wasConfigured && settings.configured && sync.online) {
      await sync.syncNow()
      void sync.startPreheat()
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

/**
 * 「测试连接」也是先保存再探活：Gitee API 需要凭据，不存下来就没法只测当前输入。
 * 保存本身也可能失败（配额、目录未授权），这里没有内联错误位 —— 走全局通知，
 * 否则按钮点了什么都不发生。
 */
async function test(): Promise<void> {
  try {
    await settings.save({ ...draft.value })
    draft.value = { ...settings.settings }
  } catch (err) {
    sync.notify('error', `保存设置失败: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  await sync.checkConnection()
}

/** 回填供应商预设；「自定义」只清地址与模型、保留已填的 Key，免得清个地址把凭据也清没了。 */
function applyPreset(p: AiPreset | null): void {
  aiDraft.value = p
    ? { ...aiDraft.value, baseUrl: p.baseUrl, model: p.model }
    : { ...aiDraft.value, baseUrl: '', model: '' }
  aiInfo.value = null
}

/** 把 AI 草稿交给 store 落盘（规范化在 store 里做），成功后用规范化结果回填，aiDirty 才归位。 */
async function saveAi(): Promise<void> {
  aiInfo.value = null
  try {
    await aiSettings.save({ ...aiDraft.value })
    aiDraft.value = { ...aiSettings.settings }
    aiSaved.value = true
    setTimeout(() => {
      aiSaved.value = false
    }, 2000)
  } catch (err) {
    aiOk.value = false
    aiInfo.value = `保存失败:${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * AI 的「测试连接」：直接拿当前草稿探活，**不先保存**——与同步页不同，
 * AI 请求只用本地凭据，没有「不存下来就测不了」的约束；用户改了地址想先试通再保存。
 *
 * 回执刻意把三类失败分开写：网络/CORS（换供应商或自建中转）、401（改 Key）、
 * 429/5xx（稍后重试）——分类逻辑在 core/ai/client.ts，这里只负责如实转达。
 */
async function testAi(): Promise<void> {
  const cfg = normalizeAiConfig(aiDraft.value)
  if (cfg.baseUrl === '' || cfg.apiKey === '' || cfg.model === '') {
    aiOk.value = false
    aiInfo.value = '连接失败:接口地址、API Key、模型名三项都要填。'
    return
  }
  aiBusy.value = true
  aiInfo.value = null
  try {
    const r = await testAiConnection(cfg)
    aiOk.value = true
    aiInfo.value = `连接成功(HTTP 200),响应回显模型「${r.model}」。点「保存」后即可在侧栏 AI 分区使用。`
  } catch (err) {
    aiOk.value = false
    aiInfo.value = `连接失败:${err instanceof Error ? err.message : String(err)}`
  } finally {
    aiBusy.value = false
  }
}

/**
 * 逐篇从 OPFS 读正文重算链接/标签，用于解析器升级或索引错乱后纠偏。
 * 跳过 removedLocal 与未缓存的笔记：后者没有正文可读，按需下载留到打开时再做。
 * 走 finally 复位标志，避免中途抛错让按钮永久 disabled。
 */
async function reindex(): Promise<void> {
  reindexing.value = true
  reindexed.value = null
  try {
    let count = 0
    for (const n of vault.notes) {
      if (n.removedLocal || !n.cached) continue
      const body = await opfs.readNote(n.path)
      if (body === null) continue
      // deferCards：循环里每篇刷一次内存 cards/resolver 是 O(N²)，收尾的 refreshDerived 统一收口。
      await vault.reindexContent(n.path, body, { deferCards: true })
      count++
    }
    await vault.refreshDerived()
    reindexed.value = count
  } catch (err) {
    // 没有这一 catch，抛错会穿过 finally 直达 void 调用点，按钮恢复了但用户不知道发生了什么。
    sync.notify('error', `重建索引失败: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    reindexing.value = false
  }
}

/**
 * 导出 zip 备份：打包交给 core/vault/backup.ts，本函数只管按钮态、回执与报错。
 * 成功回执带上篇数与体积 —— 「下载成功」不等于「内容对」，把包里有什么写出来才好核对。
 * 索引里标着已下载、盘上却读不到的正文会单独弹一条 warn，绝不静默少几篇。
 */
async function exportBackup(): Promise<void> {
  exporting.value = true
  exportMsg.value = null
  try {
    const archive = await buildBackup()
    downloadZip(archive.bytes, archive.filename)
    const kb = archive.bytes.length / 1024
    const size = kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(1)} MB`
    exportMsg.value = `已导出 ${archive.noteCount} 篇正文 / ${archive.rowCount} 行索引,${size} —— ${archive.filename}`
    if (archive.missing > 0) {
      sync.notify('warn', `有 ${archive.missing} 篇正文标着已下载却读不到,未包含在本次备份里。`)
    }
  } catch (err) {
    // 没有这一 catch,抛错会穿过 finally 直达 void 调用点,按钮恢复了但用户不知道发生了什么。
    sync.notify('error', `导出备份失败: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    exporting.value = false
  }
}

/**
 * 删掉正文再刷新，是刻意复用启动时的「清空—恢复」路径：`reconcile()` 会发现 OPFS 空了而索引里仍认识
 * 这些笔记，于是由 sync store 带着进度条把每一篇正文重新拉回来，不必在本组件另写一套批量下载逻辑。
 */
async function wipeAndReload(): Promise<void> {
  wipeBusy.value = true
  error.value = null
  try {
    await opfs.clearAllNotes()
    location.reload()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    wipeBusy.value = false
  }
}

/** 清空按钮的两段式入口：先上膛，再点一次才真正 wipeAndReload。 */
function onWipeClick(): void {
  if (!wipeArmed.value) {
    arm('wipe')
    return
  }
  disarm()
  void wipeAndReload()
}

/** 解除绑定的两段式入口，与 onWipeClick 同构（预备态见 arm 的注释）。 */
function onUnbindClick(): void {
  if (!unbindArmed.value) {
    arm('unbind')
    return
  }
  disarm()
  void unbindDirectory()
}

/**
 * 「选择目录」：选择 → 迁移现有文件 → 落库绑定 → 对账（全在 vault.bindDirectoryFlow 里）。
 * 用户在选择器里取消（AbortError）按「无操作」处理，不报错也不提示；其他错误展示给用户，
 * 且绑定未落库、后端仍停在原处，可直接重试。
 */
async function chooseDirectory(): Promise<void> {
  dirBusy.value = true
  dirMsg.value = null
  error.value = null
  try {
    const r = await vault.bindDirectoryFlow()
    const skipped = r.skipped > 0 ? `,跳过目录里已存在的 ${r.skipped} 个` : ''
    dirMsg.value = `已绑定到「${vault.storageDirName}」,复制了 ${r.copied} 个文件${skipped}。`
    await refreshUsage()
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  } finally {
    dirBusy.value = false
  }
}

/** 「解除绑定」：目录内容回写内置存储（无授权则跳过）→ 解除 → 对账，随后刷新本机统计。 */
async function unbindDirectory(): Promise<void> {
  dirBusy.value = true
  dirMsg.value = null
  error.value = null
  try {
    await vault.unbindDirectoryFlow()
    dirMsg.value = '已解除绑定,正文回到浏览器内置存储(OPFS)。'
    await refreshUsage()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    dirBusy.value = false
  }
}

/** store 侧的值变了（导入配置、别处保存）就同步进草稿，但 dirty 时不覆盖，免得吞掉用户正在输入的内容。 */
watch(
  () => settings.settings,
  (next) => {
    if (!dirty.value) draft.value = { ...next }
  },
  { deep: true },
)

/** 打开时重取草稿（父组件每次都是新挂载，但要防 store 在挂载前刚被改过），并拉存储用量与同步日志。 */
onMounted(() => {
  draft.value = { ...settings.settings }
  aiDraft.value = { ...aiSettings.settings }
  // AI 配置的读库可能还没结束（启动后立刻开设置页）；读完回填，但不覆盖用户此刻已敲的内容。
  void aiSettings.load().then(() => {
    if (!aiDirty.value) aiDraft.value = { ...aiSettings.settings }
  })
  void refreshUsage()
  void sync.refreshLog()
})
</script>

<template>
  <Modal title="设置" wide @close="emit('close')">
    <!-- 左栏导航 + 右栏内容，六个页签共用一个 tab 状态，切换不销毁已填的草稿。
         tablist / aria-selected + roving tabindex + 方向键漫游（onNavKey），键盘语义与原横排一致。 -->
    <div class="pane">
      <nav ref="navEl" class="snav" role="tablist" aria-label="设置分类" aria-orientation="vertical" @keydown="onNavKey">
        <button
          v-for="t in TABS"
          :id="`settab-${t}`"
          :key="t"
          class="snav__btn"
          role="tab"
          :class="{ 'snav__btn--on': tab === t }"
          :aria-selected="tab === t"
          aria-controls="setpane"
          :tabindex="tab === t ? 0 : -1"
          @click="tab = t"
        >
          <svg class="snav__ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              :d="TAB_ICONS[t]"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span class="snav__label">{{ TAB_LABELS[t] }}</span>
        </button>
      </nav>
      <div id="setpane" class="pane__main" role="tabpanel" :aria-labelledby="`settab-${tab}`">

        <!-- Gitee 同步：唯一会把凭据写进本机数据库的一页，所以先警告、后表单 -->
        <template v-if="tab === 'sync'">
          <div class="sect sect--first">
            <h4 class="sect__t">凭据</h4>
            <div class="callout callout--warn">
              <tip-icon kind="warn" />
              <strong>令牌明文存本机</strong>(IndexedDB 或 <code>.webvault/sync.json</code>),只发往
              <code>gitee.com</code>。公用设备别填;单独建仓库、令牌只勾 <code>projects</code>,泄露也影响有限。
            </div>

            <!-- 首次准备步骤按需展开:常驻形态只留一行入口,打开才是完整四步 -->
            <details class="disclose">
              <summary class="disclose__sum">第一次使用?展开 4 步准备</summary>
              <div class="steps">
                <ol>
                  <li>在 Gitee 新建一个<strong>私有</strong>仓库(例如 <code>my-vault</code>),里面至少提交一个文件,否则没有分支可推。</li>
                  <li>打开 <code>gitee.com/profile/personal_access_tokens</code>,生成新令牌,勾选 <code>projects</code>。</li>
                  <li>把令牌、用户名(空间地址)、仓库名、分支名填到下面,点「测试连接」。</li>
                  <li>连接成功后点「立即同步」把远端笔记拉到本机。</li>
                </ol>
              </div>
            </details>

            <label class="frow">
              <span class="frow__label">私人令牌 access token</span>
              <span class="frow__ctl">
                <span class="field__row">
                  <input
                    v-model="draft.token"
                    class="field"
                    :type="showToken ? 'text' : 'password'"
                    placeholder="粘贴 Gitee 私人令牌"
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <button class="btn btn--ghost" type="button" @click="showToken = !showToken">
                    {{ showToken ? '隐藏' : '显示' }}
                  </button>
                </span>
              </span>
            </label>

            <label class="frow" title="粘贴完整仓库地址会在保存时自动拆成三段">
              <span class="frow__label">空间地址 owner<span class="frow__desc">用户名或组织;也可直接粘贴仓库地址</span></span>
              <span class="frow__ctl">
                <input v-model="draft.owner" class="field" placeholder="例如 zhangsan" autocomplete="off" spellcheck="false" />
              </span>
            </label>

            <label class="frow">
              <span class="frow__label">仓库名 repo</span>
              <span class="frow__ctl">
                <input v-model="draft.repo" class="field" placeholder="例如 my-vault" autocomplete="off" spellcheck="false" />
              </span>
            </label>

            <label class="frow">
              <span class="frow__label">分支 branch</span>
              <span class="frow__ctl">
                <input v-model="draft.branch" class="field" placeholder="master" autocomplete="off" spellcheck="false" />
              </span>
            </label>
          </div>

          <div class="sect">
            <h4 class="sect__t">同步行为</h4>
            <label class="frow">
              <span class="frow__label">编辑后自动同步</span>
              <span class="frow__ctl"><input v-model="draft.autoSync" type="checkbox" /></span>
            </label>
            <label class="frow" title="「停止输入多久后尝试上传」。设长一些能减少提交次数,避免把仓库塞满碎片提交。">
              <span class="frow__label">推送延迟</span>
              <span class="frow__ctl">
                <!-- .number 必需：select 的值是字符串，落成数字后 debounce 才能直接参与毫秒运算 -->
                <select v-model.number="draft.pushDelayMs" class="field field--select">
                  <option v-for="d in DELAYS" :key="d.ms" :value="d.ms">{{ d.label }}</option>
                </select>
              </span>
            </label>
          </div>

          <p v-if="sync.connectionInfo" class="field__tip" :class="{ 'field__error': sync.connectionInfo.startsWith('连接失败') }">
            {{ sync.connectionInfo }}
          </p>
          <p v-if="error" class="field__error">{{ error }}</p>
          <p v-if="saved" class="field__ok">已保存。</p>
        </template>

        <!-- AI：第二份明文凭据的一页，与同步页同款先警告、后表单的结构 -->
        <template v-else-if="tab === 'ai'">
          <div class="sect sect--first">
            <h4 class="sect__t">预设</h4>
            <div class="frow frow--wide">
              <span class="frow__label">供应商预设<span class="frow__desc">只回填接口地址与模型名(可再改)。</span></span>
              <span class="frow__ctl">
                <button
                  v-for="p in AI_PRESETS"
                  :key="p.name"
                  class="btn btn--ghost"
                  type="button"
                  @click="applyPreset(p)"
                >
                  {{ p.name }}
                </button>
                <button class="btn btn--ghost" type="button" @click="applyPreset(null)">自定义</button>
              </span>
            </div>
          </div>

          <div class="sect">
            <h4 class="sect__t">连接</h4>
            <div class="callout callout--warn">
              <tip-icon kind="warn" />
              <strong>Key 明文存本机</strong>(IndexedDB 或 <code>.webvault/ai.json</code>),只发往你填的接口地址;
              笔记仅在你显式「引用笔记 / 存为笔记」时随请求发出。
              导出 zip 自动抹空该字段;共享整个文件夹前请把 <code>ai.json</code> 一并清掉。
            </div>

            <label class="frow">
              <span class="frow__label">接口地址 baseUrl<span class="frow__desc">OpenAI 兼容,自动补 /chat/completions</span></span>
              <span class="frow__ctl">
                <input
                  v-model="aiDraft.baseUrl"
                  class="field"
                  placeholder="https://api.deepseek.com/v1"
                  autocomplete="off"
                  spellcheck="false"
                />
              </span>
            </label>

            <label class="frow">
              <span class="frow__label">API Key</span>
              <span class="frow__ctl">
                <span class="field__row">
                  <input
                    v-model="aiDraft.apiKey"
                    class="field"
                    :type="showAiKey ? 'text' : 'password'"
                    placeholder="粘贴 API Key"
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <button class="btn btn--ghost" type="button" @click="showAiKey = !showAiKey">
                    {{ showAiKey ? '隐藏' : '显示' }}
                  </button>
                </span>
              </span>
            </label>

            <label class="frow">
              <span class="frow__label">模型 model</span>
              <span class="frow__ctl">
                <input
                  v-model="aiDraft.model"
                  class="field"
                  placeholder="例如 deepseek-chat"
                  autocomplete="off"
                  spellcheck="false"
                />
              </span>
            </label>

            <!-- 排查手册按需展开:报错时 client 的错误行本身就带 CORS 提示,这里是备用的完整版 -->
            <details class="disclose">
              <summary class="disclose__sum">报「网络失败 / CORS」?展开排查</summary>
              <div class="disclose__body">
                测试连接报「网络请求失败 / CORS」时,说明该供应商不允许浏览器跨域调用 ——
                换一家允许跨域的供应商(本页的四个预设都可直接测),或自建一个中转地址。
              </div>
            </details>

            <p v-if="aiInfo" class="field__tip" :class="aiOk ? 'field__ok' : 'field__error'">{{ aiInfo }}</p>
            <p v-if="aiSaved" class="field__ok">已保存。</p>
          </div>
        </template>

        <!-- 外观：点了就立即生效并直接写本机存储，没有草稿也没有保存按钮 -->
        <template v-else-if="tab === 'appearance'">
          <div class="sect sect--first">
            <h4 class="sect__t">主题</h4>
            <p class="sect__d tip--info">
              <tip-icon kind="info" />
              <span>点击立即生效;只存本机浏览器,不进同步、不影响笔记。</span>
            </p>
            <div class="themes">
              <button
                v-for="t in THEMES"
                :key="t.id"
                type="button"
                class="theme"
                :class="{ 'theme--on': appearance.theme === t.id }"
                @click="appearance.setTheme(t.id)"
              >
                <span
                  class="theme__mini"
                  :data-theme-preview="t.id"
                  :data-mode="t.mode"
                  :data-accent="appearance.accent"
                >
                  <span class="theme__side"></span>
                  <span class="theme__body"><i></i><i></i><i></i></span>
                </span>
                <span class="theme__name">{{ t.label }}</span>
                <span class="theme__hint">{{ t.hint }}</span>
              </button>
            </div>
          </div>

          <div class="sect">
            <h4 class="sect__t">强调色</h4>
            <p class="sect__d">用于链接、双链胶囊、选中态与图谱节点;浅色主题自动压深以保对比度。</p>
            <div class="accents">
              <button
                v-for="a in ACCENTS"
                :key="a.id"
                type="button"
                class="accent"
                :class="{ 'accent--on': appearance.accent === a.id }"
                :title="a.label"
                @click="appearance.setAccent(a.id)"
              >
                <span class="accent__chip" :data-accent-preview="a.id"></span>
                <span class="accent__name">{{ a.label }}</span>
              </button>
            </div>
          </div>
        </template>

        <!-- 数据与日志：存储位置与绑定管理 + 只读统计 + 三个维护动作（重建索引、看同步日志、清空本机正文重来） -->
        <template v-else-if="tab === 'data'">
          <div class="sect sect--first">
            <h4 class="sect__t">存储位置</h4>
            <div class="callout">
              <template v-if="vault.storageBackend === 'dir'">
                <tip-icon kind="info" />
                正文读写都在绑定目录 <strong>「{{ vault.storageDirName }}」</strong
                >里,资源管理器可见、可备份。
                <details class="disclose disclose--inline">
                  <summary class="disclose__sum">索引与设置存在哪?会离开本机吗?</summary>
                  <div class="disclose__body">
                    索引与设置也以 JSON 文件存在该目录的 <code>.webvault/</code> 下,浏览器 IndexedDB 只是缓存 ——
                    整个文件夹拷走即带走全部数据。这些数据都只在这台设备上,不会上传到本应用之外的任何服务器。
                  </div>
                </details>
              </template>
              <template v-else>
                <tip-icon kind="warn" />
                正文存在浏览器存储(OPFS),资源管理器看不到,<strong>清理站点数据会一起丢</strong>。
                <details class="disclose disclose--inline">
                  <summary class="disclose__sum">绑定一个本地目录后呢?</summary>
                  <div class="disclose__body">
                    指定一个本地目录后,笔记是磁盘上实打实的文件,索引与设置(<code>.webvault/</code> 下的 JSON)也一起落进去,
                    整个文件夹拷走即带走全部数据。所有数据都只在这台设备上,不会上传到本应用之外的任何服务器。
                  </div>
                </details>
              </template>
            </div>
            <div class="frow">
              <span class="frow__label">本地目录</span>
              <span class="frow__ctl">
                <button class="btn" type="button" :disabled="dirBusy || !dirPickerOk" @click="chooseDirectory">
                  {{ dirBusy ? '处理中…' : vault.storageBackend === 'dir' ? '换一个目录…' : '选择目录…' }}
                </button>
                <button
                  v-if="vault.storageBackend === 'dir'"
                  class="btn"
                  :class="{ 'btn--danger': unbindArmed }"
                  type="button"
                  :disabled="dirBusy"
                  @click="onUnbindClick"
                >
                  {{ unbindArmed ? '再点一次确认解除' : '解除绑定' }}
                </button>
                <button v-if="unbindArmed" class="btn btn--ghost" type="button" @click="disarm">取消</button>
              </span>
            </div>
            <p v-if="!dirPickerOk" class="field__tip">当前浏览器不支持目录选择器,请改用 Chrome / Edge。</p>
            <template v-else>
              <details class="disclose">
                <summary class="disclose__sum">绑定 / 解除时会发生什么?</summary>
                <div class="disclose__body">
                  绑定时会把现有笔记(含 <code>.webvault</code> 数据文件)复制进所选目录,推荐选一个空文件夹;目录里已有的同名文件不会被覆盖,
                  差异以目录内容为准。解除绑定前会先把目录内容回写回内置存储。
                </div>
              </details>
              <p class="field__tip tip--warn">
                <tip-icon kind="warn" />
                <span>token 明文写在 <code>.webvault/sync.json</code>,共享或备份文件夹前请先删。</span>
              </p>
            </template>
            <p v-if="dirMsg" class="field__ok">{{ dirMsg }}</p>
            <p v-if="error" class="field__error">{{ error }}</p>

            <dl class="info">
              <dt>笔记总数</dt>
              <dd>{{ stats.total }}</dd>
              <dt>正文已下载到本机</dt>
              <dd>{{ stats.cached }} 篇(其余为仅索引,打开时按需下载)</dd>
              <dt>待上传</dt>
              <dd>{{ stats.pending }} 篇</dd>
              <dt>正文存放</dt>
              <dd>{{ backendLabel }}</dd>
              <dt>索引与设置</dt>
              <dd>
                <code>.webvault/</code> 下的 11 个 JSON({{ vault.storageBackend === 'dir' ? '绑定目录内' : '内置存储内' }}),
                浏览器 IndexedDB 仅作缓存
              </dd>
              <dt>本机存储占用</dt>
              <dd>{{ usage }}</dd>
              <template v-if="vault.storageBackend === 'opfs'">
                <dt>持久化存储授权</dt>
                <dd>
                  <span :class="persisted ? 'field__ok' : 'field__error'">
                    {{ persisted === null ? '检测中…' : persisted ? '已授权(不易被浏览器自动清理)' : '未授权' }}
                  </span>
                </dd>
              </template>
            </dl>
          </div>

          <div class="sect">
            <h4 class="sect__t">维护</h4>
            <div class="frow">
              <span class="frow__label">导出备份 (zip)<span class="frow__desc">只读打包,凭据不进包</span></span>
              <span class="frow__ctl">
                <button class="btn" type="button" :disabled="exporting" @click="exportBackup">
                  {{ exporting ? '打包中…' : '打包下载' }}
                </button>
              </span>
            </div>
            <p v-if="exportMsg" class="field__tip">{{ exportMsg }}</p>
            <details class="disclose">
              <summary class="disclose__sum">导出 zip 里有什么?</summary>
              <div class="disclose__body">
                把本机的全部笔记正文连同索引快照打成一个 zip 下载,包内保持原目录结构,解压即可直接阅读。
                导出<strong>只读</strong>,不改动任何数据;<strong>Gitee token 等凭据不会写进包里</strong>。
                浏览器有清理内置存储的可能,这是独立于 Gitee 的第二份副本。
              </div>
            </details>

            <div class="frow">
              <span class="frow__label">重建链接与标签索引<span class="frow__desc">从正文重新解析反链与标签,<strong>不改笔记内容</strong></span></span>
              <span class="frow__ctl">
                <button class="btn" type="button" :disabled="reindexing" @click="reindex">
                  {{ reindexing ? '重建中…' : '重建索引' }}
                </button>
              </span>
            </div>
            <p v-if="reindexed !== null" class="field__tip">已重新解析 {{ reindexed }} 篇笔记。</p>
          </div>

          <div class="logs">
            <div class="logs__head">
              <span>同步日志(最近 120 条)</span>
              <div class="logs__actions">
                <button class="btn btn--ghost" type="button" @click="sync.refreshLog()">刷新</button>
                <button class="btn btn--ghost" type="button" :disabled="sync.log.length === 0" @click="sync.clearLog()">
                  清空
                </button>
              </div>
            </div>
            <ul v-if="sync.log.length > 0" class="logs__list">
              <li v-for="row in sync.log" :key="row.id">
                <span class="logs__level" :data-level="row.level">{{ row.level }}</span>
                <span class="logs__at">{{ new Date(row.at).toLocaleString('zh-CN', { hour12: false }) }}</span>
                <span class="logs__msg">{{ row.message }}</span>
              </li>
            </ul>
            <p v-else class="field__tip">还没有同步记录。</p>
          </div>

          <div class="danger">
            <p class="danger__title">清空本机正文并重新下载</p>
            <p class="field__tip tip--warn">
              <tip-icon kind="warn" />
              <span>
                删除本机全部正文并从 Gitee 完整重拉;<strong>未上传的修改会丢失</strong>,先确认「待上传」为 0。
              </span>
            </p>
            <!-- 三个禁用条件缺一不可：未配置就没处可拉；还有待上传就等于删掉唯一一份未同步的修改；进行中防重复点。
                 点击是两段式：第一次只上膛（文案变「再点一次」+ 危险配色 + 出现取消），第二次才执行。 -->
            <button
              class="btn"
              :class="{ 'btn--danger': wipeArmed }"
              type="button"
              title="用于修复本机文件损坏,或补回被浏览器清掉的缓存"
              :disabled="!settings.configured || stats.pending > 0 || wipeBusy"
              @click="onWipeClick"
            >
              {{ wipeBusy ? '处理中…' : wipeArmed ? '再点一次确认清空' : '清空并重新下载' }}
            </button>
            <button v-if="wipeArmed" class="btn btn--ghost" type="button" @click="disarm">取消</button>
            <p v-if="stats.pending > 0" class="field__tip">当前有 {{ stats.pending }} 篇待上传,请先同步。</p>
          </div>
        </template>

        <!-- 快捷键:上半截可改绑(录键),下半截是改不了的固定键与编辑器内建键 -->
        <template v-else-if="tab === 'shortcuts'">
          <div class="sect sect--first">
            <h4 class="sect__t">可修改</h4>
            <p class="sect__d tip--info">
              <tip-icon kind="info" />
              <span>
                点「修改」后按新键;<code>Backspace</code> 解绑,<code>Esc</code> 取消。改动仅存本机。
              </span>
            </p>
            <details class="disclose">
              <summary class="disclose__sum">哪些键 / 组合不生效?</summary>
              <div class="disclose__body">
                不带主键的裸键(如 <code>?</code>)在输入框与正文里不会触发;
                <code>Ctrl + N / T / W</code> 这类组合被浏览器占用,页面根本收不到。
              </div>
            </details>

            <ul class="binds">
              <li v-for="c in SHORTCUT_COMMANDS" :key="c.id" class="binds__row">
                <span class="binds__name">
                  {{ c.label }}
                  <em v-if="isChanged(c.id)" class="binds__def">默认 {{ displayOfBinding(c.default) }}</em>
                </span>
                <span class="binds__keys">
                  <span v-if="recording === c.id" class="binds__rec">按下新组合键…</span>
                  <kbd v-else-if="ui.bindings[c.id] !== ''" class="keys__cap">{{
                    displayOfBinding(ui.bindings[c.id])
                  }}</kbd>
                  <span v-else class="binds__none">未绑定</span>
                </span>
                <button class="btn btn--ghost" type="button" @click="toggleRecord(c.id)">
                  {{ recording === c.id ? '取消' : '修改' }}
                </button>
                <button
                  v-if="isChanged(c.id)"
                  class="btn btn--ghost"
                  type="button"
                  @click="ui.resetBinding(c.id)"
                >恢复默认</button>
              </li>
            </ul>
            <p v-if="recordError" class="field__error">{{ recordError }}</p>
          </div>

          <div class="sect">
            <h4 class="sect__t">改不了的按键</h4>
            <details class="disclose">
              <summary class="disclose__sum">为什么这些改不了?撞了会怎样?</summary>
              <div class="disclose__body">
                这些是应用交互与编辑器内核(Vditor)的内置行为,不参与改绑;标题、表格两组只在光标落进对应块时生效。
                若把上面的快捷键设成同样的组合,两者会同时触发。
              </div>
            </details>

            <!-- 每组一个区块:左列键帽右对齐成一栏,右列说明——从上往下扫,不用来回找键 -->
            <section v-for="g in FIXED_SHORTCUTS" :key="g.group" class="keys">
              <h5 class="keys__group">{{ g.group }}</h5>
              <ul class="keys__list">
                <li v-for="(row, i) in g.rows" :key="i" class="keys__row">
                  <span class="keys__caps">
                    <template v-for="(cap, j) in row.keys" :key="j">
                      <span v-if="j > 0" class="keys__plus">+</span>
                      <kbd class="keys__cap">{{ cap }}</kbd>
                    </template>
                  </span>
                  <span class="keys__desc">{{ row.desc }}</span>
                </li>
              </ul>
            </section>
          </div>
        </template>

        <!-- 关于:纯静态文案,兜底分支,列出不支持项以免用户误以为丢数据 -->
        <template v-else>
          <p class="about">
            WebVault 是一个纯静态的单页应用:笔记是你的普通 <code>.md</code>
            文件,存在本机浏览器里,通过你自己的 Gitee 仓库在设备之间同步。没有账号系统,没有服务器,没有人能看到你的笔记。
          </p>

          <div class="sect">
            <h4 class="sect__t">装到桌面 / 手机</h4>
            <ul class="plain">
              <li><strong>桌面 Chrome / Edge:</strong>地址栏右侧会出现安装图标,点一下即可作为独立窗口应用运行。</li>
              <li><strong>Android Chrome:</strong>菜单 →「安装应用」或「添加到主屏幕」。</li>
              <li>
                <strong>iOS Safari:</strong>分享按钮 →「添加到主屏幕」。<em>必须这样做</em>,否则 Safari
                的防跟踪策略会在约 7 天不用之后清空本机笔记缓存。装到主屏幕后仍可能被清,应用会在启动时检测并自动从 Gitee 恢复。
              </li>
            </ul>
          </div>

          <div class="sect">
            <h4 class="sect__t">已知限制</h4>
            <ul class="plain">
              <li>附件(图片等)只会被索引为链接,暂不支持在编辑器里预览或上传。</li>
              <li>即时渲染模式会在首次编辑时规范化部分 Markdown 语法(列表符号、空行等),这是编辑器内核的行为。</li>
              <li>与 Obsidian 桌面版可以共用同一个 git 仓库,但 iOS 版 Obsidian 没有 git 同步,无法直接互通。</li>
              <li>本地与远端同时改了同一篇笔记时:能自动合并的部分会合并,合不了的会保留本地版本,并把远端版本另存为
                <code>标题.conflict-时间戳.md</code>,两个文件都会上传。<strong>不会</strong>在正文里插入冲突标记。</li>
            </ul>
          </div>
        </template>
      </div>
    </div>

    <!-- 动作收进 footer:左侧脏提示、右侧按页渲染动作,「关闭」恒在最右 —— 与主流设置面板一致 -->
    <template #footer>
      <span v-if="footDirty" class="foot__dirty"><i aria-hidden="true"></i>有未保存的更改</span>
      <span class="spacer"></span>
      <template v-if="tab === 'sync'">
        <button class="btn" type="button" :disabled="!dirty" @click="save">保存</button>
        <button class="btn" type="button" @click="test">测试连接</button>
        <button
          class="btn btn--primary"
          type="button"
          :disabled="!settings.configured || sync.syncing"
          @click="sync.syncNow()"
        >
          {{ sync.syncing ? '同步中…' : '立即同步' }}
        </button>
      </template>
      <template v-else-if="tab === 'ai'">
        <button class="btn" type="button" :disabled="!aiDirty" @click="saveAi">保存</button>
        <button
          class="btn btn--primary"
          type="button"
          title="直接用当前输入探活,不会先保存;试通了再点保存"
          :disabled="aiBusy"
          @click="testAi"
        >
          {{ aiBusy ? '测试中…' : '测试连接' }}
        </button>
      </template>
      <button class="btn" type="button" @click="emit('close')">关闭</button>
    </template>
  </Modal>
</template>

<style scoped>
/* —— 左导航 + 右内容：导航 sticky 贴顶、不随正文滚；窄屏(640px)塌成横排 chip —— */
.pane {
  display: grid;
  grid-template-columns: 150px 1fr;
}

.snav {
  position: sticky;
  /* 负值贴齐 Modal body 的 16px 内边距，滚动时导航条不露底色 */
  top: -16px;
  align-self: start;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 10px 8px 0;
}

.snav__btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--text-muted);
  text-align: left;
}

.snav__btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.snav__btn--on {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 500;
}

/* 选中项必须自己盖过 hover：否则 .snav__btn:hover 用 --bg-hover 压掉 --on 的淡底，
   鼠标移上去像是高亮丢了（与 SideBar 同样的处理） */
.snav__btn--on:hover {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.snav__ico {
  flex: none;
}

.pane__main {
  min-width: 0; /* 防长串令牌 / 日志把 1fr 列撑破 */
  padding-left: 18px;
  border-left: 1px solid var(--border);
}

/* —— 分节：每页 2–4 个小节，标题给层级、说明挨着标题走 —— */
.sect {
  margin-top: 20px;
}

.sect--first {
  margin-top: 0;
}

.sect__t {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.sect__d {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
}

.sect__d code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

.sect__d strong {
  color: var(--text);
}

/* —— 行式表单：左标签、右控件，行间细分隔线；控件列定宽，整页控件右缘对齐成一条线 —— */
.frow {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) minmax(240px, 340px);
  gap: 16px;
  align-items: center;
  padding: 11px 0;
  border-bottom: 1px solid var(--border);
}

.frow:last-child {
  border-bottom: none;
}

/* 宽行：按钮组这类放不进 340px 列的控件；右缘仍对齐，放不下就换行 */
.frow--wide {
  grid-template-columns: minmax(150px, 1fr) auto;
}

.frow__label {
  font-size: 13px;
  color: var(--text);
}

/* 标签自带的补注：下沉到标签下方，不挤占控件列 */
.frow__desc {
  display: block;
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-muted);
}

.frow__desc strong {
  color: var(--text);
}

.frow__ctl {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 0;
}

/* 输入类撑满控件列；按钮保持内容宽、不被压扁 */
.frow__ctl .field,
.frow__ctl .field__row {
  flex: 1;
  min-width: 0;
}

.frow__ctl .btn {
  flex: none;
}

.frow__ctl input[type='checkbox'] {
  width: 16px;
  height: 16px;
}

/* —— 提示块：图标置顶、语义淡底的圆角卡片；扫读顺序是图标 → 加粗结论 → 正文 —— */
.callout {
  margin: 0 0 12px;
  padding: 11px 13px;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--border));
  background: color-mix(in srgb, var(--accent) 7%, var(--bg-elevated));
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text-muted);
}

.callout strong {
  color: var(--text);
}

.callout code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

.callout--warn {
  border-color: color-mix(in srgb, var(--warn) 34%, var(--border));
  background: color-mix(in srgb, var(--warn) 9%, var(--bg-elevated));
}

/* 图标独占一行置顶：callout 是块级扫读，不与正文抢行 */
.callout .tip__ico {
  display: block;
  margin: 0 0 6px;
}

/* —— 提示分级:⚠ 警告 / ⓘ 说明 —— 图标只是扫读锚点,语义仍由旁边的文字承载 —— */
.tip__ico {
  flex: none;
}

/* 颜色按图标 kind 走,与它所在的容器无关(TipIcon 的 class 决定) */
.tip__ico--warn {
  color: var(--warn);
}

.tip__ico--info {
  color: var(--text-muted);
}

.tip--warn,
.tip--info {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.tip--warn .tip__ico,
.tip--info .tip__ico {
  margin-top: 2px;
}

.steps {
  margin: 6px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg);
}

.steps ol {
  margin: 0;
  padding-left: 20px;
  font-size: 12.5px;
  line-height: 1.85;
  color: var(--text-muted);
}

.steps code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

/* —— 折叠件:原生 <details>,零 JS、键盘可达、开合语义由浏览器暴露给读屏 —— */
.disclose {
  margin: -4px 0 14px;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text-muted);
}

.disclose__sum {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 0;
  list-style: none;
  cursor: pointer;
  font-weight: 500;
  color: var(--text);
}

/* 三种写法各盖一个引擎:marker 清零(Chromium)、display:flex 摘掉 list-item(部分 Firefox)、
   webkit 伪元素(Safari 旧版);缺一个就有一处露出浏览器默认的 ▸ */
.disclose__sum::marker {
  content: '';
}

.disclose__sum::-webkit-details-marker {
  display: none;
}

/* 关合箭头:只画右、下两条边框,rotate(-45deg) 指右、rotate(45deg) 指下 */
.disclose__sum::before {
  content: '';
  flex: none;
  width: 4px;
  height: 4px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
  transition: transform 0.15s ease;
}

.disclose[open] .disclose__sum::before {
  transform: rotate(45deg);
}

/* 正文左缩进 + 细线,表达「这是从属于摘要的展开内容」 */
.disclose__body {
  padding: 5px 0 0 14px;
  border-left: 2px solid var(--border);
}

.disclose code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

.disclose strong {
  color: var(--text);
}

/* callout 内嵌的折叠件:去掉外边距,摘要颜色跟随 callout 的行内节奏 */
.disclose--inline {
  margin: 7px 0 0;
}

.field__row {
  display: flex;
  gap: 6px;
}

/* —— 表单控件与行布局 —— */
.field {
  width: 100%;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  outline: none;
  font-size: 13px;
  color: var(--text);
}

.field:focus {
  border-color: var(--accent);
}

.field--select {
  width: auto;
}

.field__tip {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
}

.field__tip code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

.field__tip strong {
  color: var(--text);
}

.field__error {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--danger);
}

.field__ok {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--ok);
}

.btn {
  padding: 6px 14px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  font-size: 13px;
  color: var(--text);
}

.btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.btn--primary {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-text);
}

.btn--danger {
  background: var(--danger-soft);
  border-color: var(--danger);
  color: var(--danger);
}

/* .btn--danger 只有 (0,1,0)，压不住 .btn:hover:not(:disabled) 的 (0,3,0)：
   危险按钮一悬停就退回中性底，「再点一次」的警告色恰好在最该强调的时刻消失。
   这里用同特异度补一条覆盖，让预备态在 hover 下仍是危险配色。 */
.btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 24%, var(--bg));
  color: var(--danger);
}

/* 危险区两个按钮是兄弟而不是 .row 子项，得自己留缝，否则「取消」贴着上膛按钮 */
.danger .btn + .btn {
  margin-left: 8px;
}

.btn--ghost {
  flex: none;
  width: auto;
  padding: 6px 10px;
  font-size: 12.5px;
  color: var(--text-muted);
}

/* —— 键值统计表（数据页统计）：列宽与 .frow 一致，值落在控件列里，整页右缘对齐 —— */
.info {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) minmax(240px, 340px);
  gap: 0 16px;
  margin: 4px 0 0;
  font-size: 13px;
}

.info dt,
.info dd {
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}

.info dt {
  align-self: center;
  color: var(--text-muted);
  font-size: 12.5px;
}

.info dd {
  margin: 0;
}

.info dt:last-of-type,
.info dd:last-of-type {
  border-bottom: none;
}

/* —— 同步日志：head 即小节标题（与 .sect__t 同字号），间距靠 margin-top 对齐分节节奏 —— */
.logs {
  margin-top: 20px;
}

.logs__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.logs__actions {
  display: flex;
  gap: 6px;
}

/* 自己滚动而不是撑长弹窗：同步日志最多攒满一屏，超长 message 靠 word-break 换行 */
.logs__list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  max-height: 240px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.logs__list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 9px;
  font-size: 11.5px;
  border-bottom: 1px solid var(--border);
}

.logs__list li:last-child {
  border-bottom: none;
}

.logs__level {
  flex: none;
  width: 40px;
  font-weight: 600;
  text-transform: uppercase;
}

.logs__level[data-level='error'] {
  color: var(--danger);
}

.logs__level[data-level='warn'] {
  color: var(--warn);
}

.logs__level[data-level='info'] {
  color: var(--accent);
}

.logs__at {
  flex: none;
  color: var(--text-muted);
}

.logs__msg {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

/* —— 危险区：清空本机正文；独立卡片沉底，间距与 .sect 节奏一致 —— */
.danger {
  margin-top: 20px;
  padding: 13px;
  border-radius: 9px;
  border: 1px solid var(--danger-line);
  background: var(--danger-soft);
}

.danger__title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--danger);
}

.about {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.85;
  color: var(--text-muted);
}

.about code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

/* —— 外观页：主题缩略卡与强调色色块 —— */
.themes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
  gap: 10px;
}

.theme {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  text-align: left;
}

.theme:hover {
  border-color: var(--border-strong);
}

.theme--on {
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* 缩略图整块带着 data-theme-preview,里面每个颜色都取自被预览的那套主题。 */
.theme__mini {
  display: flex;
  gap: 4px;
  height: 62px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
}

.theme__side {
  flex: none;
  width: 26px;
  border-radius: 4px;
  border-right: 1px solid var(--border);
  background: var(--bg-elevated);
}

.theme__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 3px;
}

.theme__body i {
  height: 4px;
  border-radius: 2px;
  background: var(--text-muted);
  opacity: 0.55;
}

.theme__body i:first-child {
  width: 62%;
  background: var(--accent);
  opacity: 1;
}

.theme__body i:nth-child(2) {
  width: 88%;
}

.theme__body i:last-child {
  width: 45%;
}

.theme__name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.theme__hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-muted);
}

.accents {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.accent {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg);
}

.accent:hover {
  border-color: var(--border-strong);
}

.accent--on {
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* 色块取 --accent-raw，缩略块上的 data-accent-preview 会在 styles/themes.css 里就地重定义该变量，
   于是每个选项都显示自己的颜色，而不是全部跟着当前选中的强调色走 */
.accent__chip {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--accent-raw);
  box-shadow: inset 0 0 0 1px var(--shadow-color);
}

/* 两圈阴影叠出「外环 + 间隙」：内圈用页面底色隔开，避免选中环和卡片边框糊在一起 */
.accent--on .accent__chip {
  box-shadow:
    0 0 0 2px var(--bg),
    0 0 0 4px var(--accent-raw);
}

.accent__name {
  font-size: 11px;
  color: var(--text-muted);
}

.plain {
  margin: 0;
  padding-left: 20px;
  font-size: 12.5px;
  line-height: 1.9;
  color: var(--text-muted);
}

.plain code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

.plain strong,
.plain em {
  color: var(--text);
}

/* —— 快捷键页:可改绑的命令行(名称 | 键帽 | 修改/恢复默认) —— */
.binds {
  margin: 0 0 4px;
  padding: 0;
  list-style: none;
}

.binds__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  font-size: 12.5px;
  /* 与 .frow 同款细分隔线：整页只有一种行分隔语汇 */
  border-bottom: 1px solid var(--border);
}

.binds__row:last-child {
  border-bottom: none;
}

.binds__name {
  flex: 1;
  min-width: 0;
  color: var(--text);
}

/* 偏离出厂值时的小注记:告诉用户这一条已经改过了 */
.binds__def {
  margin-left: 6px;
  font-size: 11px;
  font-style: normal;
  color: var(--text-muted);
}

.binds__keys {
  flex: none;
  min-width: 112px;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 4px;
}

/* 录制中的高亮提示:占键帽那个位,行宽不跳 */
.binds__rec {
  padding: 1px 8px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--accent-text);
  background: var(--accent-soft);
}

.binds__none {
  font-size: 12px;
  color: var(--text-muted);
}

/* —— 固定速查表:左列键帽右对齐成一栏,右列说明,两列结构便于从上往下扫 —— */
.keys {
  margin: 0 0 4px;
}

.keys__group {
  margin: 14px 0 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.keys__list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 窄屏下允许整行换行:键帽折到上一行,说明跟在下面,不撑破弹窗 */
.keys__row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 12px;
  padding: 3px 0;
  font-size: 12.5px;
  line-height: 1.7;
}

.keys__caps {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 3px;
  min-width: 170px;
}

/* 键帽:下边框加厚到 2px 模拟物理键的侧面;--bg 让它从弹窗底色里浮出来 */
.keys__cap {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 11.5px;
  white-space: nowrap;
}

.keys__plus {
  align-self: center;
  padding: 0 1px;
  color: var(--text-muted);
  font-size: 11.5px;
}

.keys__desc {
  flex: 1 1 200px;
  min-width: 0;
  color: var(--text-muted);
}

/* footer 左侧的脏状态：琥珀小圆点 + 短文案，比按钮 disabled 更早告诉用户「有东西没存」 */
.foot__dirty {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--warn);
}

.foot__dirty i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.spacer {
  flex: 1;
}

/* 窄屏：导航塌成横排 chip（可横向滚动），表单行堆叠为上下结构 */
@media (max-width: 640px) {
  .pane {
    grid-template-columns: 1fr;
  }

  .snav {
    position: static;
    flex-direction: row;
    overflow-x: auto;
    padding: 0 0 8px;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  .snav__btn {
    flex: none;
    width: auto;
  }

  .pane__main {
    padding-left: 0;
    border-left: none;
  }

  .frow,
  .frow--wide,
  .info {
    grid-template-columns: 1fr;
    gap: 6px;
  }

  .frow__ctl {
    justify-content: flex-start;
  }

  /* 堆叠后标签与值成对阅读：值自己带底线，标签不再重复画线 */
  .info dt {
    padding-bottom: 2px;
    border-bottom: none;
  }

  .info dd {
    padding-top: 0;
  }
}
</style>
