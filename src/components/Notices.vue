<script setup lang="ts">
/**
 * 全局提示条:固定在右下角渲染同步相关的通知(info / warn / error 三档,左侧描边色区分)。
 *
 * 无 props、无 emits —— 整块是 sync store 的纯投影。列表为空时它是个没有子项的 flex 列,fixed 定位下自行
 * 塌成零尺寸,因此不会挡住右下角的交互(容器没设 pointer-events: none,别往里加常驻占位的子元素)。
 * 依赖 useSyncStore 的 `notices`(待展示队列)与 `dismissNotice`(手动关闭)。
 *
 * 关键约束:自动消失的定时器归 sync store 管(只有 info 档会 setTimeout 自杀,warn/error 常驻到用户关掉),
 * 这里绝不能再起一个计时器,否则两把表互相抢着删同一条。
 */
import { useSyncStore } from '@/stores/sync.ts'

const sync = useSyncStore()
</script>

<template>
  <!-- aria-live="polite":错误不打断朗读,但屏幕阅读器会在停顿后补报 -->
  <div class="notices" aria-live="polite">
    <!-- 逐条过渡：以 n.id 为 key，关掉某条只影响它自己的进出场 -->
    <TransitionGroup name="notice">
      <div v-for="n in sync.notices" :key="n.id" class="notice" :class="`notice--${n.kind}`">
        <span class="notice__text">{{ n.text }}</span>
        <button class="notice__close" aria-label="关闭提示" @click="sync.dismissNotice(n.id)">
          ×
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.notices {
  /* 脱离文档流钉在视口右下角;z-index 80 高于所有遮罩(60/70),保证被模态盖住时提示仍可见 */
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 80;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(420px, calc(100vw - 32px));
}

.notice {
  /* 3px 左边框留给档位色条，其余三边保持中性 —— 档位信息全靠这一条颜色传达 */
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid var(--border);
  border-left-width: 3px;
  background: var(--bg-elevated);
  box-shadow: 0 8px 24px var(--shadow-color);
  font-size: 13px;
  line-height: 1.55;
}

.notice__text {
  flex: 1;
  /* 长路径 / 长错误串强制折行，避免把卡片顶出 max-width */
  word-break: break-word;
}

.notice__close {
  flex: none;
  font-size: 17px;
  line-height: 1;
  color: var(--text-muted);
}

.notice__close:hover {
  color: var(--text);
}

/* 三档左侧色条，与 sync store 里 notices[].kind 一一对应 */
.notice--info {
  border-left-color: var(--accent);
}

.notice--warn {
  border-left-color: var(--warn);
}

.notice--error {
  border-left-color: var(--danger);
}

/* 进出场共用一组 from/to 类:淡入 + 自下方浮起,让新提示不至于凭空出现 */
.notice-enter-active,
.notice-leave-active {
  transition:
    opacity 0.18s,
    transform 0.18s;
}

.notice-enter-from,
.notice-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

/* 窄屏没有右侧留白可省:左右各贴 10px,变成整宽提示条 */
@media (max-width: 640px) {
  .notices {
    right: 10px;
    left: 10px;
    bottom: 10px;
    max-width: none;
  }
}
</style>
