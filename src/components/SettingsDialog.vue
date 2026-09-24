<script setup lang="ts">
/**
 * 设置对话框:Gitee 同步、外观、数据与日志、快捷键、关于五个标签页。
 *
 * emits `close` —— 焦点陷阱、ESC 关闭、遮罩点击都由外层 Modal.vue 负责，本组件只提供内容区。
 * 依赖 settings(同步配置)、sync(连接/同步/日志)、vault(笔记索引)、appearance(主题与强调色)、
 * ui(快捷键绑定:可改的全局键存在 ui.bindings,本组件负责录键、冲突提示与恢复默认)。
 *
 * 关键约束：表单改的是 draft 副本，点「保存」才落盘，dirty 用来决定按钮是否可点；
 * 外观页是唯一例外——选项点击即写入本机存储、立刻生效，没有草稿也没有保存按钮。
 * Gitee token 只写进本机 IndexedDB，不会随笔记上传，也不会同步到其他设备（故 sync tab 顶部有醒目警告）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { bindingOfEvent, displayOfBinding } from '@/core/hotkeys.ts'
// OPFS 读写在本组件里承担三件维护动作：探测持久化授权、重建索引时逐篇读正文、清空本机正文
import * as opfs from '@/core/vault/opfs.ts'
import { ACCENTS, THEMES } from '@/core/theme/themes.ts'
import { useAppearanceStore } from '@/stores/appearance.ts'
import { useSettingsStore, type SyncSettings } from '@/stores/settings.ts'
import { useSyncStore } from '@/stores/sync.ts'
import { SHORTCUT_COMMANDS, useUiStore, type ShortcutId } from '@/stores/ui.ts'
import { useVaultStore } from '@/stores/vault.ts'
import Modal from './Modal.vue'

/** 唯一对外事件：由 Modal 的关闭按钮/遮罩/ESC 冒泡上来后转给父组件卸载本对话框。 */
const emit = defineEmits<{ (e: 'close'): void }>()

/** 打开时落位的页签；App 的 ? 快捷键直达「快捷键」页，不传则默认同步页。 */
const props = defineProps<{ initialTab?: Tab }>()

const settings = useSettingsStore()
const sync = useSyncStore()
const vault = useVaultStore()
const appearance = useAppearanceStore()
const ui = useUiStore()

/** 标签页 id，顺序即导航栏顺序；`Tab` 由数组字面量推导出联合类型，避免和模板里的 v-if 拼错。 */
const TABS = ['sync', 'appearance', 'data', 'shortcuts', 'about'] as const
type Tab = (typeof TABS)[number]

/** 标签页显示名，只在导航按钮上用，正文各段自带小标题。 */
const TAB_LABELS: Record<Tab, string> = {
  sync: 'Gitee 同步',
  appearance: '外观',
  data: '数据与日志',
  shortcuts: '快捷键',
  about: '关于',
}

/** 当前标签页，切换只影响渲染哪一段，不重置各段自己的草稿状态。初值来自 ? 快捷键的落位。 */
const tab = ref<Tab>(props.initialTab ?? 'sync')
/** 同步设置的编辑副本：只有点「保存」才写回 store，避免边打字边落盘。 */
const draft = ref<SyncSettings>({ ...settings.settings })
/** token 输入框是否在 text / password 之间切成明文，仅为当场核对粘贴对不对。 */
const showToken = ref(false)
/** 「已保存」提示的闪现开关，由 save() 里的定时器收回。 */
const saved = ref(false)
/** 保存或清空正文时抛出的错误文案；下次动作开始时会清掉，防止旧错误一直挂着。 */
const error = ref<string | null>(null)
/** 存储用量的一行人类可读文本，由 refreshUsage() 填充。 */
const usage = ref<string>('')
/** 持久化存储授权：null 表示还没测出来（navigator.storage.persisted 是异步的）。 */
const persisted = ref<boolean | null>(null)
/** 重建链接/标签索引进行中；按钮文案与 disabled 都靠它。 */
const reindexing = ref(false)
/** 重建索引完成后写入处理篇数；用 null 区分「还没跑过」和「跑了但 0 篇」。 */
const reindexed = ref<number | null>(null)
/** 清空本机正文的进行中标志：按钮文案与 disabled 都靠它。 */
const wipeBusy = ref(false)

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
watch(tab, stopRecord)
onBeforeUnmount(stopRecord)

