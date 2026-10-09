<script setup lang="ts">
/**
 * 选区 AI 操作浮层:选中正文后在选区旁浮出 🤖 按钮,点开后是动作列表 → 流式结果 →
 * [插入到下方 / 替换选中 / 复制]。Teleport 到 body,用 fixed 定位跟着选区的矩形走。
 *
 * 纪律落点(与 AiPanel 同一套规则,这里独立实现因为上下文是选区而不是会话):
 * - **永不裸插**:两个插入出口都经 `aiQuoteBlock` 包成 `> 🤖` 引用块才 emit 出去,
 *   NoteEditor 只负责落位,拿不到未标记的原文;
 * - **替换是显式按钮**:「插入到下方」是默认动作;替换会吃掉原文,单独一个按钮、
 *   由 NoteEditor 回放打开浮层那一刻钉住的选区(`aiRange`)来执行——期间用户若在
 *   编辑器里重新编辑,选区失效时插入自动退化为「插到下方」,绝不误删;
 * - **组件卸载即中止**:浮层是瞬态 UI,关掉、换选区、换笔记都触发 onBeforeUnmount 里
 *   的 abort,不留孤儿请求继续烧 token。
 *
 * 够不着的两件事上抛:打开设置页(未配置时的引导)与插入落位,分别由 NoteEditor、App 接手。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { aiQuoteBlock } from '@/core/ai/marks.ts'
import {
  AI_COPY,
  SELECTION_ACTIONS,
  SYSTEM_PROMPT,
  buildSelectionPrompt,
  type AiAction,
} from '@/core/ai/prompts.ts'
import { isAborted, streamChat } from '@/core/ai/client.ts'
import { useAiSettingsStore } from '@/stores/aiSettings.ts'

const props = defineProps<{
  /** 选区锚点:触发按钮的落点(x=选区左,y=选区底)与选中的原文。 */
  anchor: { x: number; y: number; text: string }
}>()

const emit = defineEmits<{
  (e: 'close'): void
  /** 插入请求:markdown 已带 🤖 引用块;mode 由 NoteEditor 落位(下方/替换)。 */
  (e: 'insert', payload: { markdown: string; mode: 'after' | 'replace' }): void
  (e: 'open-settings'): void
}>()

const aiCfg = useAiSettingsStore()

/** 未配置时动作列表只是摆设:先读一次配置(带重入守卫),没配好引导去设置页。 */
void aiCfg.load()

/** 浮层开合:false = 只有触发按钮,true = 展开动作/结果面板。 */
const open = ref(false)
/** 结果面板的两个阶段:动作列表 → 流式结果。 */
const view = ref<'actions' | 'result'>('actions')
/** 当前产出对应的动作,结果头部显示它的标签。 */
const action = ref<AiAction | null>(null)
/** 流式累计的回复正文。 */
const result = ref('')
/** 最近一次失败原因;内联展示,不打断选区。 */
const error = ref<string | null>(null)
/** 复制回执,1.5 秒后复原。 */
const copied = ref(false)
/** 流式进行中的标志;按钮文案与禁用态都看它。 */
const streaming = ref(false)
/** 正在飞的请求;停止与卸载共用它。 */
let abortCtrl: AbortController | null = null
let copiedTimer: ReturnType<typeof setTimeout> | null = null

/** 根节点引用;mousedown 关闭判断要知道点没点在浮层里(触发按钮与面板共用)。 */
const rootRef = ref<HTMLElement | null>(null)

/** 触发按钮的 fixed 落点:贴着选区左下角,越界时收进视口。 */
const triggerStyle = computed(() => {
  const x = Math.min(Math.max(8, props.anchor.x), window.innerWidth - 44)
  const y = Math.min(props.anchor.y + 6, window.innerHeight - 44)
  return { left: `${x}px`, top: `${y}px` }
})

/**
 * 面板的 fixed 落点:优先选区下方,放不下(贴着视口底)改夹到视口底部;
 * 面板自身 `max-height` 兜底,超长结果在面板内滚动。
 */
const panelStyle = computed(() => {
  const W = 302
  const H = 348
  const left = Math.min(Math.max(8, props.anchor.x - 6), Math.max(8, window.innerWidth - W - 8))
  const below = props.anchor.y + 6
  const top = below + H <= window.innerHeight - 8 ? below : Math.max(8, window.innerHeight - H - 8)
  return { left: `${left}px`, top: `${top}px` }
})

/** 结果头部的模型标签;未配置时没有模型,只显示动作名。 */
const modelLabel = computed(() => aiCfg.settings.model || '未配置')

