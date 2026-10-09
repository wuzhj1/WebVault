<script setup lang="ts">
/**
 * AI 面板：侧栏第 4 分区的内容区，两个页签——对话（默认）与产出（`ai/` 目录）。
 *
 * 分隔纪律在这块 UI 上的落点：
 * - 对话状态全在 `stores/ai.ts`（流也在 store 里跑）：切页签、切分区、关面板都不中断生成，
 *   回来接着看；历史存 `.webvault/ai-chats.json`，不进笔记库、不进搜索、不推 Gitee；
 * - 产出页签只列 `isAiPath`（`ai/` 目录）的笔记，行行带 🤖 角标——与文件树角标同一个判定；
 * - 任何写进笔记的出口都带标记：「插入到笔记」包 `aiQuoteBlock` 引用块、「存为笔记」走
 *   `buildAiNoteContent` 的 frontmatter + 声明行，本组件不提供裸插路径；
 * - 「引用当前笔记」是显式动作（点按钮才引用），芯片常驻直到用户 × 摘掉，
 *   摘掉之前每次发送都会带上正文——多轮追问围绕同一篇笔记，这是刻意的。
 *
 * 本组件够不着的三件事全部上抛（SideBar 转发给 App）：引用要先 `flushSave()`、
 * 插入要走编辑器、打开设置页要走 overlay——面板永远不 import 编辑器与浮层。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { dirOf, titleOf } from '@/core/vault/paths.ts'
import { aiQuoteBlock, isAiPath } from '@/core/ai/marks.ts'
import {
  AI_COPY,
  NOTE_ACTIONS,
  buildLinkSuggestPrompt,
  buildNotePrompt,
  type AiAction,
} from '@/core/ai/prompts.ts'
import { useAiSettingsStore } from '@/stores/aiSettings.ts'
import { useAiStore, type AiMessage } from '@/stores/ai.ts'
import { useSyncStore } from '@/stores/sync.ts'
import { useVaultStore } from '@/stores/vault.ts'

const props = defineProps<{
  /** 页签：chat = 对话，outputs = 产出列表；由 SideBar 持有（与笔记分区的三页签同构）。 */
  tab: 'chat' | 'outputs'
  /** 分区过滤词（已小写）；只作用于产出页签，对话页签不渲染过滤框。 */
  filter: string
}>()
const emit = defineEmits<{
  (e: 'open', path: string): void
  (e: 'quote'): void
  (e: 'insert', markdown: string): void
  (e: 'open-settings'): void
}>()

const ai = useAiStore()
const aiCfg = useAiSettingsStore()
const vault = useVaultStore()
const sync = useSyncStore()

// 面板一挂载就把两份配置读进内存（都带重入守卫；App 启动也读过，这里只是兜底）。
onMounted(() => {
  void aiCfg.load()
  void ai.load()
})

/** 输入草稿；Enter 发送、Shift+Enter 换行。 */
const draft = ref('')
/** 历史下拉是否展开（相对会话栏的浮层，关面板自然消失，不持久）。 */
const showHistory = ref(false)
/** 正在「存为笔记」的会话 id；防连点重复建文件。 */
const savingId = ref<string | null>(null)
/** 消息日志的滚动容器；自动跟随只在用户贴着底部时生效。 */
const logEl = ref<HTMLElement | null>(null)

/** 当前会话的消息列表；新对话态是空数组。 */
const messages = computed(() => ai.currentSession?.messages ?? [])

/**
 * 产出列表：`ai/` 目录下未删除的笔记，按修改时间倒序，按过滤词滤标题与路径。
 * 判定只认 `isAiPath` —— 与文件树角标、frontmatter 无关：路径是「在哪」，标记是「是什么」。
 */
