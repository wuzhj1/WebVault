<script setup lang="ts">
/**
 * 日历视图：占据主区（宽屏下连右栏一起，`app__right` 被 v-if 移除后 main 的 flex:1 自然吃满）。
 *
 * 分隔纪律在这块 UI 上的落点：
 * - **一天一个目录**：`日记/YYYY-MM-DD/标题.md`，格子里直接列出该日各篇的标题（core/daily.ts
 *   从路径算出日期分组，store 的 dailyByDate 是唯一真相）——不引入 frontmatter 字段、Dexie 列
 *   或日期库，删除/改名都跟着走；
 * - 交互分工是刻意的：点**标题**打开那一篇，点**格子空白/日期号**就地输入标题新建一篇
 *   （多篇日记的意义就在标题，先建空文件再改名会攒出一堆「未命名」）；
 * - 本组件够不着的只有两件事，全部上抛：打开笔记（App 走 openNote，顺带退出日历）、
 *   退出视图（Esc 或「返回笔记」）。
 *
 * 键盘延续侧栏既有标准：真 <button> + aria-label + roving tabindex（±1/±7 漫游，跨月自动翻页）。
 * 日期号按钮铺满整格做底层，标题按钮叠在上层——button 不能嵌套，两层并列是唯一解。
 */
import { computed, nextTick, ref } from 'vue'
import {
  addDays,
  dailyDirOf,
  dailyPathOf,
  monthMatrix,
  todayStr,
  weekdayOf,
  WEEKDAY_NAMES,
  type DayCell,
} from '@/core/daily.ts'
import { sanitizeTitle, titleOf } from '@/core/vault/paths.ts'
import { useSyncStore } from '@/stores/sync.ts'
import { useVaultStore } from '@/stores/vault.ts'

const emit = defineEmits<{
  /** 打开某篇笔记；App 收到后切回编辑器（openNote 里顺带退出日历模式）。 */
  (e: 'open', path: string): void
  /** 退出日历视图，回到编辑器（Esc 与「返回笔记」按钮共用）。 */
  (e: 'exit'): void
}>()

const vault = useVaultStore()
const sync = useSyncStore()

/** 面板一挂载取一次「今天」：格子环与 aria-current 都以它为准。 */
const today = todayStr()

const viewYear = ref(Number(today.slice(0, 4)))
const viewMonth = ref(Number(today.slice(5, 7)))
/** roving tabindex 的落点：Tab 进网格时焦点所在的日期（YYYY-MM-DD）。 */
const focusDate = ref(today)
/** 焦点要落进新渲染的格子，必须等 DOM 更新；query 用 data-date，避开下标随矩阵变化。 */
const gridEl = ref<HTMLElement | null>(null)
/** 正在就地输入标题的那格（日期）；null = 没有在输入。 */
const composing = ref<string | null>(null)
/** 就地输入框的内容；未 trim 前不参与任何判定。 */
const draft = ref('')

/** 一格最多直出几行标题；超出折叠成 +N，免得某天写了十篇就把整行格子撑变形。 */
const MAX_TITLES = 3

/** 当前视图的月矩阵（周一开头，4–6 行 × 7 格，含相邻月的灰显格）。 */
const weeks = computed(() => monthMatrix(viewYear.value, viewMonth.value))

/** 扁平格子，供「焦点日期是否在本矩阵里」的判定。 */
const dates = computed(() => weeks.value.flat().map((c) => c.date))

const monthTitle = computed(() => `${viewYear.value} 年 ${viewMonth.value} 月`)

/** 该日的日记路径列表（已按标题排序，见 vault.dailyByDate）。 */
function titlesOf(date: string): string[] {
  return vault.dailyByDate.get(date) ?? []
}

/** 视图翻页后保证 roving tabindex 有落点：焦点还看得见就不动，否则退回该月今天/1 号。 */
function ensureFocusable(): void {
  if (dates.value.includes(focusDate.value)) return
  focusDate.value = dates.value.includes(today)
    ? today
    : (weeks.value.flat().find((c) => c.inMonth)?.date ?? today)
}

/** 翻月（delta = ±1）。焦点不在新矩阵里时由 ensureFocusable 收口，Tab 永远有格子可进。 */
function shift(delta: number): void {
  const total = viewYear.value * 12 + (viewMonth.value - 1) + delta
  viewYear.value = Math.floor(total / 12)
  viewMonth.value = (total % 12) + 1
  ensureFocusable()
}

/** 回到今天所在月，并把焦点交给今天那格——之后方向键从今天继续漫游。 */
async function goToday(): Promise<void> {
  viewYear.value = Number(today.slice(0, 4))
  viewMonth.value = Number(today.slice(5, 7))
  await focusOn(today)
}

