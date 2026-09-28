<script setup lang="ts">
/**
 * 虚拟滚动文件树：把节点列先展平成「可见行」，再按滚动位置只渲染视口内的那一段。
 *
 * 相比旧的递归渲染（每层一个实例、子层靠 v-if 挂卸），大库（数千文件）不再一次性建出全部 DOM，
 * 常驻行数 ≈ 视口行数 + 2×OVERSCAN，与库大小无关；折叠、过滤切换也只重算一次展平。
 *
 * props:`nodes` 是过滤/排序后的根节点列;`depth` 不再存在——层级完全体现在 FlatRow.depth 的缩进里。
 * emits:`open(path)` 打开某篇笔记;`action(path, event)` 弹出 ⋯ 操作菜单(带原始 MouseEvent 定位)。
 * 依赖:useUiStore 的 `collapsedDirs`(哪些目录收起)、useVaultStore 的 `byPath`/`activePath`。
 *
 * 关键约束:
 * - 行高必须恒定:窗口切片全靠 ROW_H,故 CSS 里 `.row` 显式写死同一高度,两处必须同步改。
 * - 滚动容器不是自己:树与上下的提示行共用 SideBar 侧的滚动祖先,挂载时向上探测
 *   (overflow-y 为 auto/scroll),窗口用 ul 的上下 padding 占位——总高度不变,滚动条与
 *   全量渲染完全一致,提示行照常随内容滚动;探测不到时退回全量渲染,宁可慢不可缺行。
 * - 折叠状态仍在 ui store(跨层级、跨会话持久);展平是纯派生,没有也不允许有副作用。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { TreeNode } from '@/stores/vault.ts'
import { useUiStore } from '@/stores/ui.ts'
import { useVaultStore } from '@/stores/vault.ts'

const props = withDefaults(
  defineProps<{
    nodes: TreeNode[]
    /** 过滤态：true 时无视 ui.collapsedDirs 强制展开所有目录——命中藏在收起的目录里等于没找到。 */
    expandAll?: boolean
  }>(),
  { expandAll: false },
)
/** action 带出 MouseEvent:调用方需要事件对象才能把操作菜单定位到点击处。 */
const emit = defineEmits<{
  (e: 'open', path: string): void
  (e: 'action', path: string, event: MouseEvent): void
}>()

// 两个 store 都在 setup 取一次:模板里每行都要读,不能写成 ui.xxx() 形式的重复调用。
const ui = useUiStore()
const vault = useVaultStore()

/** 单行高度(px):窗口计算的唯一尺寸来源,必须与 CSS `.row { height }` 一致。 */
const ROW_H = 24
/** 视口上下各多渲染的行数:滚动余量;也让滚动祖先里位于树之外的少量内容(提示行)的偏移被吸收。 */
const OVERSCAN = 8

/** 展平后的一行;depth 只用来算缩进,不含任何逻辑。 */
interface FlatRow {
  kind: 'dir' | 'note'
  path: string
  name: string
  /** 目录的直接子项数;笔记行为 undefined。 */
  count?: number
  depth: number
}

/** 收起/展开某目录。状态在 ui store(整套替换 Set 触发本组件的展平重算)。 */
function toggle(path: string): void {
  ui.toggle(path)
}

/** 取某路径的元数据,用于打「未上传」「未缓存」角标;树里可能有远端存在但本地无内容的条目,故返回 undefined。 */
function meta(path: string) {
  return vault.byPath.get(path)
}

/** 可见行:与旧递归渲染的可见结果一一对应(收起目录整棵跳过,expandAll 强制展开)。 */
const rows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  const walk = (list: TreeNode[], depth: number): void => {
    for (const node of list) {
      if (node.kind === 'dir') {
        out.push({ kind: 'dir', path: node.path, name: node.name, count: node.children.length, depth })
        if (props.expandAll || !ui.collapsedDirs.has(node.path)) walk(node.children, depth + 1)
      } else {
        out.push({ kind: 'note', path: node.path, name: node.name, depth })
      }
    }
  }
  walk(props.nodes, 0)
  return out
})

const rootEl = ref<HTMLElement | null>(null)
/** 是否停留在窗口模式;挂载后探测不到滚动祖先就置假,退回全量渲染(缺行比慢更糟)。 */
const virtual = shallowRef(true)
/** 滚动祖先的纵向位置与高度:窗口切片的输入。 */
const scrollTop = shallowRef(0)
const viewportH = shallowRef(640)

let scroller: HTMLElement | null = null
let observer: ResizeObserver | null = null

function onScroll(): void {
  scrollTop.value = scroller?.scrollTop ?? 0
}

function onResize(): void {
  if (scroller) viewportH.value = scroller.clientHeight
}

/** 向上找最近的纵向可滚动祖先;窗口必须相对它计算,不能假设自己就是滚动容器。 */
function findScroller(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return p
  }
  return null
}

onMounted(() => {
  scroller = findScroller(rootEl.value)
  if (!scroller) {
    virtual.value = false
    return
  }
  viewportH.value = scroller.clientHeight
  scrollTop.value = scroller.scrollTop
  scroller.addEventListener('scroll', onScroll, { passive: true })
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(onResize)
    observer.observe(scroller)
  }
})

onBeforeUnmount(() => {
  scroller?.removeEventListener('scroll', onScroll)
  observer?.disconnect()
  observer = null
  scroller = null
})

/**
 * 窗口切片。上下 padding = 窗口外行的占位,ul 的总高度恒等于 rows.length × ROW_H,
 * 滚动条比例与全量渲染一致;起止都夹进 [0, rows.length],折叠后残留的深 scrollTop 不会切出负区间。
 */
