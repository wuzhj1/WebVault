<script setup lang="ts">
/**
 * 侧栏日历分区：**上面月历、下面那一天的日记列表**。
 *
 * 为什么只是侧栏的一个分区而不是全窗视图：日历是「跳到某天翻日记」的工具，不是阅读形态——
 * 拿整个窗口换一张月历，编辑器、文件树、反链一起让位，写日记反而得先退出来。现在它是与
 * 笔记 / 待建 / 标签同级的一个分区，读与写都在同一屏里。
 *
 * 分隔纪律在这块 UI 上的落点：
 * - **一天一个目录**：`日记/YYYY-MM-DD/标题.md`，列表直接列出该日各篇（core/daily.ts 从路径
 *   算出日期分组，store 的 dailyByDate 是唯一真相）——不引入 frontmatter 字段、Dexie 列
 *   或日期库，删除/改名都跟着走；
 * - **格子只负责选日期，篇目一律放在下方列表**：侧栏 300px 切 7 列每列只有 42px，格子里
 *   放不下标题；集中到列表后，某天写了十篇也只是列表自己滚，格子始终是 30px 高，整月的
 *   行距纹丝不动；
 * - 新建走列表头部的内联输入（先输标题再建文件，不攒「未命名」），因此**格子的点击只是选中**，
 *   不再兼职就地输入——两件事挤在同一个点击上，用户永远猜不到会新建还是跳转。
 *
 * 键盘延续侧栏既有标准：真 <button> + aria-label + roving tabindex（±1/±7 漫游，跨月自动翻页）。
 * 漫游**顺带选中**那一天：否则方向键移走了、下半截还停在原地，等于要按两次才看到目标日期。
 */
import { computed, nextTick, ref, watch } from 'vue'
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
  /** 打开某篇日记（列表行）。 */
  (e: 'open', path: string): void
}>()

const vault = useVaultStore()
const sync = useSyncStore()

/** 挂载时取一次「今天」：格子环、aria-current 与选中态的初值都以它为准。 */
const today = todayStr()

const viewYear = ref(Number(today.slice(0, 4)))
const viewMonth = ref(Number(today.slice(5, 7)))
/** roving tabindex 的落点：Tab 进网格时焦点所在的日期（YYYY-MM-DD）。 */
const focusDate = ref(today)
/** 当前选中的日期，决定下半截列表显示哪一天。与 focusDate 分开：翻月不该把选中也带走。 */
const selected = ref(today)
/** 焦点要落进新渲染的格子，必须等 DOM 更新；query 用 data-date，避开下标随矩阵变化。 */
const gridEl = ref<HTMLElement | null>(null)
/** 列表头部的内联输入；全局只有一个，模板 ref 直接可用，不必查 DOM。 */
const composeInput = ref<HTMLInputElement | null>(null)
/** 是否正在内联输入新日记的标题。 */
const composing = ref(false)
/** 输入框内容；未 trim 前不参与任何判定。 */
const draft = ref('')

/** 当前视图的月矩阵（周一开头，4–6 行 × 7 格，含相邻月的灰显格）。 */
const weeks = computed(() => monthMatrix(viewYear.value, viewMonth.value))

/** 扁平格子，供「焦点日期是否在本矩阵里」的判定。 */
const dates = computed(() => weeks.value.flat().map((c) => c.date))

/** 当前视图的 `YYYY-MM`，用于判断选中日是否落在**当前月**里（相邻月的灰格在矩阵内、却不属于这个月）。 */
const viewKey = computed(() => `${viewYear.value}-${String(viewMonth.value).padStart(2, '0')}`)

const monthTitle = computed(() => `${viewYear.value} 年 ${viewMonth.value} 月`)

/** 选中日的列表头标题：`10 月 12 日 星期一`，今天再缀一个「今天」。 */
const dayTitle = computed(() => {
  const base = `${Number(selected.value.slice(5, 7))} 月 ${Number(selected.value.slice(8, 10))} 日 星期${WEEKDAY_NAMES[weekdayOf(selected.value)]}`
  return selected.value === today ? `${base}（今天）` : base
})

/** 选中那天的日记路径（已按标题排序，见 vault.dailyByDate）。 */
const dayList = computed(() => vault.dailyByDate.get(selected.value) ?? [])

/** 该日的日记篇数；月历打点与读屏文案共用，不重复取 Map。 */
function titlesOf(date: string): string[] {
  return vault.dailyByDate.get(date) ?? []
}

/**
 * 把视图翻到 date 所在的月份，已在当月则什么都不做。
 *
 * 选中日必须始终落在**当前月**里，而不是「当前矩阵里」：相邻月的灰格本来就在矩阵内，
 * 只判矩阵的话，从 10-31 按 → 落到 11-01 时表头还写着 10 月，下半截却已是 11 月 1 日的列表。
 * `‹ ›` 不走这条路——它们是纯浏览，不打扰选中。
 */
