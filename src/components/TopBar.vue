<script setup lang="ts">
/**
 * 顶栏：应用标题、全局入口（搜索 / 图谱 / 设置）与同步状态指示。
 *
 * 本组件不自己改布局，面板的显隐全部通过 emits 上报给父级（App.vue）统一处理。
 *
 * emits：
 * - 'toggle-sidebar' / 'toggle-right'：切换左右侧栏。
 * - 'search' / 'graph' / 'settings'：打开对应的浮层。
 *
 * 依赖 store：sync（同步状态与手动触发）、vault（当前笔记）。
 */
import { computed } from 'vue'
import { titleOf } from '@/core/vault/paths.ts'
import { useSyncStore } from '@/stores/sync.ts'
import { useVaultStore } from '@/stores/vault.ts'

/** 只上报意图，具体开哪个浮层由父级决定。 */
const emit = defineEmits<{
  (e: 'toggle-sidebar'): void
  (e: 'toggle-right'): void
  (e: 'search'): void
  (e: 'graph'): void
  (e: 'settings'): void
}>()

const sync = useSyncStore()
const vault = useVaultStore()

/** 标题行：无选中笔记时退回应用名，避免顶栏出现空白。 */
const title = computed(() => (vault.activePath ? titleOf(vault.activePath) : 'WebVault'))
/** 待上传篇数，>0 时在同步按钮上挂数字角标。 */
const pending = computed(() => vault.pendingUpload)
/** 同步进行中禁用按钮，防重入。 */
const syncable = computed(() => !sync.syncing)
/** 离线态：用高亮样式区分「已联网」，让用户一眼看出当前是否只能本地操作。 */
const offline = computed(() => !sync.online)

/** 手动同步；syncing 时静默忽略（按钮已 disabled，这里兜住键盘触发的情况）。 */
function onSync(): void {
  if (sync.syncing) return
  void sync.syncNow()
}
</script>

<template>
  <header class="topbar">
    <button class="tb tb--square" aria-label="笔记列表" title="笔记列表" @click="emit('toggle-sidebar')">
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path d="M2 3.5h12M2 8h12M2 12.5h8" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
      </svg>
    </button>

    <!-- 左区：侧栏开关 + 当前笔记标题（副行是完整路径）；与右区的全局动作之间靠 spacer 撑开 -->
    <div class="topbar__title">
      <span class="topbar__name">{{ title }}</span>
      <span v-if="vault.activePath" class="topbar__path">{{ vault.activePath }}</span>
    </div>

    <div class="topbar__gap"></div>

    <button class="tb" title="全库搜索 (Ctrl/⌘ + F)" @click="emit('search')">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" fill="none" />
        <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
      <span class="tb__label">搜索</span>
    </button>

    <button class="tb" title="关系图谱" @click="emit('graph')">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="4" cy="4" r="2" fill="currentColor" />
        <circle cx="12.5" cy="6" r="2" fill="currentColor" />
        <circle cx="6.5" cy="12.5" r="2" fill="currentColor" />
        <path d="M5.7 5.1L10.8 5.6M5.3 5.8L6.2 10.7M11 7.8L7.9 11.2" stroke="currentColor" stroke-width="1.2" fill="none" />
      </svg>
      <span class="tb__label">图谱</span>
    </button>

    <!-- 同步：进行中用 spinner 替换图标，文案跟随 sync.statusText；角标只统计待上传篇数；
         title 按 sync.available 在「立即同步 / 离线或未配置同步」间切换 -->
    <button
      class="tb"
      :class="{ 'tb--on': !offline }"
      :disabled="!syncable"
      :title="sync.available ? '立即同步' : '离线或未配置同步'"
      @click="onSync"
    >
      <span v-if="sync.syncing" class="spinner"></span>
      <svg v-else viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path
          d="M13.5 8a5.5 5.5 0 01-9.36 3.9M2.5 8a5.5 5.5 0 019.36-3.9"
          stroke="currentColor"
          stroke-width="1.5"
          fill="none"
          stroke-linecap="round"
        />
        <path d="M12 1.6v2.6h-2.6M4 14.4v-2.6h2.6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
      </svg>
      <span class="tb__label">{{ sync.syncing ? '同步中' : sync.statusText }}</span>
      <span v-if="pending > 0 && !sync.syncing" class="pill" :title="`${pending} 篇待上传`">{{ pending }}</span>
    </button>

    <!-- 右区尾部：反链面板与设置入口，均为不带文字标签的方形图标按钮 -->
    <button class="tb tb--square" aria-label="反链面板" title="反链面板" @click="emit('toggle-right')">
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path
          d="M6.8 9.2l2.4-2.4M5.4 7.1L4 8.5a2.5 2.5 0 003.5 3.5l1.4-1.4M10.6 8.9L12 7.5A2.5 2.5 0 008.5 4L7.1 5.4"
          stroke="currentColor"
          stroke-width="1.4"
          fill="none"
          stroke-linecap="round"
        />
      </svg>
    </button>

    <button class="tb tb--square" aria-label="设置" title="设置" @click="emit('settings')">
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.4" fill="none" />
        <path
          d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8L3.6 3.6"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 44px;
  flex: none;
  padding: 0 8px;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
}

.topbar__title {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  padding: 0 6px;
  line-height: 1.2;
}

.topbar__name {
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.topbar__path {
  font-size: 10.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 借 rtl 让省略号出现在开头：长路径被截断时保住末尾的目录/文件名 */
  direction: rtl;
  text-align: left;
}

.topbar__gap {
  /* 弹性占位：把标题挤向左、全局动作推向右，顶栏只剩左右两簇控件 */
  flex: 1;
}

/* 通用工具按钮（图标 + 可省略的文字）；tb--square 是不带文字的方形图标钮 */
.tb {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
  height: 28px;
  padding: 0 9px;
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--text-muted);
  white-space: nowrap;
}

.tb--square {
  padding: 0;
  width: 28px;
  justify-content: center;
}

.tb:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}

.tb:disabled {
  opacity: 0.55;
  cursor: default;
}

.tb__label {
  max-width: 132px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 待上传篇数角标：同步进行中不显示，避免与 spinner 和状态文案重复报同一件事 */
.pill {
  padding: 0 5px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 10.5px;
  line-height: 15px;
}

.spinner {
  width: 12px;
  height: 12px;
  flex: none;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 窄屏：隐藏按钮文字标签与副行完整路径，顶栏只留图标与笔记标题 */
@media (max-width: 720px) {
  .tb__label {
    display: none;
  }

  .tb {
    padding: 0 7px;
  }

  .topbar__title {
    max-width: 42vw;
  }

  .topbar__path {
    display: none;
  }
}
</style>
