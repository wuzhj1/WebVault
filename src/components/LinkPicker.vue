<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { resolveTarget } from '@/core/index/resolve.ts'
import { useVaultStore } from '@/stores/vault.ts'

const emit = defineEmits<{
  (e: 'open', path: string): void
  (e: 'insert', target: string): void
  (e: 'close'): void
}>()

const vault = useVaultStore()

const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const cursor = ref(0)

interface Row {
  target: string
  exists: boolean
}

const rows = computed<Row[]>(() =>
  vault.suggestLinks(query.value).map((item) => ({
    target: item.value,
    exists: resolveTarget(vault.resolver, item.value) !== null,
  })),
)

function move(delta: number): void {
  if (rows.value.length === 0) return
  cursor.value = (cursor.value + delta + rows.value.length) % rows.value.length
  void nextTick(() => document.querySelector('.pick--on')?.scrollIntoView({ block: 'nearest' }))
}

function open(row?: Row): void {
  const target = row ?? rows.value[cursor.value]
  if (!target) return
  void vault.createFromLink(target.target).then((path) => {
    emit('open', path)
    emit('close')
  })
}

function insert(row?: Row): void {
  const target = row ?? rows.value[cursor.value]
  if (!target) return
  emit('insert', target.target)
  emit('close')
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) insert()
    else open()
  }
}

watch(query, () => {
  cursor.value = 0
})

onMounted(() => {
  input.value?.focus()
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div class="pick" @mousedown.self="emit('close')">
      <div class="pick__box" role="dialog" aria-label="链接到笔记">
        <div class="pick__bar">
          <span class="pick__mark">[[</span>
          <input
            ref="input"
            v-model="query"
            class="pick__input"
            placeholder="输入笔记名,回车打开,Ctrl/⌘ + 回车插入链接"
            autocapitalize="off"
            spellcheck="false"
          />
          <button class="pick__close" aria-label="关闭" @click="emit('close')">×</button>
        </div>

        <div class="pick__list">
          <p v-if="rows.length === 0" class="tip">
            输入名称后会创建一篇新笔记。留空可浏览全部笔记。
          </p>
          <button
            v-for="(r, i) in rows"
            :key="r.target"
            class="pick__row"
            :class="{ 'pick--on': i === cursor }"
            @click="open(r)"
            @mouseenter="cursor = i"
          >
            <span class="pick__target">
              <span v-if="!r.exists" class="pick__badge">新建</span>
              {{ r.target }}
            </span>
            <span class="pick__insert" @click.stop="insert(r)">插入</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pick {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 14vh 16px 16px;
  background: var(--scrim);
  backdrop-filter: blur(2px);
}

.pick__box {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 520px;
  max-height: 60vh;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 18px 50px var(--shadow-color);
  overflow: hidden;
}

.pick__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
}

.pick__mark {
  font-size: 15px;
  color: var(--accent);
}

.pick__input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font-size: 15px;
  color: var(--text);
}

.pick__input::placeholder {
  color: var(--text-muted);
  font-size: 13px;
}

.pick__close {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  font-size: 19px;
  line-height: 1;
  color: var(--text-muted);
}

.pick__close:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.pick__list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px;
}

.tip {
  margin: 10px 8px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-muted);
}

.pick__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 7px;
  text-align: left;
}

.pick--on {
  background: var(--accent-soft);
}

.pick__target {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick--on .pick__target {
  color: var(--accent-text);
}

.pick__badge {
  margin-right: 5px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 10.5px;
}

.pick__insert {
  flex: none;
  padding: 2px 8px;
  border-radius: 5px;
  border: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-muted);
}

.pick__insert:hover {
  border-color: var(--accent);
  color: var(--accent);
}

@media (max-width: 640px) {
  .pick {
    padding: 0;
    align-items: stretch;
  }

  .pick__box {
    max-width: none;
    max-height: none;
    border-radius: 0;
    border: none;
  }
}
</style>