const outputs = computed(() => {
  const q = props.filter
  return vault.notes
    .filter((n) => !n.removedLocal && isAiPath(n.path))
    .filter((n) => q === '' || titleOf(n.path).toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
    .sort((a, b) => b.mtime - a.mtime)
})

/** 日志尾部内容；流式期间每个 delta 都变，用它触发「跟随到底部」。 */
const tail = computed(() => messages.value[messages.value.length - 1]?.content ?? '')

// 切页签/切会话：直接跳到底部（打开一段对话就该看到最近的来回）。
watch([() => props.tab, () => ai.currentId], async () => {
  if (props.tab !== 'chat') return
  await nextTick()
  const el = logEl.value
  if (el) el.scrollTop = el.scrollHeight
})

// 流式追加：仅当用户本来就贴着底部才跟随——翻历史时不能被新生成的内容拽走。
watch([tail, () => messages.value.length], async () => {
  await nextTick()
  const el = logEl.value
  if (!el) return
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
})

/** 发送草稿。输入法组合中不触发（Enter 选词不该发出去，判定在 onKeydown）。 */
function sendDraft(): void {
  const text = draft.value
  if (text.trim() === '') return
  draft.value = ''
  void ai.send(text)
}

function onKeydown(event: KeyboardEvent): void {
  // isComposing：中文输入法按 Enter 是选词，不是换行也不是发送。
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  sendDraft()
}

/** 整篇处理的快捷动作：可见文案进历史，笔记正文只进当次 prompt（历史保持轻，见 store 注释）。 */
function runNoteAction(action: AiAction): void {
  const q = ai.quote
  if (!q) return
  const title = titleOf(q.path)
  void ai.send(`【${action.label}】《${title}》`, {
    prompt: buildNotePrompt(action.id, q.body, title),
  })
}

/** 双链建议：模型看不到库，能建议什么全取决于这里喂的标题索引（超量由 prompts 截断）。 */
function runLinkAction(): void {
  const q = ai.quote
  if (!q) return
  const title = titleOf(q.path)
  const titles = vault.notes.filter((n) => !n.removedLocal).map((n) => n.title)
  void ai.send(`【双链建议】《${title}》`, { prompt: buildLinkSuggestPrompt(q.body, titles) })
}

/**
 * 「插入到笔记」：包 `aiQuoteBlock` 引用块后上抛给 App 插进编辑器——
 * 这是对话内容进正文的唯一出口，裸内容（`m.content`）永远不会被 emit 出去。
 */
function insertMessage(m: AiMessage): void {
  const model = m.model ?? aiCfg.settings.model
  emit('insert', aiQuoteBlock(m.content, model === '' ? 'AI' : model))
}

async function copyMessage(m: AiMessage): Promise<void> {
  try {
    await navigator.clipboard.writeText(m.content)
    sync.notify('info', '已复制到剪贴板')
  } catch {
    sync.notify('error', '复制失败:浏览器拒绝了剪贴板访问')
  }
}

/** 当前会话沉淀成笔记；成功后直接打开，让用户第一眼看到 frontmatter 标记与声明行。 */
async function saveSession(): Promise<void> {
  const id = ai.currentId
  if (!id || savingId.value !== null) return
  savingId.value = id
  try {
    const path = await ai.saveAsNote(id)
    sync.notify('info', `已存为笔记:${path}`)
    emit('open', path)
  } catch (err) {
    sync.notify('error', `存为笔记失败:${err instanceof Error ? err.message : String(err)}`)
  } finally {
    savingId.value = null
  }
}
</script>

<template>
  <div class="ai">
    <!-- ===== 产出页签：ai/ 目录的笔记列表 ===== -->
    <div v-if="tab === 'outputs'" class="ai__outputs">
      <p v-if="outputs.length === 0" class="hint">
        {{
          filter === ''
            ? AI_COPY.noOutputs
            : `没有匹配「${filter}」的 AI 产出。`
        }}
      </p>
      <ul v-else class="list">
        <li v-for="n in outputs" :key="n.path">
          <button class="list__row" @click="emit('open', n.path)">
            <!-- 🤖 角标:与文件树的 AI 角标同一语义,一眼认出这行是 AI 产出 -->
            <span class="ai__badge" aria-label="AI 生成">🤖</span>
            <span class="list__name">{{ titleOf(n.path) }}</span>
            <span v-if="dirOf(n.path) !== 'ai'" class="list__meta">{{ dirOf(n.path) }}</span>
          </button>
        </li>
      </ul>
    </div>

    <!-- ===== 对话页签 ===== -->
    <template v-else>
      <!-- 会话栏:历史下拉 / 新对话 / 当前标题 / 存为笔记 -->
      <div class="ai__bar">
        <button
          class="ai__bar-btn"
          type="button"
          :aria-expanded="showHistory"
          @click="showHistory = !showHistory"
        >
          历史
        </button>
        <button class="ai__bar-btn" type="button" @click="ai.newChat(); showHistory = false">
          新对话
        </button>
        <span class="ai__bar-title" :title="ai.currentSession?.title">
          {{ ai.currentSession?.title ?? '新对话' }}
        </span>
        <button
          v-if="ai.currentSession"
          class="ai__bar-btn"
          type="button"
          :disabled="savingId !== null || ai.currentSession.messages.length === 0"
          @click="saveSession"
        >
          {{ savingId === ai.currentId ? '保存中…' : '存为笔记' }}
        </button>

        <!-- 历史下拉:会话列表 + 删除;存本机的草稿,直接删不设二次确认(与笔记删除不同) -->
        <div v-if="showHistory" class="ai__history" @mouseleave="showHistory = false">
          <p v-if="ai.sessions.length === 0" class="hint">{{ AI_COPY.noChats }}</p>
          <ul v-else class="ai__hlist">
            <li v-for="s in ai.sessions" :key="s.id">
              <button
                class="ai__hrow"
                :class="{ 'ai__hrow--on': ai.currentId === s.id }"
                type="button"
                @click="ai.openSession(s.id); showHistory = false"
              >
                <span class="ai__htitle">{{ s.title }}</span>
                <em class="ai__hmeta">{{ s.messages.length }}</em>
              </button>
              <button
                class="ai__hx"
                type="button"
                aria-label="删除该对话"
                @click="ai.deleteSession(s.id)"
              >
                ×
              </button>
            </li>
          </ul>
        </div>
      </div>

      <!-- 消息日志 -->
      <div ref="logEl" class="ai__log">
        <p v-if="messages.length === 0 && !aiCfg.configured" class="hint">
          {{ AI_COPY.unconfigured }}
          <button class="ai__link" type="button" @click="emit('open-settings')">去设置 →</button>
        </p>
        <p v-else-if="messages.length === 0" class="hint">
          {{ AI_COPY.empty }}<br />
          点下方「引用当前笔记」可把正文带进上下文;回复可用「插入到笔记」落成带 🤖 标记的引用块。
        </p>
        <template v-else>
          <div
            v-for="(m, i) in messages"
            :key="i"
            class="ai__msg"
            :class="m.role === 'user' ? 'ai__msg--user' : 'ai__msg--ai'"
          >
            <div class="ai__bubble">
              <p class="ai__who">
                {{ m.role === 'user' ? '你' : (m.model || 'AI') }}
                <span v-if="m.quote" class="ai__who-quote">引用了《{{ titleOf(m.quote) }}》</span>
              </p>
              <div class="ai__text">{{ m.content }}<span v-if="ai.streaming && i === messages.length - 1 && m.role === 'assistant'" class="ai__cursor">▍</span></div>
              <div v-if="m.role === 'assistant' && m.content !== ''" class="ai__ops">
                <button type="button" @click="insertMessage(m)">插入到笔记</button>
                <button type="button" @click="copyMessage(m)">复制</button>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- 错误行:内联展示,不上全局通知刷屏;可手动收起 -->
      <p v-if="ai.error" class="ai__err">
        <span>{{ ai.error }}</span>
        <button type="button" aria-label="收起错误" @click="ai.error = null">×</button>
      </p>

      <!-- 输入区:引用芯片 / 快捷动作 / 输入框 -->
      <div class="ai__foot">
        <div class="ai__chips">
          <button
            v-if="!ai.quote"
            class="ai__chip ai__chip--ghost"
            type="button"
            :disabled="!vault.activePath"
            :title="!vault.activePath ? '先打开一篇笔记' : '把当前笔记的正文带进本次对话的上下文'"
            @click="emit('quote')"
          >
            📄 引用当前笔记
          </button>
          <span v-else class="ai__chip">
            <span class="ai__chip-name">📄 {{ titleOf(ai.quote.path) }}</span>
            <em class="ai__chip-meta">{{ ai.quote.body.length }} 字{{ ai.quote.clipped ? '·已截断' : '' }}</em>
            <button class="ai__chip-x" type="button" aria-label="摘掉引用" @click="ai.clearQuote()">
              ×
            </button>
          </span>
        </div>

        <!-- 整篇处理的快捷动作:引用在场才出现 -->
        <div v-if="ai.quote" class="ai__quick">
          <button
            v-for="a in NOTE_ACTIONS"
            :key="a.id"
            class="ai__quick-btn"
            type="button"
            :title="a.hint"
            :disabled="ai.streaming"
            @click="runNoteAction(a)"
          >
            {{ a.label }}
          </button>
          <button
            class="ai__quick-btn"
            type="button"
            title="建议可以补进这篇笔记的 [[双链]]"
            :disabled="ai.streaming"
            @click="runLinkAction"
          >
            双链建议
          </button>
        </div>

        <div class="ai__input">
          <textarea
            v-model="draft"
            class="ai__ta"
            rows="2"
            :placeholder="aiCfg.configured ? '问点什么,Enter 发送,Shift+Enter 换行' : '先在设置 → AI 里配置接口与模型'"
            spellcheck="false"
            @keydown="onKeydown"
          ></textarea>
          <!-- 发送/停止共用一个按钮:在飞时点它是「停止」,永远可点 -->
          <button
            v-if="ai.streaming"
            class="ai__send ai__send--stop"
            type="button"
            @click="ai.stop()"
          >
            停止
          </button>
          <button
            v-else
            class="ai__send"
            type="button"
            :disabled="draft.trim() === ''"
            @click="sendDraft()"
          >
            发送
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 面板自身是一根两段式竖条:上半日志(滚动)、下半输入(固定)。
   由 SideBar 的 .sidebar__scroll--ai 提供伸展容器,这里撑满它。 */
.ai {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  height: 100%;
}

/* —— 会话栏 —— */
.ai__bar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.ai__bar-btn {
  flex: none;
  padding: 3px 7px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-muted);
  transition: background-color 0.12s ease, color 0.12s ease;
}

