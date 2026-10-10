<script setup lang="ts">
/**
 * 日历面板：侧栏第 4 分区（日历）的月视图，日记即日期。
 *
 * 分隔纪律在这块 UI 上的落点：
 * - 路径即索引：哪天有日记只看 `日记/YYYY-MM-DD.md` 是否存在（`vault.dailyDates`，由
 *   core/daily.ts 从路径算出），不引入 frontmatter 字段、Dexie 列或日期库——
 *   新建/删除/改名之后徽标与打点自动跟上，没有第二份要对账的状态；
 * - 点空白日期 = 用 `createNote` 落一篇空日记（幂等：已有同名文件原样返回，不会覆盖），
 *   点已有日期直接打开——两条路殊途同归到同一条 emit('open')，与文件树的行同一出口；
 * - 键盘遵循侧栏既有标准：真 <button> + aria-label + roving tabindex，
 *   方向键 ±1/±7 漫游，目标格不在当前矩阵里就翻到它所在的月份再聚焦。
 *
 * 本组件够不着的只有一件事：打开笔记。全部上抛给 SideBar 转发给 App。
 */
import { computed, nextTick, ref } from 'vue'
import { addDays, dailyPathOf, monthMatrix, todayStr, weekdayOf, WEEKDAY_NAMES, type DayCell } from '@/core/daily.ts'
import { useSyncStore } from '@/stores/sync.ts'
import { useVaultStore } from '@/stores/vault.ts'

const emit = defineEmits<{
  (e: 'open', path: string): void
}>()

const vault = useVaultStore()
const sync = useSyncStore()

/** 面板一挂载取一次「今天」：格子环与 aria-current 都以它为准（挂载即重置，见切分区的 v-if）。 */
const today = todayStr()

const viewYear = ref(Number(today.slice(0, 4)))
const viewMonth = ref(Number(today.slice(5, 7)))
/** roving tabindex 的落点：Tab 进网格时焦点所在的日期（YYYY-MM-DD）。 */
const focusDate = ref(today)
/** 焦点要落进新渲染的格子，必须等 DOM 更新；query 用 data-date，避开下标随矩阵变化。 */
const gridEl = ref<HTMLElement | null>(null)

/** 当前视图的月矩阵（周一开头，4–6 行 × 7 格，含相邻月的灰显格）。 */
const weeks = computed(() => monthMatrix(viewYear.value, viewMonth.value))

/** 扁平格子，供「焦点日期是否在本矩阵里」的判定。 */
const dates = computed(() => weeks.value.flat().map((c) => c.date))

const monthTitle = computed(() => `${viewYear.value} 年 ${viewMonth.value} 月`)

/** 视图翻页后保证 roving tabindex 有落点：焦点还看得见就不动，否则退回该月今天/1 号。 */
function ensureFocusable(): void {
  if (dates.value.includes(focusDate.value)) return
  focusDate.value = dates.value.includes(today) ? today : (weeks.value.flat().find((c) => c.inMonth)?.date ?? today)
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

/** 方向键 → 天数位移：左右 ±1、上下 ±7（正好一行）。Enter/Space 走按钮原生 click，不接管。 */
const KEY_DELTA: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }

function onCellKey(event: KeyboardEvent, date: string): void {
  const delta = KEY_DELTA[event.key]
  if (delta === undefined) return
  event.preventDefault()
  void focusOn(addDays(date, delta))
}

/** 格子的读屏文案：完整日期 + 星期 + 状态，打点是视觉提示、不进文案（aria-hidden）。 */
function labelOf(cell: DayCell): string {
  const base = `${cell.date.slice(0, 4)} 年 ${Number(cell.date.slice(5, 7))} 月 ${cell.day} 日 星期${WEEKDAY_NAMES[weekdayOf(cell.date)]}`
  const state = cell.date === today ? '，今天' : ''
  return `${base}${state}${vault.dailyDates.has(cell.date) ? '，已有日记' : '，还没有日记'}`
}

/**
 * 点一格：已有日记直接打开，没有就先建空文件再打开。
 * `createNote` 幂等（占用即原样返回），失败必须有回音——照 openUnresolved 走全局通知。
 */
