<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

const props = defineProps<{ title: string; wide?: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div class="modal" @mousedown.self="emit('close')">
      <div class="modal__box" :class="{ 'modal__box--wide': props.wide }" role="dialog">
        <header class="modal__head">
          <h3>{{ props.title }}</h3>
          <button class="modal__close" aria-label="关闭" @click="emit('close')">×</button>
        </header>
        <div class="modal__body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="modal__foot">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 8vh 16px 16px;
  background: var(--scrim);
  backdrop-filter: blur(2px);
}

.modal__box {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 520px;
  max-height: 82vh;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 18px 50px var(--shadow-color);
  overflow: hidden;
}

.modal__box--wide {
  max-width: 880px;
}

.modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.modal__head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.modal__close {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  font-size: 19px;
  line-height: 1;
  color: var(--text-muted);
}

.modal__close:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.modal__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

@media (max-width: 640px) {
  .modal {
    padding: 0;
    align-items: stretch;
  }

  .modal__box,
  .modal__box--wide {
    max-width: none;
    max-height: none;
    border-radius: 0;
    border: none;
  }
}
</style>