/** 焦点移到指定日期；目标格不在当前矩阵里就先翻到它的月份，等渲染完再真正聚焦。 */
async function focusOn(date: string): Promise<void> {
  focusDate.value = date
  if (!dates.value.includes(date)) {
    viewYear.value = Number(date.slice(0, 4))
    viewMonth.value = Number(date.slice(5, 7))
  }
  await nextTick()
  gridEl.value?.querySelector<HTMLElement>(`[data-date="${date}"]`)?.focus()
}

/** 方向键漫游：左右 ±1 天、上下 ±7 天（正好一行）。Enter/Space 走按钮原生 click，不接管。 */
const KEY_DELTA: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }

function onCellKey(event: KeyboardEvent, date: string): void {
  const delta = KEY_DELTA[event.key]
  if (delta === undefined) return
  event.preventDefault()
  void focusOn(addDays(date, delta))
}

/** 格子的读屏文案：完整日期 + 星期 + 该日篇数，标题是列表不是摘要，不塞进 aria-label。 */
function labelOf(cell: DayCell): string {
  const base = `${cell.date.slice(0, 4)} 年 ${Number(cell.date.slice(5, 7))} 月 ${cell.day} 日 星期${WEEKDAY_NAMES[weekdayOf(cell.date)]}`
  const n = titlesOf(cell.date).length
  const state = cell.date === today ? '，今天' : ''
  return `${base}${state}${n === 0 ? '，还没有日记' : `，${n} 篇日记`}`
}

/** 点格子空白/日期号：进入就地输入。已有输入中的格子先收掉，避免两格同时有输入框。 */
async function startCompose(date: string): Promise<void> {
  composing.value = date
  draft.value = ''
  await nextTick()
  // 不能用模板 ref：本组件的 <input> 嵌在两层 v-for（tr × td）里，Vue 会把 ref 绑成数组，
  // `composeInput.value.focus()` 直接抛「is not a function」。与 focusOn 同一套路，查 DOM 更省事。
  gridEl.value?.querySelector<HTMLInputElement>('.calview__input')?.focus()
}

/** 取消就地输入（Esc 与失焦共用）。 */
function cancelCompose(): void {
  composing.value = null
  draft.value = ''
}

/**
 * 提交就地输入：洗标题 → 建空文件 → 上抛打开。
 * 洗完为空（比如输入的全是 `/` 和空格）就留在输入态并提示，不建一个空文件名出来；
 * 写失败同样不收起输入框，用户改完还能重试。
 */
async function submitCompose(date: string): Promise<void> {
  const title = sanitizeTitle(draft.value)
  if (title === '') {
    sync.notify('warn', '标题不能为空。')
    return
  }
  try {
    const path = await vault.createNote(dailyPathOf(date, title))
    cancelCompose()
    emit('open', path)
  } catch (err) {
    sync.notify('error', `无法创建日记: ${err instanceof Error ? err.message : String(err)}`)
  }
}
</script>

<template>
  <section class="calview" aria-label="日记日历">
    <!-- 表头：‹ 年月 › + 今天 + 返回。年月 aria-live 让翻页对读屏有回音 -->
    <header class="calview__bar">
      <button class="calview__nav" type="button" aria-label="上个月" @click="shift(-1)">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M10 3.5L5.5 8l4.5 4.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <h2 class="calview__title" aria-live="polite">{{ monthTitle }}</h2>
      <button class="calview__nav" type="button" aria-label="下个月" @click="shift(1)">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M6 3.5L10.5 8 6 12.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button class="calview__today" type="button" @click="goToday">今天</button>
      <button class="calview__exit" type="button" @click="emit('exit')">返回笔记</button>
    </header>

    <div ref="gridEl" class="calview__scroll">
      <table class="calview__grid" :aria-label="`${monthTitle}日记`">
        <thead>
          <tr>
            <th v-for="w in WEEKDAY_NAMES" :key="w" scope="col">{{ w }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, ri) in weeks" :key="ri">
            <td
              v-for="cell in row"
              :key="cell.date"
              class="calview__td"
              :class="{ 'calview__td--out': !cell.inMonth, 'calview__td--today': cell.date === today }"
            >
              <!-- 日期号按钮铺满整格做底层：点空白处就是「在这天新建」，与点日期号同一件事 -->
              <button
                class="calview__day"
                type="button"
                :data-date="cell.date"
                :tabindex="cell.date === focusDate ? 0 : -1"
                :aria-label="labelOf(cell)"
                :aria-current="cell.date === today ? 'date' : undefined"
                @click="startCompose(cell.date)"
                @keydown="onCellKey($event, cell.date)"
              >
                <span class="calview__n">{{ cell.day }}</span>
              </button>

              <!-- 标题列表叠在日期号之上；button 不能嵌套，两层并列 + z-index 是唯一解 -->
              <ul v-if="titlesOf(cell.date).length > 0" class="calview__list">
                <li v-for="p in titlesOf(cell.date).slice(0, MAX_TITLES)" :key="p">
                  <button
                    class="calview__item"
                    :class="{ 'calview__item--on': vault.activePath === p }"
                    type="button"
                    :title="titleOf(p)"
                    @click="emit('open', p)"
                  >
                    {{ titleOf(p) }}
                  </button>
                </li>
              </ul>
              <span v-if="titlesOf(cell.date).length > MAX_TITLES" class="calview__more">
                +{{ titlesOf(cell.date).length - MAX_TITLES }}
              </span>

              <!-- 就地输入：由 startCompose 查 DOM 聚焦，不挂模板 ref（嵌在两层 v-for 里） -->
              <input
                v-if="composing === cell.date"
                v-model="draft"
                class="calview__input"
                type="text"
                placeholder="标题"
                aria-label="新日记标题"
                @keydown.enter.prevent="submitCompose(cell.date)"
                @keydown.esc.stop="cancelCompose"
                @blur="cancelCompose"
              />
            </td>
          </tr>
        </tbody>
      </table>

      <p v-if="vault.dailyByDate.size === 0" class="calview__hint">
        还没有日记。点任意一天的空白处,就地输入标题回车,会创建
        <code>{{ dailyDirOf('2026-01-01') }}/标题.md</code> 这样的文件并打开;
        一天可以写很多篇。方向键在日期间漫游,Enter 新建,Esc 返回编辑器。
      </p>
    </div>
  </section>