.ai__bar-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}

.ai__bar-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.ai__bar-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 600;
  text-align: center;
}

/* 历史下拉:压在日志上方的浮层,离开即收(点行/点别处都会先关) */
.ai__history {
  position: absolute;
  top: 100%;
  left: 6px;
  right: 6px;
  z-index: 6;
  max-height: 260px;
  overflow: auto;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-elevated);
  box-shadow: 0 10px 26px var(--shadow-color);
}

.ai__hlist {
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai__hlist li {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ai__hrow {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border-radius: 6px;
  font-size: 12.5px;
  text-align: left;
  transition: background-color 0.12s ease;
}

.ai__hrow:hover {
  background: var(--bg-hover);
}

.ai__hrow--on {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.ai__htitle {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai__hmeta {
  flex: none;
  font-size: 10.5px;
  font-style: normal;
  opacity: 0.7;
}

.ai__hx {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  font-size: 13px;
  line-height: 1;
  color: var(--text-muted);
}

.ai__hx:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* —— 消息日志 —— */
.ai__log {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
}

.ai__msg {
  display: flex;
}

.ai__msg--user {
  justify-content: flex-end;
}

.ai__msg--ai {
  justify-content: flex-start;
}

.ai__bubble {
  max-width: 92%;
  padding: 6px 9px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.6;
}

.ai__msg--user .ai__bubble {
  background: var(--accent-soft);
  color: var(--accent-text);
  border-bottom-right-radius: 3px;
}

.ai__msg--ai .ai__bubble {
  background: var(--bg);
  border: 1px solid var(--border);
  border-bottom-left-radius: 3px;
}

.ai__who {
  margin: 0 0 2px;
  font-size: 10.5px;
  color: var(--text-muted);
}

/* 引用过的提问在气泡头上标来源:分隔开的两段内容,回看时知道那次带了哪篇笔记 */
.ai__who-quote {
  margin-left: 6px;
  opacity: 0.8;
}

.ai__text {
  white-space: pre-wrap;
  word-break: break-word;
}

.ai__cursor {
  color: var(--accent);
  animation: ai-blink 1s steps(2) infinite;
}

@keyframes ai-blink {
  50% {
    opacity: 0;
  }
}

.ai__ops {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}

.ai__ops button {
  padding: 1px 6px;
  border-radius: 5px;
  font-size: 11px;
  color: var(--text-muted);
  transition: background-color 0.12s ease, color 0.12s ease;
}

.ai__ops button:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* —— 错误行 —— */
.ai__err {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 5px 8px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  line-height: 1.6;
  color: var(--danger);
}

.ai__err span {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

.ai__err button {
  flex: none;
  color: inherit;
  font-size: 13px;
  line-height: 1;
}

/* —— 输入区 —— */
.ai__foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 8px 8px;
  border-top: 1px solid var(--border);
}

.ai__chips {
  display: flex;
  gap: 6px;
  min-height: 0;
}

.ai__chips:empty {
  display: none;
}

.ai__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--text-muted);
  background: var(--bg);
}

.ai__chip--ghost {
  cursor: pointer;
  border-style: dashed;
}

.ai__chip--ghost:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--accent);
}

