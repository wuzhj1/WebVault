<script setup lang="ts">
/**
 * 根组件：应用骨架与全局协调。
 *
 * 职责：启动时按序初始化各 Pinia store（vault → 回灌未落盘编辑 → 启动定位 → UI 设置 → 同步）；管理左右侧栏在
 * 宽屏（折叠面板）与窄屏（互斥抽屉）下的显隐；用单一 overlay 状态保证同一时刻只挂载一个
 * 全屏浮层（搜索 / 图谱 / 设置 / 链接选择）；注册全局快捷键，并在页面隐藏或关闭前强制
 * 编辑器落盘，避免防抖窗口内的输入丢失。所有"打开笔记"的请求也统一经由这里分发。
 */
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import NoteEditor from './components/NoteEditor.vue'
import Notices from './components/Notices.vue'
import RightPanel from './components/RightPanel.vue'
import SideBar from './components/SideBar.vue'
import TopBar from './components/TopBar.vue'
import { getSetting } from './core/db.ts'
import { SETTING_KEYS } from './core/vault/config-layout.ts'
import { dropPendingSave, readPendingSave, snapshotPendingSave } from './core/editor/pending-save.ts'
import { onFlushError } from './core/vault/datafiles.ts'
import { bindingOfEvent, hasMod, isTypingTarget } from './core/hotkeys.ts'
import { registerAppSW } from './core/pwa.ts'
import { titleOf } from './core/vault/paths.ts'
import { useSyncStore } from './stores/sync.ts'
import { useUiStore, type ShortcutId } from './stores/ui.ts'
import { useVaultStore } from './stores/vault.ts'

/** 互斥的全屏浮层类型；null 表示当前没有浮层。 */
type Overlay = 'search' | 'graph' | 'settings' | 'picker' | null

/**
 * 四个全屏浮层全部异步加载：它们只在被打开的那一刻才需要，拆出去首屏要解析的 JS 明显变小
 * （编辑器的 vditor 也已改为挂载时动态引入）。PWA 会把这些 chunk 一并预缓存，离线能力不受影响。
 */
const GraphView = defineAsyncComponent(() => import('./components/GraphView.vue'))
const LinkPicker = defineAsyncComponent(() => import('./components/LinkPicker.vue'))
const SearchPanel = defineAsyncComponent(() => import('./components/SearchPanel.vue'))
const SettingsDialog = defineAsyncComponent(() => import('./components/SettingsDialog.vue'))

const vault = useVaultStore()
const sync = useSyncStore()
const ui = useUiStore()

/** NoteEditor 实例：插入 [[链接]] 与强制落盘（flushSave）都经由它转发。 */
const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null)
/** 当前挂载的浮层，同一时刻至多一个。 */
const overlay = ref<Overlay>(null)
/** 打开搜索面板时带上的初始查询（侧栏点标签就是走这条路）。 */
const searchQuery = ref('')
/** 左右侧栏显隐：宽屏是折叠面板，窄屏（<960px）是互斥的抽屉。 */
const sidebarOpen = ref(true)
const rightOpen = ref(true)
/** 启动流程是否完成，透传给编辑器控制空态占位页何时可见。 */
const startupDone = ref(false)
/**
 * 新版 Service Worker 已接管、但页面还没换版本。只有在「正文尚未落盘、不能直接刷新」时才会置位，
 * 改由顶栏下方的提示条等用户点头；能安全刷新时是直接刷掉的，不会走到这里。
 */
const updateReady = ref(false)

/** 窄屏媒体查询；为 null（非浏览器环境兜底）时抽屉相关逻辑整体退化。 */
const narrow = typeof window !== 'undefined' ? window.matchMedia('(max-width: 959px)') : null
/** 窄屏下是否有抽屉打开，决定遮罩是否出现、点击遮罩能否关闭。 */
const drawerOpen = ref(false)

/**
 * 把"哪一侧打开"折算成 drawerOpen：仅窄屏且至少一侧打开时才显示遮罩。
 * 三个状态必须同步演进，否则会出现遮罩与抽屉不一致的死角。
 */
function syncDrawerState(): void {
  drawerOpen.value = !!narrow?.matches && (sidebarOpen.value || rightOpen.value)
}

/**
 * 打开一篇笔记：先关掉浮层，再交给 vault 加载；窄屏下同时收起两侧抽屉，
 * 避免抽屉遮住刚打开的正文。
 */
async function openNote(path: string): Promise<void> {
  overlay.value = null
  await vault.openNote(path)
  if (narrow?.matches) {
    sidebarOpen.value = false
    rightOpen.value = false
  }
  syncDrawerState()
}