/**
 * 跑一个选区动作:prompt 由 prompts 层按动作 id 组装,回复逐段累进 `result`。
 * 用户主动停止走 isAborted 静默(已产出的部分留在面板里),其余错误如实内联。
 */
async function run(a: AiAction): Promise<void> {
  if (streaming.value || !aiCfg.configured) return
  action.value = a
  view.value = 'result'
  result.value = ''
  error.value = null
  streaming.value = true
  abortCtrl = new AbortController()
  try {
    await streamChat({
      cfg: { ...aiCfg.settings },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildSelectionPrompt(a.id, props.anchor.text) },
      ],
      signal: abortCtrl.signal,
      onDelta: (delta) => {
        result.value += delta
      },
    })
    if (result.value === '') error.value = '（模型返回了空回复）'
  } catch (err) {
    if (!isAborted(err)) error.value = err instanceof Error ? err.message : String(err)
  } finally {
    streaming.value = false
    abortCtrl = null
  }
}

function stop(): void {
  abortCtrl?.abort()
}

/**
 * 两个插入出口:markdown 在这里就包好 🤖 引用块,NoteEditor 收到的永远是带标记的内容。
 * 插入完先 emit close——浮层是瞬态的,插完就该把视野还给编辑器。
 */
function insert(mode: 'after' | 'replace'): void {
  if (result.value === '') return
  const model = aiCfg.settings.model
  emit('insert', {
    markdown: aiQuoteBlock(result.value, model === '' ? 'AI' : model, action.value?.label),
    mode,
  })
  emit('close')
}

async function copy(): Promise<void> {
  if (result.value === '') return
  try {
    await navigator.clipboard.writeText(result.value)
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    error.value = '复制失败:浏览器拒绝了剪贴板访问'
  }
}

/** 返回动作列表:保留已生成的结果供「再跑一个动作」覆盖,不额外存副本。 */
function back(): void {
  if (streaming.value) return
  view.value = 'actions'
  error.value = null
}

/**
 * 点浮层外面就收起:选区交互的惯例是「点别处即走」。
 * capture 阶段在编辑器自己的 mousedown 监听之前跑,两边互不干扰
 * (编辑器那边只管 chips/复选框的 preventDefault,这边只管卸载自己)。
 */
function onDocMouseDown(event: MouseEvent): void {
  const root = rootRef.value
  if (root && event.target instanceof Node && root.contains(event.target)) return
  emit('close')
}

/** Esc 与滚轮都会让浮层失去意义:Esc 是关闭惯例,滚轮后选区矩形已经不准了。 */
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}
function onWindowWheel(): void {
  emit('close')
}

// 换了选区(极少数不经过 mousedown 的路径)就复位到动作列表,并中止在飞的流。
watch(
  () => props.anchor,
  () => {
    abortCtrl?.abort()
    open.value = false
    view.value = 'actions'
    action.value = null
    result.value = ''
    error.value = null
  },
)

document.addEventListener('mousedown', onDocMouseDown, true)
window.addEventListener('keydown', onWindowKeydown, true)
window.addEventListener('wheel', onWindowWheel, { capture: true, passive: true })

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown, true)
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('wheel', onWindowWheel, true)
  if (copiedTimer) clearTimeout(copiedTimer)
  // 卸载即中止:浮层关掉、换笔记、组件销毁都走这条,不给孤儿请求留活口。
  abortCtrl?.abort()
})
</script>

