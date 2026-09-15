<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import GraphView from './components/GraphView.vue'
import LinkPicker from './components/LinkPicker.vue'
import NoteEditor from './components/NoteEditor.vue'
import Notices from './components/Notices.vue'
import RightPanel from './components/RightPanel.vue'
import SearchPanel from './components/SearchPanel.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import SideBar from './components/SideBar.vue'
import TopBar from './components/TopBar.vue'
import { useSyncStore } from './stores/sync.ts'
import { useVaultStore } from './stores/vault.ts'

type Overlay = 'search' | 'graph' | 'settings' | 'picker' | null

const vault = useVaultStore()
const sync = useSyncStore()

const editorRef = ref<InstanceType<typeof NoteEditor> | null>(null)
const overlay = ref<Overlay>(null)
const sidebarOpen = ref(true)
const rightOpen = ref(true)

const narrow = typeof window !== 'undefined' ? window.matchMedia('(max-width: 959px)') : null
const drawerOpen = ref(false)

function syncDrawerState(): void {
  drawerOpen.value = !!narrow?.matches && (sidebarOpen.value || rightOpen.value)
}

async function openNote(path: string): Promise<void> {
  overlay.value = null
  await vault.openNote(path)
  if (narrow?.matches) {
    sidebarOpen.value = false
    rightOpen.value = false
  }
  syncDrawerState()
}

function toggleSidebar(): void {
  sidebarOpen.value = !sidebarOpen.value
  if (sidebarOpen.value && narrow?.matches) rightOpen.value = false
  syncDrawerState()
}

function toggleRight(): void {
  rightOpen.value = !rightOpen.value
  if (rightOpen.value && narrow?.matches) sidebarOpen.value = false
  syncDrawerState()
}

function closeDrawers(): void {
  sidebarOpen.value = false
  rightOpen.value = false
  syncDrawerState()
}

function show(next: Overlay): void {
  overlay.value = next
}

function insertLink(target: string): void {
  editorRef.value?.insertLink(target)
}

function onKeydown(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
  const key = event.key.toLowerCase()
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

function flush(): void {
  void editorRef.value?.flushSave()
}

function onVisibility(): void {
  // Mobile browsers suspend the page on app switch; persist the pending edit first.
  if (document.visibilityState === 'hidden') flush()
}

onMounted(async () => {
  if (window.innerWidth < 1200) rightOpen.value = false
  syncDrawerState()
  narrow?.addEventListener('change', syncDrawerState)
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('beforeunload', flush)
  document.addEventListener('visibilitychange', onVisibility)

  await vault.init()
  if (vault.fatal) return
  await sync.init()
})

onBeforeUnmount(() => {
  narrow?.removeEventListener('change', syncDrawerState)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('beforeunload', flush)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <div class="app">
    <TopBar
      @toggle-sidebar="toggleSidebar"
      @toggle-right="toggleRight"
      @search="show('search')"
      @graph="show('graph')"
      @settings="show('settings')"
    />

    <div v-if="vault.fatal" class="screen">
      <div class="screen__box screen__box--error">
        <h2>无法启动本地存储</h2>
        <p>{{ vault.fatal }}</p>
        <p class="muted">
          如果这是隐私/无痕窗口或站点数据被禁用,OPFS 将不可用。请用普通窗口打开,并在浏览器设置中允许本站保存数据。
        </p>
      </div>
    </div>

    <div v-else-if="!vault.ready" class="screen">
      <div class="screen__box">
        <span class="spinner spinner--big"></span>
        <p>正在读取本机笔记库…</p>
      </div>
    </div>

    <template v-else>
      <div v-if="vault.storageWasWiped" class="banner">
        浏览器清空了本机笔记缓存。
        <template v-if="sync.available">正在从 Gitee 恢复,请保持联网。</template>
        <template v-else>
          请先在设置里连接 Gitee 仓库再恢复,否则内容无法找回。
        </template>
      </div>

      <div class="app__body">
        <div
          class="scrim"
          :class="{ 'scrim--on': drawerOpen }"
          @click="closeDrawers"
        ></div>

        <aside class="app__side" :class="{ 'app__side--open': sidebarOpen }">
          <SideBar @open="openNote" />
        </aside>

        <main class="app__main">
          <NoteEditor
            ref="editorRef"
            @open-link="openNote"
            @pick-link="show('picker')"
          />
        </main>

        <aside class="app__right" :class="{ 'app__right--open': rightOpen }">
          <RightPanel @open="openNote" />
        </aside>
      </div>
    </template>

    <Notices />

    <SearchPanel v-if="overlay === 'search'" @open="openNote" @close="overlay = null" />
    <LinkPicker
      v-else-if="overlay === 'picker'"
      @open="openNote"
      @insert="insertLink"
      @close="overlay = null"
    />
    <GraphView v-else-if="overlay === 'graph'" @open="openNote" @close="overlay = null" />
    <SettingsDialog v-else-if="overlay === 'settings'" @close="overlay = null" />
  </div>
</template>

<style scoped>
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
  border: 1px solid rgba(243, 139, 168, 0.4);
  border-radius: 12px;
  background: rgba(243, 139, 168, 0.06);
  text-align: left;
}

.screen__box--error h2 {
  color: var(--danger);
}

.banner {
  flex: none;
  padding: 8px 14px;
  background: rgba(249, 226, 175, 0.12);
  border-bottom: 1px solid rgba(249, 226, 175, 0.35);
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

@media (max-width: 959px) {
  .app__side,
  .app__right {
    position: absolute;
    top: 0;
    bottom: 0;
    z-index: 50;
    width: min(var(--sidebar-w), 86vw);
    box-shadow: 0 0 30px rgba(0, 0, 0, 0.45);
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
    background: rgba(10, 10, 18, 0.5);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.18s ease;
  }

  .scrim--on {
    opacity: 1;
    pointer-events: auto;
  }
}

@media (min-width: 960px) {
  .app__side:not(.app__side--open),
  .app__right:not(.app__right--open) {
    display: none;
  }
}
</style>
