<script setup lang="ts">
/**
 * 左右栏的宽度分隔条:拖动改宽、双击复位、方向键微调。
 *
 * 只在桌面端可交互(窄屏下两栏是铺满 body 区的全屏层,没有「宽度」可言)。**用 CSS 媒体查询
 * 隐藏而不是 v-if**:分隔条在不在纯粹是布局的事,交给 cascade 判断比让 JS 监听 matchMedia
 * 更省事,也不会在断点附近多出一次重渲染。
 *
 * 本组件只报告「新宽度是多少」,既不写 CSS 变量也不碰存储:宽度是 App 的布局状态,配套的
 * 持久化也归它。这里一旦自作主张,就会出现「拖完是对的,一刷新回到默认」这种分裂。
 *
 * `role="separator"` + `tabindex` + 方向键:拖拽之外的唯一入口。ARIA 把这类可拖的分隔条
 * 叫 window splitter,`aria-valuenow` 报当前宽度,读屏器用户才知道自己在调什么。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { PANEL_MAX_W, PANEL_MIN_W } from '@/core/ui/panel-width.ts'

const props = defineProps<{
  /** 收的是哪一栏:'side' = 左侧栏,'right' = 右侧栏。决定拖动方向与无障碍标签。 */
  side: 'side' | 'right'
  /** 当前宽度,拖动起点与 aria-valuenow 都从它取。 */
  width: number
}>()

const emit = defineEmits<{
  /** 报一个新宽度,取值已夹在 [MIN,MAX] 内;是否采纳、要不要落盘由 App 决定。 */
  (e: 'resize', width: number): void
  /** 双击复位到出厂宽度。 */
  (e: 'reset'): void
}>()

/** 编辑区至少留这么宽:再窄就不是「笔记应用」了,正文一行十几个字根本读不了。 */
const EDITOR_MIN_W = 400
/** 方向键一次走 8px;按住不放大约每秒 100 次,1 秒能把一条栏拖出近 800px。 */
const STEP = 8

/**
 * 分隔条向右拖即变宽。左栏的分隔条在右缘,向右 = 变宽;右栏的在左缘,向左 = 变宽,
 * 所以方向是 -1。方向键共用同一个换算:按下的键要和「这条边往哪边走」一致,
 * 否则右栏会出现「按 → 反而变宽」这种反直觉的结果。
 */
const dir = computed(() => (props.side === 'side' ? 1 : -1))

const label = computed(() => (props.side === 'side' ? '调整左侧栏宽度' : '调整右侧栏宽度'))

const dragging = ref(false)

/** 分隔条自己,靠它定位编辑区(同在 `.app__body` 之下的兄弟)。 */
const el = ref<HTMLElement | null>(null)
/** 拖动起点:按下那一刻的鼠标位置与两处宽度。 */
let startX = 0
let startW = 0
/**
 * 拖动开始时编辑区的宽度。「不能把编辑区挤没」这条约束靠它换算成可增量的上限,
 * 而不是每帧再去读一次——读到的已经是本次拖动改过的值,约束会跟着一起漂。
 */
let editorStartW = 0

/** 编辑区元素。分隔条和它同在 `.app__body` 之下,兄弟关系是稳定的。 */
function editorEl(): HTMLElement | null {
  return el.value?.parentElement?.querySelector<HTMLElement>('.app__main') ?? null
}

function onPointerDown(e: PointerEvent): void {
  // 只认主键:中键/右键拖动是浏览器的文本选择与右键语义,不该抢。
  if (e.button !== 0) return
  startX = e.clientX
  startW = props.width
  editorStartW = editorEl()?.clientWidth ?? 0
  dragging.value = true
  // move/up 挂在 window 而不是自己身上:pointer capture 在指针已经消失(快速甩动、
  // 系统抢走指针)时会漏事件,而拖到窗口外再拖回来是分隔条最常见的用法。
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', stopDrag)
  window.addEventListener('pointercancel', stopDrag)
}

function onPointerMove(e: PointerEvent): void {
  applyDelta(e.clientX - startX)
}

/** 松手或指针被系统取消:两个方向都要撤干净,漏一个就会出现「拖完还在跟着鼠标跑」。 */
function stopDrag(): void {
  dragging.value = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', stopDrag)
  window.removeEventListener('pointercancel', stopDrag)
}

/** 双击复位:拖歪了不必一点点拖回来。 */
function onDblClick(): void {
  emit('reset')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  startX = 0
  startW = props.width
  editorStartW = editorEl()?.clientWidth ?? 0
  applyDelta(e.key === 'ArrowRight' ? STEP : -STEP)
}

/**
 * clientX 方向的增量换算成面板宽度:先按分隔条的方向取符号,再把「编辑区不能被挤没」
 * 这条上限折进去,最后夹进 [MIN,MAX]。负增量(把栏拖窄)不需要上限,由 MIN 兜着。
 */
function applyDelta(clientDx: number): void {
  const raw = dir.value * clientDx
  const grow = Math.min(raw, editorStartW - EDITOR_MIN_W)
  emit('resize', Math.min(Math.max(startW + grow, PANEL_MIN_W), PANEL_MAX_W))
}

// 拖到一半组件被卸载(切页、关标签)时把 window 上的监听撤干净。
// stopDrag 本身是幂等的:没挂监听时移除只是空操作,不必先判断 dragging。
onBeforeUnmount(stopDrag)
</script>

<template>
  <div
    ref="el"
    class="resizer"
    :class="{ 'resizer--on': dragging }"
    role="separator"
    aria-orientation="vertical"
    :aria-label="label"
    :aria-valuenow="width"
    :aria-valuemin="PANEL_MIN_W"
    :aria-valuemax="PANEL_MAX_W"
    tabindex="0"
    @pointerdown="onPointerDown"
    @dblclick="onDblClick"
    @keydown="onKeydown"
  ></div>
</template>

<style scoped>
/* 热区 6px,但用负外边距让它压住两侧各 3px:真正占位为 0,布局不会因为多一条分隔条而挪动。
   z-index 让它盖在两栏背景之上,否则被压住的那 3px 会点不着。 */
.resizer {
  position: relative;
  z-index: 4;
  flex: none;
  width: 6px;
  margin: 0 -3px;
  cursor: col-resize;
  touch-action: none;
  background: transparent;
  transition: background-color 0.15s ease;
}

.resizer:hover,
.resizer--on {
  background: color-mix(in srgb, var(--accent) 55%, transparent);
}

/* 键盘操作时必须看得见焦点在哪,否则 Tab 过去只有一个凭空出现的色块。 */
.resizer:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

/* 窄屏下两栏是铺满的全屏层,没有宽度可调,直接不给热区也不给 Tab 停留点。 */
@media (max-width: 959px) {
  .resizer {
    display: none;
  }
}
</style>