<template>
  <Teleport to="body">
    <!-- 触发按钮:选区旁一个 🤖,点开才展开面板——动作不抢在选区刚完成的那一刻弹出 -->
    <div v-if="!open" ref="rootRef" class="ais" :style="triggerStyle">
      <button
        class="ais__btn"
        type="button"
        title="AI 处理选中的文本"
        aria-label="AI 处理选中的文本"
        @click="open = true"
      >
        🤖
      </button>
    </div>

    <div v-else ref="rootRef" class="ais ais--panel" :style="panelStyle">
      <!-- 头部:结果阶段多一个返回;模型标签说明产出身份 -->
      <div class="ais__head">
        <button
          v-if="view === 'result'"
          class="ais__icon"
          type="button"
          aria-label="返回动作列表"
          :disabled="streaming"
          @click="back"
        >
          ←
        </button>
        <span class="ais__title">
          {{ view === 'result' ? `${action?.label ?? ''} · ${modelLabel}` : '选区操作' }}
        </span>
        <button class="ais__icon" type="button" aria-label="关闭" @click="emit('close')">×</button>
      </div>

      <!-- 动作列表 -->
      <template v-if="view === 'actions'">
        <p v-if="!aiCfg.configured" class="ais__hint">
          {{ AI_COPY.unconfigured }}
          <button class="ais__link" type="button" @click="emit('open-settings')">去设置 →</button>
        </p>
        <div class="ais__grid" :class="{ 'ais__grid--off': !aiCfg.configured }">
          <button
            v-for="a in SELECTION_ACTIONS"
            :key="a.id"
            class="ais__action"
            type="button"
            :title="a.hint"
            :disabled="!aiCfg.configured"
            @click="run(a)"
          >
            {{ a.label }}
            <em class="ais__action-hint">{{ a.hint }}</em>
          </button>
        </div>
        <p v-if="aiCfg.configured" class="ais__hint">
          已选 {{ anchor.text.length }} 字 · 输出会包在 🤖 引用块里插入,不裸插
        </p>
      </template>

      <!-- 流式结果 -->
      <template v-else>
        <div class="ais__body">
          <p v-if="error" class="ais__error">{{ error }}</p>
          <div class="ais__text">
            {{ result }}<span v-if="streaming" class="ais__cursor">▍</span>
          </div>
        </div>
        <div class="ais__foot">
          <button
            class="ais__act"
            type="button"
            :disabled="streaming || result === ''"
            title="原文保留,AI 内容以引用块落在它下方"
            @click="insert('after')"
          >
            插入到下方
          </button>
          <button
            class="ais__act ais__act--warn"
            type="button"
            :disabled="streaming || result === ''"
            title="会删掉选中的原文,再放入带标记的 AI 引用块"
            @click="insert('replace')"
          >
            替换选中
          </button>
          <button class="ais__act" type="button" :disabled="result === ''" @click="copy()">
            {{ copied ? '已复制' : '复制' }}
          </button>
          <button v-if="streaming" class="ais__act ais__act--stop" type="button" @click="stop">
            停止
          </button>
        </div>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
/* 根浮层:fixed 定位由 props 的 anchor 算出,Teleport 到 body 不受编辑器 overflow 裁剪 */
.ais {
  position: fixed;
  z-index: 90;
}

.ais__btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated);
  font-size: 15px;
  line-height: 1;
  box-shadow: 0 6px 18px var(--shadow-color);
  transition: border-color 0.12s ease, transform 0.12s ease;
}

.ais__btn:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}

/* 面板:定宽 + max-height 双保险,越界由 panelStyle 夹、超长在 body 内滚 */
.ais--panel {
  display: flex;
  flex-direction: column;
  width: 302px;
  max-height: calc(100vh - 16px);
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-elevated);
  box-shadow: 0 14px 36px var(--shadow-color);
}

.ais__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-bottom: 1px solid var(--border);
}

.ais__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 600;
}

.ais__icon {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1;
  color: var(--text-muted);
}

.ais__icon:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}

.ais__icon:disabled {
  opacity: 0.45;
  cursor: default;
}

.ais__hint {
  margin: 8px 10px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-muted);
}

.ais__link {
  color: var(--accent);
  font-size: 11.5px;
}

/* 动作网格:两列,主标签 + 悬停提示两行结构 */
.ais__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding: 9px;
}

.ais__grid--off {
  opacity: 0.55;
}

.ais__action {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 12.5px;
  text-align: left;
  color: var(--text);
  transition: background-color 0.12s ease, border-color 0.12s ease;
}

.ais__action:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent-text);
  border-color: transparent;
}

.ais__action:disabled {
  cursor: default;
}

.ais__action-hint {
  font-size: 10.5px;
  font-style: normal;
  color: var(--text-muted);
  line-height: 1.5;
}

.ais__action:hover:not(:disabled) .ais__action-hint {
  color: inherit;
  opacity: 0.8;
}

/* 结果正文:pre-wrap 保段落,超长在面板内滚 */
.ais__body {
  flex: 1;
  min-height: 60px;
  overflow: auto;
  padding: 9px 10px;
}

.ais__error {
  margin: 0 0 6px;
  padding: 5px 7px;
  border-radius: 6px;
  background: var(--bg-hover);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--danger);
}

.ais__text {
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.ais__cursor {
  color: var(--accent);
  animation: ais-blink 1s steps(2) infinite;
}

@keyframes ais-blink {
  50% {
    opacity: 0;
  }
}

.ais__foot {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 9px;
  border-top: 1px solid var(--border);
}

.ais__act {
  padding: 4px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  font-size: 12px;
  color: var(--text);
  transition: background-color 0.12s ease, border-color 0.12s ease;
}

.ais__act:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent-text);
  border-color: transparent;
}

/* 替换会删原文,中性描边:hover 也不给 accent 的「邀请感」——危险动作不诱导点击 */
.ais__act--warn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
  border-color: var(--text-muted);
}

.ais__act--stop:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}

.ais__act:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
