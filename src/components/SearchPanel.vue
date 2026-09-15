<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { search, type SearchHit } from '@/core/search/index.ts'
import { useVaultStore } from '@/stores/vault.ts'

const emit = defineEmits<{ (e: 'open', path: string): void; (e: 'close'): void }>()

const vault = useVaultStore()

const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const hits = ref<SearchHit[]>([])
const cursor = ref(0)
const busy = ref(false)

let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * Cheap stand-in for a content version counter: any save bumps a note's mtime, which
 * changes this sum and makes the search layer rebuild its index.
 */
const revision = computed(() => {
  let r = 0
  for (const n of vault.notes) r = (r * 31 + n.mtime + n.path.length) % 2147483647
  return r
})

const uncachedCount = computed(() => vault.uncached.length)

async function run(): Promise<void> {
  const q = query.value.trim()
  if (q === '') {
    hits.value = []
    cursor.value = 0
    return
  }
  const mine = ++seq
  busy.value = true
  try {
    const found = await search(q, revision.value)
    if (mine !== seq) return
    hits.value = found
    cursor.value = 0
  } catch (err) {
    if (mine !== seq) return
    hits.value = []
    console.error('search failed', err)
  } finally {
    if (mine === seq) busy.value = false
  }
}

watch(query, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void run()
  }, 180)
})

function move(delta: number): void {
  if (hits.value.length === 0) return
  cursor.value = (cursor.value + delta + hits.value.length) % hits.value.length
  void nextTick(() => {
    document
      .querySelector('.result--on')
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function choose(hit?: SearchHit): void {
  const target = hit ?? hits.value[cursor.value]
  if (!target) return
  emit('open', target.path)
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
    choose()
  }
}

onMounted(() => {
  input.value?.focus()
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div class="search" @mousedown.self="emit('close')">
      <div class="search__box" role="dialog" aria-label="全库搜索">
        <div class="search__bar">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" fill="none" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          <input
            ref="input"
            v-model="query"
            class="search__input"
            placeholder="搜索标题、正文与标签…"
            autocapitalize="off"
            spellcheck="false"
          />
          <span v-if="busy" class="spinner"></span>
          <button class="search__close" aria-label="关闭" @click="emit('close')">×</button>
        </div>

        <div class="search__results">
          <p v-if="query.trim() === ''" class="tip">
            中文按字与双字组合匹配,英文支持前缀。共 {{ vault.notes.length }} 篇笔记已建立索引。
            <template v-if="uncachedCount > 0">另有 {{ uncachedCount }} 篇尚未下载,不在搜索范围内。</template>
          </p>
          <p v-else-if="hits.length === 0 && !busy" class="tip">没有找到匹配的笔记。</p>

          <button
            v-for="(h, i) in hits"
            :key="h.path"
            class="result"
            :class="{ 'result--on': i === cursor }"
            @click="choose(h)"
            @mouseenter="cursor = i"
          >
            <span class="result__title">{{ h.title }}</span>
            <span class="result__excerpt">{{ h.excerpt }}</span>
            <span class="result__path">{{ h.path }}</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.search {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 10vh 16px 16px;
  background: var(--scrim);
  backdrop-filter: blur(2px);
}

.search__box {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 640px;
  max-height: 70vh;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 18px 50px var(--shadow-color);
  overflow: hidden;
}

.search__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
}

.search__input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font-size: 15px;
  color: var(--text);
}

.search__input::placeholder {
  color: var(--text-muted);
}

.search__close {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  font-size: 19px;
  line-height: 1;
  color: var(--text-muted);
}

.search__close:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.search__results {
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

.result {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border-radius: 7px;
  text-align: left;
}

.result--on {
  background: var(--accent-soft);
}

.result__title {
  display: block;
  font-size: 13.5px;
  font-weight: 500;
}

.result--on .result__title {
  color: var(--accent-text);
}

.result__excerpt {
  margin-top: 2px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-muted);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.result__path {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.75;
}

.spinner {
  width: 13px;
  height: 13px;
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

@media (max-width: 640px) {
  .search {
    padding: 0;
    align-items: stretch;
  }

  .search__box {
    max-width: none;
    max-height: none;
    border-radius: 0;
    border: none;
  }
}
</style>
