<script setup lang="ts">
import { useSyncStore } from '@/stores/sync.ts'

const sync = useSyncStore()
</script>

<template>
  <div class="notices" aria-live="polite">
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
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid var(--border);
  border-left-width: 3px;
  background: var(--bg-elevated);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  font-size: 13px;
  line-height: 1.55;
}

.notice__text {
  flex: 1;
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

.notice--info {
  border-left-color: var(--accent);
}

.notice--warn {
  border-left-color: var(--warn);
}

.notice--error {
  border-left-color: var(--danger);
}

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

@media (max-width: 640px) {
  .notices {
    right: 10px;
    left: 10px;
    bottom: 10px;
    max-width: none;
  }
}
</style>