/** 切换左侧栏；窄屏下左右抽屉互斥，打开左边就关掉右边。 */
function toggleSidebar(): void {
  sidebarOpen.value = !sidebarOpen.value
  if (sidebarOpen.value && narrow?.matches) rightOpen.value = false
  syncDrawerState()
}

/** 切换右侧栏；与 toggleSidebar 对称，窄屏下同样保持互斥。 */
function toggleRight(): void {
  rightOpen.value = !rightOpen.value
  if (rightOpen.value && narrow?.matches) sidebarOpen.value = false
  syncDrawerState()
}

/** 关闭两侧抽屉（点击遮罩时调用）。 */
function closeDrawers(): void {
  sidebarOpen.value = false
  rightOpen.value = false
  syncDrawerState()
}

/** 设置对话框打开时落位的页签：'?' 直达「快捷键」页，常规入口始终回同步页。 */
const settingsInitial = ref<'sync' | 'appearance' | 'data' | 'shortcuts' | 'about'>('sync')

/** 显示指定浮层；传 null 即关闭当前浮层。settingsTab 只在打开设置时生效，决定落位页签。 */
function show(
  next: Overlay,
  settingsTab: 'sync' | 'appearance' | 'data' | 'shortcuts' | 'about' = 'sync',
): void {
  if (next === 'search') searchQuery.value = ''
  if (next === 'settings') settingsInitial.value = settingsTab
  overlay.value = next
}

/**
 * 带查询打开搜索面板（侧栏标签点击）。查询只在打开这一刻读走一次，
 * 面板内部自己维护输入状态，因此这里不保留对它的引用。
 */
function showSearch(query: string): void {
  searchQuery.value = query
  overlay.value = 'search'
}

/** 把选中的目标以 [[链接]] 形式插入编辑器当前光标处。 */
function insertLink(target: string): void {
  editorRef.value?.insertLink(target)
}

/**
 * 可改快捷键的命令 id → 动作分发。这里不认识任何具体按键：具体组合存在 ui.bindings
 * 里（设置 → 快捷键 页可改），新增命令时与 ui.SHORTCUT_COMMANDS 各加一行即可。
 */
const ACTIONS: Record<ShortcutId, () => void> = {
  picker: () => show('picker'),
  search: () => show('search'),
  settings: () => show('settings'),
  cheatsheet: () => show('settings', 'shortcuts'),
  graph: () => show('graph'),
}

/**
 * 全局快捷键：一次 keydown 折算成规范串（core/hotkeys.ts），到 ui.bindings 反查命令再分发。
 * - 不带主键的绑定（出厂的 `?`）在输入框/正文里一律放行；输入法合成中整段不拦——
 *   中文输入法选词时的按键不该弹出设置。
 * - Esc 不在此列：Modal 在 document 层 stopPropagation，各浮层自己关自己，走到这里时
 *   已经没有需要收口的面板；录制新键时设置页在捕获阶段截走事件，同样走不到这里。
 * - 具体哪些组合可用、哪个组合被谁占用，都在 ui 与设置页里裁决，这里只管执行。
 */
function onKeydown(event: KeyboardEvent): void {
  const binding = bindingOfEvent(event)
  if (binding === null) return
  const id = ui.commandOf(binding)
  if (id === null) return
  if (!hasMod(binding) && isTypingTarget(event.target)) return
  event.preventDefault()
  ACTIONS[id]()
}

/** 立即把编辑器里待写的内容落盘（发后不理，适用于卸载/隐藏等无法 await 的时机）。 */
function flush(): void {
  void editorRef.value?.flushSave()
}

function onVisibility(): void {
  // 移动端浏览器切后台会挂起页面；挂起前先把待写的编辑持久化。
  if (document.visibilityState === 'hidden') flush()
}

/**
 * 回灌上次没来得及写进 OPFS 的编辑：`beforeunload` 不等异步 Promise，防抖窗口内直接关标签页
 * 只能靠 localStorage 快照兜底（见 core/editor/pending-save.ts）。
 * 必须赶在启动定位之前 —— 定位一改 activePath，编辑器就按库里的正文渲染了。
 * 不用 schedulePush：settings 还没 load，schedulePush 会直接 no-op；
 * 随后 sync.init() 的首轮静默 syncNow 会把这条 dirty 一起带走。
 */
