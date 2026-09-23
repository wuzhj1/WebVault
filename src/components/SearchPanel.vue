<script setup lang="ts">
/**
 * 全库搜索面板：居中浮层（命令面板式），输入即搜，列出标题 / 正文 / 标签命中的笔记。
 *
 * 并发与防抖：
 * - 输入停顿 180ms 才真正发起搜索（见 watch(query)），避免每敲一个字都跑一次查询、读一遍正文。
 * - run() 用自增序号 seq 做过期判定：新一次调用把序号顶掉，旧请求即使更晚返回也只丢弃结果，
 *   busy 的复位同理 —— 否则旧请求的 finally 会提前熄掉新请求的 loading 指示。
 * 键盘契约：↑/↓ 循环移动高亮，Enter 打开当前命中，Esc 关闭；监听挂 document（焦点在输入框内）。
 * props：`initial` 是打开时预填的查询串（侧栏点标签走 `#标签` 这条路）。
 * emits：`open(path)` 打开命中笔记；`close()` 关闭面板（App.vue 以 v-if 挂卸）。
 * 依赖：core/search 的 search()（索引是否重建由传入的 vault.revision 决定）与 vault store。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { search, type SearchHit } from '@/core/search/index.ts'
import { useVaultStore } from '@/stores/vault.ts'

/** 两条出口：open=打开命中并顺带关闭面板；close=纯关闭（Esc / 点遮罩 / 点 ×）。 */
const emit = defineEmits<{ (e: 'open', path: string): void; (e: 'close'): void }>()

/** 侧栏点标签带过来的初始查询（`#标签`）；在 setup 期就写进 query，赶在 watch 注册之前，不会多触发一次防抖。 */
const props = defineProps<{ initial?: string }>()

const vault = useVaultStore()

/** 挂载即聚焦：面板的主交互就是直接打字。 */
const input = ref<HTMLInputElement | null>(null)
/** 查询串，每次变动触发防抖搜索。 */
const query = ref((props.initial ?? '').trim())
/** 当前结果，整批替换（不做逐条 diff）。 */
const hits = ref<SearchHit[]>([])
/** 高亮下标，键盘与鼠标 hover 共用。 */
const cursor = ref(0)
/** 是否有在途查询，只驱动输入行里的 spinner。 */
const busy = ref(false)

/** 查询序号：只增不减，最新一次的值即「有效代次」，旧代次的结果（含报错）一律丢弃。 */
let seq = 0
/** 防抖句柄；null 表示当前没有待触发的查询。 */
let timer: ReturnType<typeof setTimeout> | null = null

/** 未下载正文的篇数：这些笔记不在索引范围内，用来解释「为什么搜不到某篇」。 */
const uncachedCount = computed(() => vault.uncached.length)

/**
 * 执行一次搜索：空查询直接清空并复位，不触碰索引。
 * 结果与 busy 只在自己仍是最新代次（mine === seq）时才写回；
 * catch 里同样先判代次 —— 过期请求的报错也不该影响界面。
 */
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
    const found = await search(q, vault.revision)
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

// 180ms 防抖：每次输入重置定时器，只在停顿后搜一次，顺带合并粘贴等连续变动。
watch(query, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void run()
  }, 180)
})

/** 环形移动高亮（首尾相接）；nextTick 后按 .result--on 滚到可视区，等高亮 class 落到 DOM 再算位置。 */
function move(delta: number): void {
  if (hits.value.length === 0) return
  cursor.value = (cursor.value + delta + hits.value.length) % hits.value.length
  void nextTick(() => {
    document
      .querySelector('.result--on')
      ?.scrollIntoView({ block: 'nearest' })
  })
}

/** 打开命中（缺省取高亮行）并关闭面板。 */
function choose(hit?: SearchHit): void {
  const target = hit ?? hits.value[cursor.value]
  if (!target) return
  emit('open', target.path)
  emit('close')
}

/** document 级键盘导航：Esc 关闭、↑/↓ 移动高亮（preventDefault 兼带拦掉页面滚动）、Enter 打开。 */
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

// 打开即聚焦输入框；document 监听必须成对解绑，否则面板关闭后仍会响应键盘。
// 带初始查询打开时跳过防抖直接搜一次——用户点了标签就是来看结果的，不该先愣 180ms。
onMounted(() => {
  input.value?.focus()
  document.addEventListener('keydown', onKeydown)
  if (query.value !== '') void run()
})

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩：.self 点空白关闭；卡片内操作不冒泡到遮罩 -->
    <div class="search" @mousedown.self="emit('close')">
      <div class="search__box" role="dialog" aria-label="全库搜索">
        <!-- 输入行：busy 时用 spinner 占位，提示查询仍在进行 -->
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

        <!-- 结果区三分支：空查询说明（顺带交代索引覆盖范围）/ 无命中 / 命中列表 -->
        <div class="search__results">
          <p v-if="query.trim() === ''" class="tip">
            中文按字与双字组合匹配,英文支持前缀。共 {{ vault.notes.length }} 篇笔记已建立索引。
            <template v-if="uncachedCount > 0">另有 {{ uncachedCount }} 篇尚未下载,不在搜索范围内。</template>
          </p>
          <p v-else-if="hits.length === 0 && !busy" class="tip">没有找到匹配的笔记。</p>

          <!-- 命中行：click 打开，mouseenter 同步高亮，与键盘 cursor 始终指向同一行 -->
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
/* 遮罩与卡片：10vh 顶部留白让浮层悬在视口上部，类似命令面板的位置 */
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

/* 输入行：卡片顶部固定，不随结果列表滚动；spinner 与关闭按钮并排占位不跳动 */
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

/* 结果列表：flex:1 + min-height:0 承担滚动，超出 70vh 在内部滚 */
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
  /* 高亮底色：键盘与 hover 共用 cursor，谁动底色就跟谁 */
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

/* 加载指示：索引重建或摘要回读正文期间转圈，替代结果区的「无命中」提示 */
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

/* 窄屏：去掉留白与圆角，整个面板铺满视口 */
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
