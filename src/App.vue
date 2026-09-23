<script setup lang="ts">
/**
 * 根组件：应用骨架与全局协调。
 *
 * 职责：启动时按序初始化各 Pinia store（vault → 索引 → UI 设置 → 同步）；管理左右侧栏在
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
import { useSyncStore } from './stores/sync.ts'
import { useUiStore } from './stores/ui.ts'
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

/** 设置对话框打开时落位的页签：'?' 直达「关于与快捷键」，常规入口始终回同步页。 */
const settingsInitial = ref<'sync' | 'appearance' | 'data' | 'about'>('sync')

/** 显示指定浮层；传 null 即关闭当前浮层。settingsTab 只在打开设置时生效，决定落位页签。 */
function show(
  next: Overlay,
  settingsTab: 'sync' | 'appearance' | 'data' | 'about' = 'sync',
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
 * 全局快捷键：
 * - Esc 与各浮层/对话框的关闭不再经手这里：Modal 在 document 层 stopPropagation，
 *   浮层组件各自处理自己的 Esc，走到本函数时已经没有需要收口的面板。
 * - Ctrl/Cmd+Shift+组合一律放行：曾经的 +Shift+O 收集箱开关已随卡片盒移除，
 *   保留这道 early-return 是为了不抢浏览器/输入法对 +Shift 系组合的默认绑定。
 * - +K 链接选择器；+F 搜索；+, 设置；无修饰的 ? 直达快捷键页。
 * 带 Alt 的组合不接管，避免撞上浏览器/输入法的默认行为。
 */
function onKeydown(event: KeyboardEvent): void {
  // '?' 直达「关于与快捷键」页：输入框/正文（内容可编辑区）里打问号一律放行，
  // 输入法合成中也不拦——中文输入法选词时的按键不该弹出设置。
  if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
    const t = event.target as HTMLElement | null
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    if (!typing) {
      event.preventDefault()
      show('settings', 'about')
    }
    return
  }
  if (!(event.ctrlKey || event.metaKey)) return
  const key = event.key.toLowerCase()
  if (event.shiftKey) return
  if (event.altKey) return
  if (key === 'k') {
    event.preventDefault()
    show('picker')
  } else if (key === 'f') {
    event.preventDefault()
    show('search')
  } else if (key === ',' || event.code === 'Comma') {
    event.preventDefault()
    show('settings')
  }
}

/** 立即把编辑器里待写的内容落盘（发后不理，适用于卸载/隐藏等无法 await 的时机）。 */
function flush(): void {
  void editorRef.value?.flushSave()
}

function onVisibility(): void {
  // 移动端浏览器切后台会挂起页面；挂起前先把待写的编辑持久化。
  if (document.visibilityState === 'hidden') flush()
}

onMounted(async () => {
  if (window.innerWidth < 1200) rightOpen.value = false
  syncDrawerState()
  narrow?.addEventListener('change', syncDrawerState)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', flush)
  document.addEventListener('visibilitychange', onVisibility)

  // 启动顺序有意为之：vault 初始化失败时置 fatal 并短路整个界面；
  // 索引在后台预热（不 await），用户先看到界面，随后才做启动定位与同步。
  await vault.init()
  if (vault.fatal) return
  await ui.load()
  await sync.init()
  startupDone.value = true
})

// 卸载前注销全部监听：媒体查询、快捷键、关闭前落盘、页面隐藏落盘。
onBeforeUnmount(() => {
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

/* 窄屏（<960px）：左右栏改为绝对定位的浮层抽屉，用遮罩承接点击关闭 */
@media (max-width: 959px) {
  .app__side,
  .app__right {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 50;
    width: min(var(--sidebar-w), 86vw);
    box-shadow: 0 0 30px var(--shadow-color);
    transition: transform 0.18s ease;
  }

  .app__side {
    left: 0;
    transform: translateX(-101%);
  }

  .app__right {
    right: 0;
    width: min(var(--right-w), 86vw);
    transform: translateX(101%);
  }

  .app__side--open,
  .app__right--open {
    transform: none;
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