async function pick(date: string): Promise<void> {
  focusDate.value = date
  const path = dailyPathOf(date)
  try {
    emit('open', vault.dailyDates.has(date) ? path : await vault.createNote(path))
  } catch (err) {
    sync.notify('error', `无法创建当天日记:${err instanceof Error ? err.message : String(err)}`)
  }
}
</script>

<template>
  <div class="cal">
    <!-- 月头：‹ 上月 / 年月 / 下月 › + 今天。年月 aria-live 让翻页对读屏有回音 -->
    <div class="cal__bar">
      <button class="cal__nav" type="button" aria-label="上个月" @click="shift(-1)">
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
      <span class="cal__title" aria-live="polite">{{ monthTitle }}</span>
      <button class="cal__nav" type="button" aria-label="下个月" @click="shift(1)">
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
      <button class="cal__today" type="button" @click="goToday">今天</button>
    </div>

    <table ref="gridEl" class="cal__grid" :aria-label="`${monthTitle}日历`">
      <thead>
        <tr>
          <th v-for="w in WEEKDAY_NAMES" :key="w" scope="col">{{ w }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, ri) in weeks" :key="ri">
          <td v-for="cell in row" :key="cell.date">
            <button
              class="cal__cell"
              :class="{
                'cal__cell--out': !cell.inMonth,
                'cal__cell--today': cell.date === today,
                'cal__cell--open': vault.activePath === dailyPathOf(cell.date),
              }"
              type="button"
              :data-date="cell.date"
              :tabindex="cell.date === focusDate ? 0 : -1"
              :aria-label="labelOf(cell)"
              :aria-current="cell.date === today ? 'date' : undefined"
              @click="pick(cell.date)"
              @keydown="onCellKey($event, cell.date)"
            >
              <span class="cal__n">{{ cell.day }}</span>
              <!-- 打点：本格已有日记。空格也渲染但透明，行高不因有无日记错位 -->
              <span class="cal__dot" :class="{ 'cal__dot--on': vault.dailyDates.has(cell.date) }"></span>
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-if="vault.dailyDates.size === 0" class="cal__hint">
      还没有日记。点任意一天,就会创建 <code>日记/2026-01-01.md</code> 这样的文件并打开;
      再点一次就是打开它。方向键可在日期间漫游。
    </p>
  </div>
</template>

<style scoped>
/* 面板落在 .sidebar__scroll 的 8px 内边距里，这里只排自己的两段：月头 + 网格。
   颜色全部走 CSS 变量（verify-theme 禁止写死色值）。 */
.cal {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* —— 月头 —— */
.cal__bar {
  display: flex;
  align-items: center;
  gap: 4px;
}

.cal__nav {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--text-muted);
  transition: background-color 0.12s ease, color 0.12s ease;
}

.cal__nav:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.cal__title {
  flex: 1;
  min-width: 0;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
}

.cal__today {
  flex: none;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--text-muted);
  transition: background-color 0.12s ease, color 0.12s ease;
}

.cal__today:hover {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent-text);
}

/* —— 网格 —— */
.cal__grid {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.cal__grid th {
  padding-bottom: 4px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  text-align: center;
}

.cal__grid td {
  padding: 1px;
}

.cal__cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 100%;
  height: 30px;
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--text);
  transition: background-color 0.12s ease, color 0.12s ease;
}

.cal__cell:hover {
  background: var(--bg-hover);
}

/* 相邻月的格子：留着可点可聚焦（方向键会经过），只是压暗标示「不在这一个月」 */
.cal__cell--out {
  color: var(--text-muted);
}

/* 今天：内嵌描边环，不动边框盒，行高与邻格完全一致 */
.cal__cell--today {
  box-shadow: inset 0 0 0 1.5px var(--accent);
  font-weight: 600;
}

/* 当前打开的那篇日记：与列表行的 active 同一语义（accent-soft 底 + accent 字） */
.cal__cell--open {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.cal__cell:focus {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.cal__n {
  line-height: 1;
}

.cal__dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: transparent;
}

.cal__dot--on {
  background: var(--accent);
}

/* 空态提示：组件各自 scoped，样式按 AiPanel 的先例在本组件内自建，不借 SideBar 的 .hint */
.cal__hint {
  margin: 6px 4px 12px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-muted);
}

.cal__hint code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}
</style>