async function recoverPendingSave(): Promise<void> {
  const pending = readPendingSave()
  if (!pending) return
  const meta = vault.byPath.get(pending.path)
  // 笔记已删或只剩墓碑时没有合法写入目标，这条快照永远回灌不了 —— 无条件丢弃，
  // 免得每轮启动都重试同一条死路径。
  if (!meta || meta.removedLocal) {
    dropPendingSave()
    return
  }
  try {
    await vault.saveBody(pending.path, pending.value)
    // 写成功才丢快照：原先是「先 drop 再写」，一次写失败（配额、目录未授权）就同时
    // 丢掉了快照和正文，用户重启也找不回来。失败路径反而要把快照原样写回去。
    dropPendingSave()
    sync.notify('info', `已恢复上次未保存的编辑「${titleOf(pending.path)}」`)
  } catch (err) {
    snapshotPendingSave(pending.path, pending.value)
    sync.notify('error', `恢复未保存的编辑失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 启动定位：回到上次打开的那篇（`last-open-path` 由 openNote 防抖写入）。
 * 路径已失效（笔记被删 / 只剩墓碑）就停在空态页，不报错也不清键。
 * 这一项分流在 `.webvault/workspace.json`（高频变动的工作区状态，与静态配置分开）。
 */
async function locateLastNote(): Promise<void> {
  const path = await getSetting<string | null>(SETTING_KEYS.lastOpenPath, null)
  if (!path) return
  const meta = vault.byPath.get(path)
  if (!meta || meta.removedLocal) return
  await openNote(path)
}

/**
 * `.webvault` 落盘失败原先只写 console.error ——「文件是真相源」这句话会在用户完全不知情时失效，
 * 直到下次启动才暴露出索引和文件对不上。core 层不 import 任何 store（会成环），只能回调注入。
 * 连续失败只报一次，见 datafiles 的 flushFailed。
 */
const offFlushError = onFlushError((file, err) => {
  sync.notify(
    'error',
    `保存索引/设置到 .webvault/${file} 失败,数据仍留在浏览器里: ${err instanceof Error ? err.message : String(err)}`,
  )
})

/**
 * 新版 SW 已接管（skipWaiting + clientsClaim 已生效），此刻页面跑的还是旧 JS，必须刷新一次才换得到新版本。
 * - 没有待写内容：直接刷。这次刷新只是把已经装好的新版本换上来，用户感知不到，
 *   也正是「装成本地应用却一直停在旧版本」这个老问题的正解。
 * - 有未落盘的修改（dirty / saving / error）：绝不打断输入，只挂出提示条等用户自己点。
 *   防抖窗口内的那几个字一旦被 reload 冲掉是找不回来的，宁可让用户晚几秒拿到新版本。
 */
function onSWNeedReload(): void {
  const pending =
    vault.saveState === 'dirty' || vault.saveState === 'saving' || vault.saveState === 'error'
  if (pending) {
    updateReady.value = true
    return
  }
  window.location.reload()
}

/**
 * 用户点了提示条上的「立即刷新」：先 await 强制落盘再刷，别把最后几个字交给 beforeunload 去赌
 * （快照确实兜得住，但能真写进 OPFS 就不该退而求其次）。
 * flushSave 失败时会自己把正文放回 pendingValue 并报错，这里照样刷新 ——
 * localStorage 快照 + 下次启动回灌（recoverPendingSave）是它的兜底。
 */
async function reloadForUpdate(): Promise<void> {
  await editorRef.value?.flushSave()
  window.location.reload()
}

onMounted(async () => {
  if (window.innerWidth < 1200) rightOpen.value = false
  syncDrawerState()
  narrow?.addEventListener('change', syncDrawerState)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', flush)
  document.addEventListener('visibilitychange', onVisibility)

  // 必须赶在下面的 await 之前：SW 注册拖到 vault.init() 之后，更新检测会跟着一起被阻塞。
  registerAppSW(onSWNeedReload)

  // 启动顺序有意为之：vault 初始化失败时置 fatal 并短路整个界面；
  // 索引在后台预热（不 await），用户先看到界面，随后才做回灌、启动定位与同步。
  // 回灌与定位都排在 ui.load() 之前：openNote 会 addRecent，load 那边已按「合并」处理。
  await vault.init()
  if (vault.fatal) return
  await recoverPendingSave()
  await locateLastNote()
  await ui.load()
  await sync.init()
  startupDone.value = true
})

// 卸载前注销全部监听：媒体查询、快捷键、关闭前落盘、页面隐藏落盘、.webvault 落盘失败回调。
onBeforeUnmount(() => {
  offFlushError()
  narrow?.removeEventListener('change', syncDrawerState)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', flush)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <div class="app">
    <!-- 顶栏：切换左右侧栏、发起搜索 / 图谱 / 设置 -->
    <TopBar
      @toggle-sidebar="toggleSidebar"
      @toggle-right="toggleRight"
      @search="show('search')"
      @graph="show('graph')"
      @settings="show('settings')"
    />

    <!-- 新版 SW 已接管但还没换版本：只有正文没落盘时才会挂出来（能安全刷就直接刷了）。
         放在 v-if/v-else 之外，启动屏、fatal 屏上同样可见 —— 提示条在这几种状态下都不碍事。 -->
    <div v-if="updateReady" class="banner banner--update">
      <span class="banner__text">新版本已就绪,刷新后生效。</span>
      <button class="banner__btn banner__btn--primary" type="button" @click="reloadForUpdate">
        立即刷新
      </button>
      <button class="banner__btn" type="button" @click="updateReady = false">稍后</button>
    </div>

    <!-- 启动失败：OPFS 不可用（无痕窗口 / 禁用站点数据）时的整屏兜底 -->
    <div v-if="vault.fatal" class="screen">
      <div class="screen__box screen__box--error">
        <h2>无法启动本地存储</h2>
        <p>{{ vault.fatal }}</p>
        <p class="muted">
          如果这是隐私/无痕窗口或站点数据被禁用,OPFS 将不可用。请用普通窗口打开,并在浏览器设置中允许本站保存数据。
        </p>
      </div>
    </div>

    <!-- 绑定的笔记目录需要重新授权（浏览器重启后权限过期）；授权或改回内置存储前，一切文件 IO 都停着 -->
    <div v-else-if="vault.storageBackend === 'blocked'" class="screen">
      <div class="screen__box">
        <h2>需要授权访问笔记目录</h2>
        <p>
          笔记正文存放在「{{ vault.storageDirName }}」。浏览器重启后目录授权会过期,点下面的按钮重新允许访问。
        </p>
        <div class="screen__actions">
          <button class="screen__btn screen__btn--primary" type="button" @click="vault.grantDirAccess">
            重新授权
          </button>
          <button class="screen__btn" type="button" @click="vault.unbindDirectoryFlow">
            改用浏览器内置存储
          </button>
        </div>
        <p>
          「改用内置存储」会回到迁移前的本机副本;绑定期间新增或修改的笔记,只有重新授权后才能带回来。
        </p>
      </div>
    </div>

    <!-- 初始化中：读取本机笔记库 -->
    <div v-else-if="!vault.ready" class="screen">
      <div class="screen__box">
        <span class="spinner spinner--big"></span>
        <p>正在读取本机笔记库…</p>
      </div>
    </div>

    <template v-else>
      <!-- 本机缓存被浏览器清空后的恢复提示条 -->
      <div v-if="vault.storageWasWiped" class="banner">
        浏览器清空了本机笔记缓存。
        <template v-if="sync.available">正在从 Gitee 恢复,请保持联网。</template>
        <template v-else>
          请先在设置里连接 Gitee 仓库再恢复,否则内容无法找回。
        </template>
      </div>

      <!-- 主体三栏：左文件树 / 中编辑器 / 右信息面板。窄屏下左右栏变成浮层抽屉，由 scrim 挡住内容并承接点击关闭 -->
      <div class="app__body">
        <div
          class="scrim"
          :class="{ 'scrim--on': drawerOpen }"
          @click="closeDrawers"
        ></div>

        <aside class="app__side" :class="{ 'app__side--open': sidebarOpen }">
          <SideBar @open="openNote" @search="showSearch" />
        </aside>

        <!-- 主区是 flex column：编辑器占满整个主区（曾经贴底停靠的收集箱面板已随卡片盒移除） -->
        <main class="app__main">
          <NoteEditor
            ref="editorRef"
            @open-link="openNote"
            @pick-link="show('picker')"
            :startup-done="startupDone"
          />
        </main>

        <aside class="app__right" :class="{ 'app__right--open': rightOpen }">
          <RightPanel @open="openNote" />
        </aside>
      </div>
    </template>

    <!-- 常驻浮层：全局通知，独立于下方互斥的 overlay -->
    <Notices />

    <!-- 互斥的全屏浮层：同一时刻只挂载一个，open 后统一由 @close 归零 -->
    <SearchPanel
      v-if="overlay === 'search'"
      :initial="searchQuery"
      @open="openNote"
      @close="overlay = null"
    />
    <LinkPicker
      v-else-if="overlay === 'picker'"
      @open="openNote"
      @insert="insertLink"
      @close="overlay = null"
    />
    <GraphView v-else-if="overlay === 'graph'" @open="openNote" @close="overlay = null" />
    <SettingsDialog
      v-else-if="overlay === 'settings'"
      :initial-tab="settingsInitial"
      @close="overlay = null"
    />
  </div>
</template>

<style scoped>
/* —— 骨架布局：顶栏 + body（左 / 中 / 右三栏） —— */
.app {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
}

.app__body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
}

.app__side {
  flex: none;
  width: var(--sidebar-w);
  min-width: 0;
}

.app__main {
  flex: 1;
  /* flex column：NoteEditor(flex:1) 吃掉全部剩余空间 */
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.app__right {
  flex: none;
  width: var(--right-w);
  min-width: 0;
}

.scrim {
  display: none;
}

/* —— 启动加载 / 存储失败的整屏状态 —— */
.screen {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow: auto;
}

.screen__box {
  max-width: 520px;
  text-align: center;
}

.screen__box h2 {
  margin: 0 0 10px;
  font-size: 18px;
}

.screen__box p {
  margin: 8px 0;
  font-size: 13.5px;
  line-height: 1.8;
  color: var(--text-muted);
}

.screen__box--error {
  padding: 20px 22px;
  border: 1px solid var(--danger-line);
  border-radius: 12px;
  background: var(--danger-soft);
  text-align: left;
}

.screen__box--error h2 {
  color: var(--danger);
}

/* —— 目录授权屏的操作按钮（组件里没有通用 .btn，这里自带一套） —— */
.screen__actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  margin: 16px 0 8px;
}

.screen__btn {
  padding: 7px 16px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg);
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
}

.screen__btn:hover {
  background: var(--bg-hover);
}

.screen__btn--primary {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-text);
}

/* —— 恢复提示条与加载动画 —— */
.banner {
  flex: none;
  padding: 8px 14px;
  background: var(--warn-soft);
  border-bottom: 1px solid var(--warn-line);
  color: var(--warn);
  font-size: 12.5px;
  line-height: 1.6;
}

/* 新版提示条：沿用 .banner 的位置与尺寸，但换成强调色 —— 这是更新而不是故障，不该用警示色。 */
.banner--update {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  background: var(--accent-soft);
  border-bottom-color: var(--accent);
  color: var(--accent-text);
}

.banner__text {
  margin-right: auto;
}

/* 按钮配色照抄 .screen__btn：强调色填充主按钮 + 中性次按钮，明暗两套主题下都靠变量兜底。 */
.banner__btn {
  padding: 3px 12px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text);
  cursor: pointer;
}

.banner__btn:hover {
  background: var(--bg-hover);
}

.banner__btn--primary {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-text);
}

.spinner {
  display: inline-block;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinner--big {
  width: 22px;
  height: 22px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 窄屏（<960px）：左右栏改为绝对定位的浮层抽屉，用遮罩承接点击关闭。
   收起态原本只靠 transform 把抽屉挪到屏外，元素本身还在原位——Tab 照样能命中里面
   的按钮（会盲点到看不见的界面上），读屏也照读。visibility 把它彻底摘出焦点顺序与
   无障碍树，只在本媒体查询内生效：宽屏走下面的 display:none。
   visibility 是离散插值，且只要有一端是 visible 中间值就取 visible，所以开时立刻
   显形、滑入动画照常，关时先滑完 0.18s 才隐身，不会把滑出过程截断。 */
@media (max-width: 959px) {
  .app__side,
  .app__right {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 50;
    width: min(var(--sidebar-w), 86vw);
    box-shadow: 0 0 30px var(--shadow-color);
    transition: transform 0.18s ease, visibility 0.18s ease;
  }

  .app__side {
    left: 0;
    transform: translateX(-101%);
    visibility: hidden;
  }

  .app__right {
    right: 0;
    width: min(var(--right-w), 86vw);
    transform: translateX(101%);
    visibility: hidden;
  }

  .app__side--open,
  .app__right--open {
    transform: none;
    visibility: visible;
  }

  .scrim {
    display: block;
    position: absolute;
    inset: 0;
    z-index: 40;
    background: var(--scrim);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.18s ease;
  }

  .scrim--on {
    opacity: 1;
    pointer-events: auto;
  }
}

/* 宽屏（≥960px）：未展开的侧栏直接不占位、不渲染可见 */
@media (min-width: 960px) {
  .app__side:not(.app__side--open),
  .app__right:not(.app__right--open) {
    display: none;
  }
}
</style>