const view = computed(() => {
  const all = rows.value
  if (!virtual.value) return { rows: all, padTop: 0, padBottom: 0 }
  const from = Math.floor(scrollTop.value / ROW_H) - OVERSCAN
  const to = Math.ceil((scrollTop.value + viewportH.value) / ROW_H) + OVERSCAN
  const start = Math.min(all.length, Math.max(0, from))
  const end = Math.min(all.length, Math.max(start, to))
  return {
    rows: all.slice(start, end),
    padTop: start * ROW_H,
    padBottom: (all.length - end) * ROW_H,
  }
})
</script>

<template>
  <!-- 上下 padding 占位:窗口外行数 × 行高,ul 高度恒定,滚动条与全量渲染完全一致 -->
  <ul
    ref="rootEl"
    class="tree"
    :style="{ paddingTop: `${view.padTop}px`, paddingBottom: `${view.padBottom}px` }"
  >
    <li v-for="row in view.rows" :key="row.path" class="tree__item">
      <template v-if="row.kind === 'dir'">
        <!-- 目录行：整行点击切换折叠，右侧数字是直接子项数；
             缩进 6+12×depth = 旧版 (6+2×depth) 行内步长 + 嵌套 ul 每层 10px 的合并 -->
        <button
          class="row row--dir"
          :style="{ paddingLeft: `${6 + row.depth * 12}px` }"
          @click="toggle(row.path)"
        >
          <svg
            class="chevron"
            :class="{ 'chevron--open': props.expandAll || !ui.collapsedDirs.has(row.path) }"
            viewBox="0 0 16 16"
            width="12"
            height="12"
            aria-hidden="true"
          >
            <path d="M6 3.5 L10.5 8 L6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
          <span class="row__name">{{ row.name }}</span>
          <span class="row__count">{{ row.count }}</span>
        </button>
      </template>

      <template v-else>
        <!-- 缩进 20+22×depth = 旧版 (20+12×depth) + 每层 10px；笔记行没有 chevron，步长更大直接画出层级 -->
        <!-- 用 div + role="button" + tabindex 而不是 <button>:行内还要嵌 ⋯ 操作按钮,button 不能套 button -->
        <div
          class="row row--note"
          :class="{ 'row--active': vault.activePath === row.path }"
          :style="{ paddingLeft: `${20 + row.depth * 22}px` }"
          role="button"
          tabindex="0"
          @click="emit('open', row.path)"
          @keydown.enter.prevent="emit('open', row.path)"
          @keydown.space.prevent="emit('open', row.path)"
        >
          <span class="row__name">{{ row.name }}</span>
          <!-- 角标：实心点 = 有未上传的本地修改；云朵 = 正文尚未下载到本地 -->
          <span class="row__badges">
            <span
              v-if="meta(row.path)?.dirty"
              class="badge badge--dirty"
              title="有未上传的本地修改"
            ></span>
            <svg
              v-if="meta(row.path) && !meta(row.path)!.cached"
              class="badge badge--cloud"
              viewBox="0 0 16 16"
              width="12"
              height="12"
              aria-label="尚未下载到本地"
            >
              <path
                d="M4.5 12a3 3 0 0 1-.3-6A4 4 0 0 1 12 6.6a2.7 2.7 0 0 1-.4 5.4z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
              />
            </svg>
          </span>
          <!-- .stop 是必需的:否则点击会同时冒泡到外层 div,既弹菜单又打开笔记 -->
          <button
            class="row__more"
            aria-label="笔记操作"
            @click.stop="emit('action', row.path, $event)"
          >
            ⋯
          </button>
        </div>
      </template>
    </li>
  </ul>
</template>

<style scoped>
.tree {
  margin: 0;
  padding: 0;
  list-style: none;
}

.tree__item {
  margin: 0;
}

/* 行样式：目录行与笔记行共用 .row，靠 --dir / --note / --active 修饰区分 */
.row {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  /* 24px 是脚本里 ROW_H 的镜像:窗口切片全靠行高恒定,两处必须同步改 */
  height: 24px;
  box-sizing: border-box;
  padding-top: 0;
  padding-bottom: 0;
  padding-right: 6px;
  border-radius: 6px;
  text-align: left;
  font-size: 13.5px;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}

.row:hover {
  background: var(--bg-hover);
}

.row--dir {
  color: var(--text-muted);
  font-weight: 500;
}

.row--active {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.row--active:hover {
  /* 悬停也保持高亮：不能让 hover 底色盖掉「正在看这篇」的标记 */
  background: var(--accent-soft);
}

.chevron {
  flex: none;
  transition: transform 0.13s;
}

.chevron--open {
  /* 展开态右转 90°，配合 transition 做出折叠动画；class 由「不在 collapsedDirs 里」驱动 */
  transform: rotate(90deg);
}

.row__name {
  flex: 1;
  /* min-width: 0 覆盖 flex 子项默认的 auto,否则长文件名会撑宽整行而非走省略号 */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row__count {
  flex: none;
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.75;
}

.row__badges {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.badge--dirty {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
}

.badge--cloud {
  color: var(--text-muted);
}

/* ⋯ 操作按钮：默认隐藏，行悬停或行处于选中态时露出（触屏无 hover，见文件末尾的媒体查询） */
.row__more {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  font-size: 13px;
  line-height: 1;
  color: var(--text-muted);
  opacity: 0;
}

.row:hover .row__more,
.row--active .row__more {
  opacity: 1;
}

.row__more:hover {
  background: var(--border);
  color: var(--text);
}

/* 触屏无 hover:⋯ 改为常显。只动 opacity,位置仍占着,行宽不会跳 */
@media (hover: none) {
  .row__more {
    opacity: 1;
  }
}
</style>