function showMonthOf(date: string): void {
  if (date.slice(0, 7) === viewKey.value) return
  viewYear.value = Number(date.slice(0, 4))
  viewMonth.value = Number(date.slice(5, 7))
}

/** 选中某天：焦点落点与选中一起走，视图同时翻到它所在的月。 */
function select(date: string): void {
  focusDate.value = date
  selected.value = date
  showMonthOf(date)
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

/** 回到今天所在月，焦点与选中都交给今天——之后方向键从今天继续漫游。 */
function goToday(): void {
  void focusOn(today)
}

/**
 * 焦点移到指定日期：select 已顺带把它所在的月份翻过来，等 DOM 渲染完再真正聚焦
 * （Vue 的重渲染是异步的，立刻查 `[data-date]` 拿到的还是旧矩阵）。
 */
async function focusOn(date: string): Promise<void> {
  select(date)
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

/** 格子的读屏文案：完整日期 + 星期 + 该日篇数。 */
function labelOf(cell: DayCell): string {
  const base = `${cell.date.slice(0, 4)} 年 ${Number(cell.date.slice(5, 7))} 月 ${cell.day} 日 星期${WEEKDAY_NAMES[weekdayOf(cell.date)]}`
  const n = titlesOf(cell.date).length
  const state = cell.date === today ? '，今天' : ''
  return `${base}${state}${n === 0 ? '，还没有日记' : `，${n} 篇日记`}`
}

/** 打开内联输入。已在输入时只是把焦点要回来，不重置用户已经敲了一半的标题。 */
async function startCompose(): Promise<void> {
  if (composing.value) {
    composeInput.value?.focus()
    return
  }
  composing.value = true
  draft.value = ''
  await nextTick()
  composeInput.value?.focus()
}

/** 取消内联输入（Esc 与失焦共用）。 */
function cancelCompose(): void {
  composing.value = false
  draft.value = ''
}

/**
 * 提交内联输入：洗标题 → 建空文件 → 上抛打开。
 * 洗完为空（比如输入的全是 `/` 和空格）就留在输入态并提示，不建一个空文件名出来；
 * 写失败同样不收起输入框，用户改完还能重试。
 */
async function submitCompose(): Promise<void> {
  const title = sanitizeTitle(draft.value)
  if (title === '') {
    sync.notify('warn', '标题不能为空。')
    return
  }
  try {
    const path = await vault.createNote(dailyPathOf(selected.value, title))
    cancelCompose()
    emit('open', path)
  } catch (err) {
    sync.notify('error', `无法创建日记: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// 换了选中日就收掉输入框：标题是给「那一天」的，留在输入态会让人以为敲完会建到别处去。
watch(selected, cancelCompose)
</script>

<template>
  <section class="calp" aria-label="日记日历">
    <!-- 表头：‹ 年月 › + 今天。年月 aria-live 让翻页对读屏有回音 -->
    <header class="calp__bar">
      <button class="calp__nav" type="button" aria-label="上个月" @click="shift(-1)">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
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
      <h2 class="calp__title" aria-live="polite">{{ monthTitle }}</h2>
      <button class="calp__nav" type="button" aria-label="下个月" @click="shift(1)">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
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
      <button class="calp__today" type="button" @click="goToday">今天</button>
    </header>

    <!-- 月历固定高度、不滚动：列表要吃掉剩下的全部空间，两边一起滚会很难受 -->
    <div ref="gridEl" class="calp__gridwrap">
      <table class="calp__grid" :aria-label="`${monthTitle}日记`">
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
              class="calp__td"
              :class="{
                'calp__td--out': !cell.inMonth,
                'calp__td--today': cell.date === today,
                'calp__td--sel': cell.date === selected,
              }"
            >
              <!-- 日期号按钮铺满整格：格子唯一的职责就是「选中这一天」 -->
              <button
                class="calp__day"
                type="button"
                :data-date="cell.date"
                :tabindex="cell.date === focusDate ? 0 : -1"
                :aria-label="labelOf(cell)"
                :aria-current="cell.date === selected ? 'date' : undefined"
                @click="select(cell.date)"
                @keydown="onCellKey($event, cell.date)"
              >
                <span class="calp__n">{{ cell.day }}</span>
                <span v-if="titlesOf(cell.date).length > 0" class="calp__dot" aria-hidden="true"></span>
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="calp__dayhead">
      <h3 class="calp__daytitle">{{ dayTitle }}</h3>
      <button class="calp__add" type="button" @click="startCompose">
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path
            d="M8 3.6v8.8M3.6 8h8.8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          />
        </svg>
        新建
      </button>
    </div>

    <div class="calp__body">
      <ul v-if="composing || dayList.length > 0" class="calp__list">
        <li v-if="composing">
          <input
            ref="composeInput"
            v-model="draft"
            class="calp__input"
            type="text"
            placeholder="标题"
            aria-label="新日记标题"
            @keydown.enter.prevent="submitCompose"
            @keydown.esc.stop="cancelCompose"
            @blur="cancelCompose"
          />
        </li>
        <li v-for="p in dayList" :key="p">
          <button
            class="calp__item"
            :class="{ 'calp__item--on': vault.activePath === p }"
            type="button"
            :title="titleOf(p)"
            @click="emit('open', p)"
          >
            {{ titleOf(p) }}
          </button>
        </li>
      </ul>

      <p v-else-if="vault.dailyByDate.size === 0" class="calp__hint">
        还没有日记。在上面点一天,点「新建」,会创建
        <code>{{ dailyDirOf(selected) }}/标题.md</code> 这样的文件并打开;一天可以写很多篇。
        方向键在日期间漫游,会顺带选中那一天。
      </p>
      <p v-else class="calp__hint">这一天还没有日记。</p>
    </div>
  </section>
</template>

<style scoped>
/* 上半截月历固定、下半截列表吃剩余空间。父容器（.sidebar__scroll--calendar）是
   flex column 伸展位，所以这里用 flex:1 而不是 height:100%——后者在弹性父级里
   按内容撑开，列表的 min-height:0 会被绕过去，最后一行滚不出来。
   颜色全部走 CSS 变量（verify-theme 禁止写死色值）。 */
.calp {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

/* —— 表头 —— */
.calp__bar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 2px 10px 8px;
}

.calp__nav {
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

.calp__nav:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.calp__title {
  flex: 1;
  margin: 0;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
}

.calp__today {
  flex: none;
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--text-muted);
  transition: background-color 0.12s ease, color 0.12s ease;
}

.calp__today:hover {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent-text);
}

/* —— 月历：紧凑格子，只有日期号与打点 —— */
.calp__gridwrap {
  flex: none;
  padding: 0 8px;
}

.calp__grid {
  width: 100%;
  border-collapse: separate;
  border-spacing: 2px;
  table-layout: fixed;
}

.calp__grid th {
  padding: 0 0 3px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  text-align: center;
}

.calp__td {
  position: relative;
  height: 30px;
  padding: 0;
}

/* 相邻月的日子：改用 --text-muted，而不是 opacity 把整格压暗。opacity 压的是已经变灰的
   成品色，0.45 时日期号只剩 3.78:1（axe 逮到过）；--text-muted 本身按正文对比度校准，
   在 --bg-elevated 上是 5.8:1——灰显的观感还在，可读性不再跟着往下掉。打点走 currentColor 一并变灰。 */
.calp__td--out .calp__day {
  color: var(--text-muted);
}

/* 今天：内嵌描边环，不动边框盒，格子尺寸与邻格完全一致 */
.calp__td--today .calp__day {
  box-shadow: inset 0 0 0 1.5px var(--accent);
}

/* 选中：淡强调底，与「今天」的环区分开——两者常常不是同一天 */
.calp__td--sel .calp__day {
  background: var(--accent-soft);
  color: var(--accent-text);
}

/* 今天 + 选中落在同一天时，日期号必须退回 --accent-text：--accent 压在 --accent-soft 上只有
   3.93:1，而 --accent-text 正是主题里为「淡底之上的强调色文字」校准的那一档。 */
.calp__td--today.calp__td--sel .calp__n {
  color: var(--accent-text);
}

.calp__day {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  border-radius: 6px;
  color: var(--text);
  transition: background-color 0.12s ease;
}

.calp__day:hover {
  background: var(--bg-hover);
}

/* 焦点环内缩：格子被表格的 border-spacing 夹着，外扩会被相邻格吃掉一截 */
.calp__day:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.calp__n {
  font-size: 12.5px;
  line-height: 1;
}

.calp__td--today .calp__n {
  font-weight: 700;
  color: var(--accent);
}

/* 打点用 currentColor：选中/悬停换色时跟着走，不必各写一遍 */
.calp__dot {
  position: absolute;
  bottom: 4px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.7;
}

/* —— 下半截：选中日的篇目 —— */
.calp__dayhead {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  margin: 6px 10px 0;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.calp__daytitle {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.calp__add {
  flex: none;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--text-muted);
  transition: background-color 0.12s ease, color 0.12s ease;
}

.calp__add:hover {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.calp__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 8px 8px;
}

.calp__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.calp__item {
  width: 100%;
  padding: 4px 8px;
  border-left: 2px solid transparent;
  border-radius: 6px;
  font-size: 12.5px;
  text-align: left;
  /* 长标题截断而不是换行：列表里换行还行，但会把「新建」按钮顶下去 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}

.calp__item:hover {
  background: var(--bg-hover);
  border-left-color: var(--accent);
}

/* 当前打开的那篇日记：与列表行的 active 同一语义（accent-soft 底 + accent 字） */
.calp__item--on {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.calp__input {
  width: 100%;
  box-sizing: border-box;
  padding: 4px 8px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 12.5px;
  outline: none;
}

.calp__input::placeholder {
  color: var(--text-muted);
}

/* 空态提示：组件各自 scoped，样式在本组件内自建，不借别人的 .hint */
.calp__hint {
  margin: 4px 10px 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-muted);
}

.calp__hint code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}
</style>