</template>

<style scoped>
/* 宽屏下本组件吃满 main（app__right 被 v-if 移除后 flex:1 自然扩张），窄屏就是 main 全宽。
   颜色全部走 CSS 变量（verify-theme 禁止写死色值）。 */
.calview {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 10px 14px 18px;
}

/* —— 表头 —— */
.calview__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding-bottom: 10px;
}

.calview__nav {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: var(--text-muted);
  transition: background-color 0.12s ease, color 0.12s ease;
}

.calview__nav:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.calview__title {
  flex: none;
  min-width: 96px;
  margin: 0;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
}

.calview__today,
.calview__exit {
  flex: none;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-muted);
  transition: background-color 0.12s ease, color 0.12s ease;
}

.calview__today:hover,
.calview__exit:hover {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent-text);
}

/* 「返回」比「今天」低一档视觉权重：它是退路，不是常用动作 */
.calview__exit {
  margin-left: auto;
}

/* —— 网格 —— */
.calview__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.calview__grid {
  width: 100%;
  border-collapse: separate;
  border-spacing: 3px;
  table-layout: fixed;
}

.calview__grid th {
  padding: 0 0 4px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-muted);
  text-align: left;
}

/* td 是格子本体：日期号与标题列表都绝对/相对叠在里面，格高由内容撑开但有下限 */
.calview__td {
  position: relative;
  height: 104px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  vertical-align: top;
  overflow: hidden;
}

.calview__td--out {
  border-style: dashed;
  opacity: 0.55;
}

/* 今天：内嵌描边环，不动边框盒，格子尺寸与邻格完全一致 */
.calview__td--today {
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

/* 日期号按钮：铺满整格做可点底层。flex-start 让号数贴左上，下面留给标题列表 */
.calview__day {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  padding: 4px 0 0 8px;
  border-radius: 7px;
  color: var(--text);
  transition: background-color 0.12s ease;
}

.calview__day:hover {
  background: var(--bg-hover);
}

.calview__day:focus {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.calview__td--out .calview__day {
  color: var(--text-muted);
}

.calview__td--today .calview__n {
  font-weight: 700;
  color: var(--accent);
}

.calview__n {
  line-height: 1;
  font-size: 13px;
}

/* 标题列表：叠在日期号之上（z-index 1），点击命中标题而不是「新建」 */
.calview__list {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 20px 4px 4px;
  list-style: none;
}

.calview__item {
  width: 100%;
  padding: 1px 5px;
  border-radius: 5px;
  font-size: 12px;
  line-height: 1.5;
  text-align: left;
  /* 长标题截断而不是换行：换行会把整行格子撑高，月历的行距就跳了 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  transition: background-color 0.12s ease, color 0.12s ease;
}

.calview__item:hover {
  background: var(--bg-hover);
}

/* 当前打开的那篇日记：与列表行的 active 同一语义（accent-soft 底 + accent 字） */
.calview__item--on {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.calview__more {
  position: relative;
  z-index: 1;
  display: block;
  padding: 0 9px;
  font-size: 11px;
  color: var(--text-muted);
}

/* 就地输入：盖住格子下半部，直接接在标题列表后面 */
.calview__input {
  position: absolute;
  left: 4px;
  right: 4px;
  bottom: 4px;
  z-index: 2;
  width: calc(100% - 8px);
  padding: 2px 5px;
  border: 1px solid var(--accent);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
  outline: none;
}

.calview__input::placeholder {
  color: var(--text-muted);
}

/* 空态提示：组件各自 scoped，样式在本组件内自建，不借别人的 .hint */
.calview__hint {
  margin: 14px 4px;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--text-muted);
}

.calview__hint code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}
</style>