/** 数据页与危险区用的三计数：排除「本机已删除」的墓碑笔记，只算真正还在库里的。 */
const stats = computed(() => {
  const all = vault.notes.filter((n) => !n.removedLocal)
  return {
    total: all.length,
    cached: all.filter((n) => n.cached).length,
    pending: vault.pendingUpload,
  }
})

/** 草稿是否偏离了 store：用序列化比较代替逐字段比对；脏的时候才允许保存，也用来阻止外部值覆盖。 */
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(settings.settings))

/** 读取浏览器存储配额与持久化授权；API 缺失时给出说明文本而不是抛错（部分浏览器不实现 estimate）。 */
async function refreshUsage(): Promise<void> {
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

/** 「测试连接」也是先保存再探活：Gitee API 需要凭据，不存下来就没法只测当前输入。 */
async function test(): Promise<void> {
  await settings.save({ ...draft.value })
  draft.value = { ...settings.settings }
  await sync.checkConnection()
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
      await vault.reindexContent(n.path, body)
      count++
    }
    await vault.refreshDerived()
    reindexed.value = count
  } finally {
    reindexing.value = false
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
  void refreshUsage()
  void sync.refreshLog()
})
</script>

<template>
  <Modal title="设置" wide @close="emit('close')">
    <!-- 五个标签页共用一个 tab 状态，切换不销毁已填的草稿 -->
    <nav class="tabs">
      <button
        v-for="t in TABS"
        :key="t"
        class="tabs__btn"
        :class="{ 'tabs__btn--on': tab === t }"
        @click="tab = t"
      >
        {{ TAB_LABELS[t] }}
      </button>
    </nav>

    <!-- Gitee 同步：唯一会把凭据写进本机数据库的一页，所以顶部先给警告 -->
    <template v-if="tab === 'sync'">
      <div class="callout callout--warn">
        <strong>先看清楚:</strong> 私人令牌会明文保存在这台设备的浏览器数据库(IndexedDB)里,只会被发往
        <code>gitee.com</code>。公用电脑或共享设备请不要填。建议在 Gitee
        单独建一个仓库专门放笔记,并只给令牌勾选 <code>projects</code> 权限,这样即使泄露也影响有限。
      </div>

      <div class="steps">
        <p class="steps__title">第一次使用的准备步骤</p>
        <ol>
          <li>在 Gitee 新建一个<strong>私有</strong>仓库(例如 <code>my-vault</code>),里面至少提交一个文件,否则没有分支可推。</li>
          <li>打开 <code>gitee.com/profile/personal_access_tokens</code>,生成新令牌,勾选 <code>projects</code>。</li>
          <li>把令牌、用户名(空间地址)、仓库名、分支名填到下面,点「测试连接」。</li>
          <li>连接成功后点「立即同步」把远端笔记拉到本机。</li>
        </ol>
      </div>

      <div class="grid">
        <label class="field__wrap">
          <span class="field__label">私人令牌 access token</span>
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
        </label>

        <label class="field__wrap">
          <span class="field__label">空间地址 owner(用户名或组织,也可直接粘贴仓库地址)</span>
          <input v-model="draft.owner" class="field" placeholder="例如 zhangsan" autocomplete="off" spellcheck="false" />
        </label>

        <label class="field__wrap">
          <span class="field__label">仓库名 repo</span>
          <input v-model="draft.repo" class="field" placeholder="例如 my-vault" autocomplete="off" spellcheck="false" />
        </label>

        <label class="field__wrap">
          <span class="field__label">分支 branch</span>
          <input v-model="draft.branch" class="field" placeholder="master" autocomplete="off" spellcheck="false" />
        </label>
      </div>
      <p class="field__tip">
        owner / repo 里直接粘贴 <code>gitee.com/&lt;owner&gt;/&lt;repo&gt;</code> 的完整地址也可以,保存时会自动拆成三段。
      </p>

      <div class="row">
        <label class="check">
          <input v-model="draft.autoSync" type="checkbox" />
          <span>编辑后自动同步</span>
        </label>
        <label class="check">
          <span class="check__label">推送延迟</span>
          <!-- .number 必需：select 的值是字符串，落成数字后 debounce 才能直接参与毫秒运算 -->
          <select v-model.number="draft.pushDelayMs" class="field field--select">
            <option v-for="d in DELAYS" :key="d.ms" :value="d.ms">{{ d.label }}</option>
          </select>
        </label>
      </div>
      <p class="field__tip">
        推送延迟是「停止输入多久后尝试上传」。设长一些能减少提交次数,避免把仓库塞满碎片提交。
      </p>

      <p v-if="sync.connectionInfo" class="field__tip" :class="{ 'field__error': sync.connectionInfo.startsWith('连接失败') }">
        {{ sync.connectionInfo }}
      </p>
      <p v-if="error" class="field__error">{{ error }}</p>
      <p v-if="saved" class="field__ok">已保存。</p>

      <div class="row row--end">
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
      </div>
      <p class="field__tip">同步中会显示进度;失败时具体原因会写在「数据与日志」标签页。</p>
    </template>

    <!-- 外观：点了就立即生效并直接写本机存储，没有草稿也没有保存按钮 -->
    <template v-else-if="tab === 'appearance'">
      <p class="field__tip appearance__tip">
        点了立即生效,不用保存。选择只写在这台设备的浏览器里,不会同步到 Gitee,也不会影响笔记内容。
      </p>

      <h4 class="sub sub--first">主题</h4>
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

      <h4 class="sub">强调色</h4>
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
      <p class="field__tip">
        强调色用于链接、双链胶囊、选中态和关系图谱的节点。浅色主题会自动把强调色压深,保证小字号文本的对比度。
      </p>
    </template>

    <!-- 数据与日志：只读统计 + 三个维护动作（重建索引、看同步日志、清空本机正文重来） -->
    <template v-else-if="tab === 'data'">
      <dl class="info">
        <dt>笔记总数</dt>
        <dd>{{ stats.total }}</dd>
        <dt>正文已下载到本机</dt>
        <dd>{{ stats.cached }} 篇(其余为仅索引,打开时按需下载)</dd>
        <dt>待上传</dt>
        <dd>{{ stats.pending }} 篇</dd>
        <dt>本机存储占用</dt>
        <dd>{{ usage }}</dd>
        <dt>持久化存储授权</dt>
        <dd>
          <span :class="persisted ? 'field__ok' : 'field__error'">
            {{ persisted === null ? '检测中…' : persisted ? '已授权(不易被浏览器自动清理)' : '未授权' }}
          </span>
        </dd>
      </dl>

      <div class="callout">
        <strong>数据存在哪里?</strong> 正文以明文 <code>.md</code> 保存在浏览器的 OPFS
        (源私有文件系统),链接索引、标签、设置、同步日志保存在 IndexedDB。两者都只在这台设备上,不会上传到本应用之外的任何服务器。
      </div>

      <div class="row">
        <button class="btn" type="button" :disabled="reindexing" @click="reindex">
          {{ reindexing ? '重建中…' : '重建链接与标签索引' }}
        </button>
        <span v-if="reindexed !== null" class="field__tip">已重新解析 {{ reindexed }} 篇笔记。</span>
      </div>
      <p class="field__tip">
        当反链、待创建列表或标签明显不对时,可以用这个按钮从正文重新解析一遍,不会改动任何笔记内容。
      </p>

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
        <p class="field__tip">
          用于修复本机文件损坏,或把 Safari 清空的缓存补回来。会先删除本机所有笔记正文,再从 Gitee
          仓库完整拉取。<strong>未上传的本地修改会丢失</strong>,请先确认「待上传」为 0。
        </p>
        <!-- 三个禁用条件缺一不可：未配置就没处可拉；还有待上传就等于删掉唯一一份未同步的修改；进行中防重复点 -->
        <button
          class="btn btn--danger"
          type="button"
          :disabled="!settings.configured || stats.pending > 0 || wipeBusy"
          @click="wipeAndReload"
        >
          {{ wipeBusy ? '处理中…' : '清空并重新下载' }}
        </button>
        <p v-if="stats.pending > 0" class="field__tip">当前有 {{ stats.pending }} 篇待上传,请先同步。</p>
      </div>
    </template>

    <!-- 快捷键:上半截可改绑(录键),下半截是改不了的固定键与编辑器内建键 -->
    <template v-else-if="tab === 'shortcuts'">
      <p class="field__tip">
        点「修改」后直接按下新的组合键;<code>Backspace</code> 解绑,<code>Esc</code> 取消录制。
        改动只存这台设备,不进同步。不带主键的裸键(如 <code>?</code>)在输入框与正文里不会触发;
        <code>Ctrl + N / T / W</code> 这类组合被浏览器占用,页面根本收不到。
      </p>

      <h4 class="sub sub--first">可修改</h4>
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

      <h4 class="sub">改不了的按键</h4>
      <p class="field__tip">
        这些是应用交互与编辑器内核(Vditor)的内置行为,不参与改绑;标题、表格两组只在光标落进对应块时生效。
        若把上面的快捷键设成同样的组合,两者会同时触发。
      </p>

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
    </template>

    <!-- 关于:纯静态文案,兜底分支,列出不支持项以免用户误以为丢数据 -->
    <template v-else>
      <p class="about">
        WebVault 是一个纯静态的单页应用:笔记是你的普通 <code>.md</code>
        文件,存在本机浏览器里,通过你自己的 Gitee 仓库在设备之间同步。没有账号系统,没有服务器,没有人能看到你的笔记。
      </p>

      <h4 class="sub">装到桌面 / 手机</h4>
      <ul class="plain">
        <li><strong>桌面 Chrome / Edge:</strong>地址栏右侧会出现安装图标,点一下即可作为独立窗口应用运行。</li>
        <li><strong>Android Chrome:</strong>菜单 →「安装应用」或「添加到主屏幕」。</li>
        <li>
          <strong>iOS Safari:</strong>分享按钮 →「添加到主屏幕」。<em>必须这样做</em>,否则 Safari
          的防跟踪策略会在约 7 天不用之后清空本机笔记缓存。装到主屏幕后仍可能被清,应用会在启动时检测并自动从 Gitee 恢复。
        </li>
      </ul>

      <h4 class="sub">已知限制</h4>
      <ul class="plain">
        <li>附件(图片等)只会被索引为链接,暂不支持在编辑器里预览或上传。</li>
        <li>即时渲染模式会在首次编辑时规范化部分 Markdown 语法(列表符号、空行等),这是编辑器内核的行为。</li>
        <li>与 Obsidian 桌面版可以共用同一个 git 仓库,但 iOS 版 Obsidian 没有 git 同步,无法直接互通。</li>
        <li>本地与远端同时改了同一篇笔记时:能自动合并的部分会合并,合不了的会保留本地版本,并把远端版本另存为
          <code>标题.conflict-时间戳.md</code>,两个文件都会上传。<strong>不会</strong>在正文里插入冲突标记。</li>
      </ul>
    </template>

    <template #footer>
      <span class="spacer"></span>
      <button class="btn" type="button" @click="emit('close')">关闭</button>
    </template>
  </Modal>