.ai__chip--ghost:disabled {
  opacity: 0.5;
  cursor: default;
}

.ai__chip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai__chip-meta {
  flex: none;
  font-style: normal;
  font-size: 10.5px;
  opacity: 0.8;
}

.ai__chip-x,
.ai__chip button {
  flex: none;
  font-size: 13px;
  line-height: 1;
  color: inherit;
}

/* 整篇处理的快捷动作:引用在场才渲染 */
.ai__quick {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.ai__quick-btn {
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--text-muted);
  transition: background-color 0.12s ease, color 0.12s ease;
}

.ai__quick-btn:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent-text);
  border-color: transparent;
}

.ai__quick-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.ai__input {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}

.ai__ta {
  flex: 1;
  min-width: 0;
  resize: none;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
}

.ai__ta:focus {
  outline: none;
  border-color: var(--accent);
}

.ai__send {
  flex: none;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  background: var(--accent-soft);
  color: var(--accent-text);
  transition: opacity 0.12s ease;
}

.ai__send:hover:not(:disabled) {
  opacity: 0.85;
}

.ai__send:disabled {
  opacity: 0.45;
  cursor: default;
}

/* 停止按钮用中性底:同一个位置、相反的语义,颜色不能沿用「发送」的 accent 邀请感 */
.ai__send--stop {
  background: var(--bg-hover);
  color: var(--text);
}

/* —— 产出页签 —— */
.ai__outputs {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
}

.ai__badge {
  flex: none;
  font-size: 11px;
  line-height: 1;
}

/* 与 SideBar 同款的行与空态样式(组件各自 scoped,复制而非共享——本项目的既有做法) */
.hint {
  margin: 6px 4px 12px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-muted);
}

.ai__link {
  margin-left: 4px;
  color: var(--accent);
  font-size: 12.5px;
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.list__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 13.5px;
  text-align: left;
  transition: background-color 0.12s ease;
}

.list__row:hover {
  background: var(--bg-hover);
}

.list__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list__meta {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-muted);
}
</style>