</template>

<style scoped>
/* 负上 margin：抵掉 Modal 内容区的内边距，让导航条贴着弹窗顶部形成一条分隔线 */
.tabs {
  display: flex;
  gap: 4px;
  margin: -4px 0 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}

.tabs__btn {
  padding: 5px 11px;
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--text-muted);
}

.tabs__btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.tabs__btn--on {
  background: var(--accent-soft);
  color: var(--accent-text);
}

/* —— 提示块与首次使用步骤 —— */
.callout {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-radius: 8px;
  border-left: 3px solid var(--accent);
  background: var(--bg);
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
  border-left-color: var(--warn);
}

.steps {
  margin: 0 0 16px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg);
}

.steps__title {
  margin: 0 0 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
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

/* min-width:0 必需：网格子项默认最小宽度是内容宽度，粘贴一长串令牌会把对话框撑破 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}

.field__wrap {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.field__label {
  font-size: 12px;
  color: var(--text-muted);
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

.row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.row--end {
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}

.check__label {
  font-size: 12.5px;
  color: var(--text-muted);
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

.btn--ghost {
  flex: none;
  width: auto;
  padding: 6px 10px;
  font-size: 12.5px;
  color: var(--text-muted);
}

/* —— 键值统计表（数据页统计） —— */
.info {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 0 0 14px;
  font-size: 13px;
}

.info dt {
  color: var(--text-muted);
  font-size: 12.5px;
}

.info dd {
  margin: 0;
}

/* —— 同步日志 —— */
.logs {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}

.logs__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
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

/* —— 危险区：清空本机正文 —— */
.danger {
  margin-top: 18px;
  padding: 12px;
  border-radius: 8px;
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

.sub {
  margin: 16px 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.appearance__tip {
  margin-top: 0;
}

.sub--first {
  margin-top: 4px;
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
  padding: 5px 0;
  font-size: 12.5px;
  border-bottom: 1px dashed var(--border);
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

.spacer {
  flex: 1;
}
</style>
