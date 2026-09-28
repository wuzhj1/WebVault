<script setup lang="ts">
/**
 * 关系图谱：以模态弹层展示笔记之间的双链关系，Canvas 绘制的简易力导向图。
 *
 * 数据来自 Dexie 的 links 表与 vault 笔记列表；requestAnimationFrame 循环每帧先做物理
 * 模拟（tick）再绘制（draw），温度 alpha 衰减到阈值后**整个循环停表**、画面保留最后一帧；
 * 指针移动 / 拖拽 / 缩放平移 / 主题切换 / 图重建各自调 wake() 续排，静止时零 CPU 开销。
 * 交互：拖动节点会固定它并唤醒模拟、拖空白平移、滚轮以光标为锚点缩放、悬停出信息卡
 * （标题/路径/出入链数，HTML 浮层锚定节点屏幕坐标）、点击节点请求打开对应笔记。
 * 工具条的「显示标题」默认常显全部节点的标签（热标签加粗压上层），大库嫌吵可随手关。
 * 坐标全部使用"世界坐标"，屏幕坐标只在指针事件里临时换算。
 *
 * （孤儿卡筛选及其空心点画法已随卡片盒功能一并移除：图里现在只有「全局 / 只看邻居」一档。）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { db } from '@/core/db.ts'
import { cssColor } from '@/core/theme/apply.ts'
import { titleOf } from '@/core/vault/paths.ts'
import { useAppearanceStore } from '@/stores/appearance.ts'
import { useVaultStore } from '@/stores/vault.ts'

/** open：点击节点时请求打开对应笔记；close：请求关闭图谱弹层。 */
const emit = defineEmits<{ (e: 'open', path: string): void; (e: 'close'): void }>()

const vault = useVaultStore()
const appearance = useAppearanceStore()

/** Canvas 元素与其外层容器；容器负责提供 CSS 尺寸，Canvas 按 DPR 设置物理像素。 */
const canvas = ref<HTMLCanvasElement | null>(null)
const wrap = ref<HTMLElement | null>(null)
/** 筛选：只看当前笔记的一跳邻居（无激活笔记时开关禁用）。 */
const local = ref(false)
/** 工具条：常显所有节点的标题（默认开；大库嫌吵可关，悬停/当前的高亮标签不受它影响）。 */
const labels = ref(true)
/** 头部统计：当前图里的节点数与去重后的边数。 */
const stats = ref({ nodes: 0, edges: 0 })

/**
 * 悬停信息卡：指向某节点时展示的笔记档案，位置锚定该节点的屏幕坐标（跟随缩放平移重算）。
 * 拖拽开始即隐藏——拖动时节点被钉在指针下，卡片跟着抖反而碍事。
 */
const card = ref<CardInfo | null>(null)

/** 信息卡内容：身份（标题/路径/目录）+ 链路数（解释「这张图为什么长这样」，出链含未创建的目标）。 */
interface CardInfo {
  title: string
  path: string
  /** 所在目录；根目录下为空串，模板据此隐藏该行。 */
  dir: string
  out: number
  in: number
  /** 出链里指向「尚未创建的笔记」的条数——它们在图里没有对应节点，先说明才不会显得少线。 */
  dangling: number
  /** 卡片锚点：所指节点的屏幕坐标（容器内 CSS 像素）。 */
  sx: number
  sy: number
  /** 靠近右/下边缘时向左/上展开，避免卡片被弹层裁掉。 */
  flipX: boolean
  flipY: boolean
}

/** 力导向图中的一个节点；位置/速度为世界坐标，非响应式，只被 rAF 循环读写。 */
interface GNode {
  path: string
  title: string
  /** 标题在 11px 字号下的宽度（CSS px）；0 = 尚未量过，首帧懒量一次后缓存，避免每帧 measureText。 */
  labelW: number
  degree: number
  x: number
  y: number
  vx: number
  vy: number
  /** 被用户拖住时固定，模拟阶段跳过对它的积分。 */
  fixed: boolean
}

/** 单篇笔记的链路档案；信息卡数据源，与图的范围筛选无关（悬空出链也算数）。 */
interface LinkStat {
  out: number
  in: number
  dangling: number
}

/** 边的平衡长度：弹簧力试图把两端拉到这个距离。 */
const SPRING = 78
/** 库仑式斥力强度：节点相距越近互相推开越猛。 */
const REPULSE = 1400
/** 斥力截断距离：超过它不算斥力，配合空间网格只需查 3×3 邻域。 */
const CUTOFF = 190
/** 空间网格边长；取值不小于 CUTOFF 才能保证截断范围被 3×3 邻域覆盖。 */
const CELL = 190

// —— 模拟与视图状态（普通变量，刻意不做成响应式，避免每帧触发 Vue 更新） ——
let nodes: GNode[] = []
let edges: [number, number][] = []
let byPath = new Map<string, number>()
/** 每篇笔记的链路档案：由 links 表在每次 load 时重建，供悬停信息卡查询。 */
let linkStats = new Map<string, LinkStat>()
/** 模拟温度：1 表示全力计算，每帧乘 0.985 衰减，低于 ALPHA_STOP 即停止模拟。 */
let alpha = 1
/** 收敛阈值：tick 停算、主循环停表用的是同一个数，两处判定必须一致。 */
const ALPHA_STOP = 0.003
/** 视图变换：以画布中心为原点的缩放与平移。 */
let scale = 1
let tx = 0
let ty = 0
/** rAF 句柄；null = 当前没有排程中的一帧。停表后交互靠 wake() 按需补帧。 */
let frame: number | null = null
// 指针交互状态：hovered/dragging 是节点下标，panning 表示正在平移画布。
let hovered: number | null = null
let dragging: number | null = null
let panning = false
// 按下起点与位移标记：移动超过 4px 才算拖动，否则视为点击。
let downX = 0
let downY = 0
let moved = false
// 画布 CSS 尺寸与设备像素比。
let width = 0
let height = 0
let dpr = 1
let observer: ResizeObserver | null = null

/** 一帧绘制所需的已解析颜色集合。 */
interface Palette {
  node: string
  active: string
  hovered: string
  edgeIdle: string
  labelBg: string
  label: string
}

/**
 * Canvas 只接受已解析的颜色字符串，而绘制循环跑在 60fps，因此主题变量只读一次并缓存；
 * 切换主题或强调色时丢弃缓存，下一帧会重新读取。
 */
let palette: Palette | null = null

function colors(): Palette {
  palette ??= {
    node: cssColor('--accent'),
    active: cssColor('--ok'),
    hovered: cssColor('--warn'),
    edgeIdle: cssColor('--text-muted'),
    labelBg: cssColor('--bg'),
    label: cssColor('--text'),
  }
  return palette
}

// 主题或强调色变化 → 丢弃颜色缓存并补一帧重绘（图谱静止时循环已停表，不 wake 就要等下次交互才换色）。
watch(
  () => [appearance.theme, appearance.accent] as const,
  () => {
    palette = null
    wake()
  },
)

/** 是否存在当前激活笔记，决定"只看邻居"开关是否可用。 */
const hasActive = computed(() => vault.activePath !== null)

/**
 * 按当前筛选（全局 ↔ 只看邻居）重建节点与边。
 * 复用上一版节点的坐标，使得在两种范围之间切换时布局不会重新炸开。
 */
async function load(): Promise<void> {
  const rows = await db.links.toArray()
  const active = vault.activePath
  const scope = vault.notes.filter((n) => !n.removedLocal)

  // 信息卡的链路档案：按整张 links 表统计，与下面的范围筛选无关——
  // 出链包含 targetPath 为空的悬空链接（目标还没创建，图里没有对应节点，但账要算上）。
  const profile = new Map<string, LinkStat>()
  const bump = (path: string): LinkStat => {
    let s = profile.get(path)
    if (!s) {
      s = { out: 0, in: 0, dangling: 0 }
      profile.set(path, s)
    }
    return s
  }
  for (const r of rows) {
    const from = bump(r.src)
    from.out++
    if (!r.targetPath) from.dangling++
    else bump(r.targetPath).in++
  }
  linkStats = profile

  let keep: Set<string> | null = null
  if (local.value && active) {
    keep = new Set<string>([active])
    for (const r of rows) {
      if (r.src === active && r.targetPath) keep.add(r.targetPath)
      if (r.targetPath === active) keep.add(r.src)
    }
  }

  const chosen = keep ? scope.filter((n) => keep!.has(n.path)) : scope
  const index = new Map(chosen.map((n, i) => [n.path, i]))
  const prev = new Map(nodes.map((n) => [n.path, n]))

  // 复用已有坐标，避免在范围切换时布局重新炸开。
  nodes = chosen.map((n, i) => {
    const old = prev.get(n.path)
    const angle = (i / Math.max(chosen.length, 1)) * Math.PI * 2
    const radius = 60 + Math.sqrt(i) * 22
    return {
      path: n.path,
      title: n.title || titleOf(n.path),
      labelW: 0,
      degree: 0,
      x: old?.x ?? Math.cos(angle) * radius + (Math.random() - 0.5) * 20,
      y: old?.y ?? Math.sin(angle) * radius + (Math.random() - 0.5) * 20,
      vx: 0,
      vy: 0,
      fixed: false,
    }
  })
  byPath = index
  // 节点数组换血后指针侧的下标全部作废：悬停/拖拽若还指着旧数组的下标，下一次 draw
  // 就会拿 undefined 读属性把绘制打断（画布冻结在半帧），up 时也会读错节点。
  hovered = null
  dragging = null
  panning = false
  updateCard(null)

  const seen = new Set<string>()
  edges = []
  for (const r of rows) {
    if (!r.targetPath) continue
    const a = index.get(r.src)
    const b = index.get(r.targetPath)
    if (a === undefined || b === undefined || a === b) continue
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push([a, b])
    nodes[a].degree++
    nodes[b].degree++
  }

  stats.value = { nodes: nodes.length, edges: edges.length }
  alpha = 1
  // 重建后必须重新排帧：图谱此前可能已经收敛停表，光把 alpha 抬起来没人执行 tick。
  wake()
}

/**
 * 单步力导向模拟，按顺序做四件事：
 * 1) 把节点按位置撒进空间网格；
 * 2) 斥力：只检查 3×3 邻域内的节点对，超出 CUTOFF 直接跳过（避免 O(n²)）；
 * 3) 弹簧：每条边把两端往平衡长度 SPRING 拉；
 * 4) 积分：向心引力 + 阻尼 + 限速后更新位置，最后让 alpha 衰减。
 * alpha 低于阈值时整段直接返回，画面停在收敛后的布局上。
 */
function tick(): void {
  if (alpha < ALPHA_STOP) return

  // 1) 空间网格分桶
  const cells = new Map<string, number[]>()
  for (let i = 0; i < nodes.length; i++) {
    const key = cellKey(nodes[i].x, nodes[i].y)
    const bucket = cells.get(key)
    if (bucket) bucket.push(i)
    else cells.set(key, [i])
  }

  // 2) 斥力：j <= i 保证每对节点只算一次；重合点给一个微小随机偏移避免除零。
  const cutoff2 = CUTOFF * CUTOFF
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]
    const cx = Math.floor(a.x / CELL)
    const cy = Math.floor(a.y / CELL)
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = cells.get(`${cx + ox},${cy + oy}`)
        if (!bucket) continue
        for (const j of bucket) {
          if (j <= i) continue
          const b = nodes[j]
          let dx = b.x - a.x
          let dy = b.y - a.y
          let d2 = dx * dx + dy * dy
          if (d2 > cutoff2) continue
          if (d2 < 0.01) {
            dx = (Math.random() - 0.5) * 0.1
            dy = (Math.random() - 0.5) * 0.1
            d2 = dx * dx + dy * dy
          }
          const d = Math.sqrt(d2)
          const f = ((REPULSE / d2) * alpha) / d
          const fx = dx * f
          const fy = dy * f
          a.vx -= fx
          a.vy -= fy
          b.vx += fx
          b.vy += fy
        }
      }
    }
  }

  // 3) 弹簧力：按与平衡长度的偏差把两端互相拉近/推离，力度随 alpha 一起衰减。
  for (const [a, b] of edges) {
    const na = nodes[a]
    const nb = nodes[b]
    const dx = nb.x - na.x
    const dy = nb.y - na.y
    const d = Math.hypot(dx, dy) || 0.01
    const f = ((d - SPRING) / d) * 0.06 * alpha
    const fx = dx * f
    const fy = dy * f
    na.vx += fx
    na.vy += fy
    nb.vx -= fx
    nb.vy -= fy
  }

  // 4) 积分：拖住的节点不动；其余受向心引力（防止整图漂走）、阻尼与限速后更新位置。
  for (const n of nodes) {
    if (n.fixed) {
      n.vx = 0
      n.vy = 0
      continue
    }
    n.vx -= n.x * 0.0016 * alpha
    n.vy -= n.y * 0.0016 * alpha
    n.vx *= 0.82
    n.vy *= 0.82
    const speed = Math.hypot(n.vx, n.vy)
    if (speed > 12) {
      n.vx = (n.vx / speed) * 12
      n.vy = (n.vy / speed) * 12
    }
    n.x += n.vx
    n.y += n.vy
  }

  // 温度衰减：布局逐渐收敛，模拟最终自行停止。
  alpha *= 0.985
}

/** 世界坐标 → 空间网格的分桶键。 */
function cellKey(x: number, y: number): string {
  return `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`
}

/**
 * 绘制一帧：应用视图变换 → 边（悬停/当前相关的边高亮）→ 节点（当前/悬停高亮）
 * → 最后给当前与悬停两个节点加标题。
 * 线宽与字号都除以 scale，保证缩放时视觉粗细保持恒定。
 */
function draw(): void {
  const ctx = canvas.value?.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.translate(tx + width / 2, ty + height / 2)
  ctx.scale(scale, scale)

  const activeIndex = vault.activePath ? byPath.get(vault.activePath) ?? null : null
  const c = colors()

  ctx.lineWidth = 1 / scale
  for (const [a, b] of edges) {
    const touched = a === hovered || b === hovered || a === activeIndex || b === activeIndex
    ctx.globalAlpha = touched ? 0.55 : 0.18
    ctx.strokeStyle = touched ? c.node : c.edgeIdle
    ctx.beginPath()
    ctx.moveTo(nodes[a].x, nodes[a].y)
    ctx.lineTo(nodes[b].x, nodes[b].y)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const r = (2.6 + Math.sqrt(n.degree) * 1.5) / Math.max(scale, 0.35)
    ctx.beginPath()
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
    ctx.fillStyle = i === activeIndex ? c.active : i === hovered ? c.hovered : c.node
    ctx.fill()
  }

  /**
   * 在节点上方绘制带底色的标题：字体与底框都按 scale 归一，保证缩放后视觉尺寸不变。
   * `hot`（当前/悬停）画满不透明并加粗；普通标签半透明，压在热标签下层。
   * 标题宽度按 11px 量一次后缓存在节点上（世界宽度 = 缓存值 / scale），免得每帧 measureText。
   */
  const labelFor = (i: number | null, hot: boolean): void => {
    // 越界防御：激活笔记可能已删/被范围滤掉（取不到下标），hovered 也可能在重建后失效——
    // 这里曾经拿 undefined 读 labelW，异常会把整个 draw 打断、循环不再续排，画布就冻住了。
    if (i === null || i < 0 || i >= nodes.length) return
    const n = nodes[i]
    const size = 11 / scale
    if (n.labelW === 0) {
      ctx.font = '11px system-ui, sans-serif'
      n.labelW = ctx.measureText(n.title).width || 1
    }
    ctx.font = `${hot ? '600 ' : ''}${size}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.globalAlpha = hot ? 0.95 : 0.6
    ctx.fillStyle = c.labelBg
    const w = n.labelW / scale
    const r = (2.6 + Math.sqrt(n.degree) * 1.5) / Math.max(scale, 0.35)
    ctx.fillRect(n.x - w / 2 - 4 / scale, n.y - r - size - 5 / scale, w + 8 / scale, size + 6 / scale)
    ctx.globalAlpha = hot ? 1 : 0.85
    ctx.fillStyle = c.label
    ctx.fillText(n.title, n.x, n.y - r - 5 / scale)
  }
  // 「显示标题」常显全部节点；热标签最后画，保证盖在普通标签上层。
  if (labels.value) {
    for (let i = 0; i < nodes.length; i++) {
      if (i === activeIndex || i === hovered) continue
      labelFor(i, false)
    }
  }
  labelFor(activeIndex, true)
  labelFor(hovered, true)
  // 标签把 globalAlpha 留在了半透明档，复位后再交还下一帧。
  ctx.globalAlpha = 1
}

/**
 * rAF 主循环：先模拟后绘制，句柄归一到 frame（卸载时统一取消）。
 * 布局收敛且没有拖拽在进行时**主动停表**——此前这里无条件重排，图谱开着就一直全量重绘
 * （清屏 + 遍历所有边和节点），静止时也在烧 CPU/GPU。停表后画面保留最后一帧，
 * 后续的指针移动、缩放平移、主题切换、图重建各自调 wake() 补一帧或续排。
 */
function loop(): void {
  frame = null
  tick()
  draw()
  if (alpha >= ALPHA_STOP || dragging !== null) frame = requestAnimationFrame(loop)
}

/** 排一帧（幂等）：已在排程中则什么都不做，静止时不会退化成常驻循环。 */
function wake(): void {
  if (frame === null) frame = requestAnimationFrame(loop)
}

/** 按容器的 CSS 尺寸与设备像素比重设画布物理像素，保证高分屏下不糊。 */
function resize(): void {
  const el = wrap.value
  const c = canvas.value
  if (!el || !c) return
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  width = el.clientWidth
  height = el.clientHeight
  c.width = Math.round(width * dpr)
  c.height = Math.round(height * dpr)
  c.style.width = `${width}px`
  c.style.height = `${height}px`
  // 重设画布物理像素会清空画布，必须立刻补一帧，否则停表期间会留一块空白。
  // 画布尺寸变了，信息卡的贴边判定也得按新尺寸重算。
  updateCard(hovered)
  wake()
}

/** 屏幕坐标（视口像素）→ 世界坐标：先减去画布原点与平移，再除以缩放。 */
function toWorld(event: PointerEvent | WheelEvent): { x: number; y: number } {
  const rect = canvas.value!.getBoundingClientRect()
  const sx = event.clientX - rect.left - tx - width / 2
  const sy = event.clientY - rect.top - ty - height / 2
  return { x: sx / scale, y: sy / scale }
}

/**
 * 节点命中检测：返回可视半径内距离最近的节点下标，没有命中则返回 null。
 * 半径在绘制半径基础上再放 6/scale 的容差，让小节点也点得中。
 */
function pick(event: PointerEvent): number | null {
  const p = toWorld(event)
  let best: number | null = null
  let bestD = Infinity
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const r = (2.6 + Math.sqrt(n.degree) * 1.5) / Math.max(scale, 0.35) + 6 / scale
    const d = Math.hypot(n.x - p.x, n.y - p.y)
    if (d < r && d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * 更新悬停信息卡：锚定所指节点的屏幕坐标（与 draw 的视图变换同一套换算），
 * 右/下余量不足时翻到左/上，避免卡片被弹层边缘裁掉；index 为 null 即收起。
 * 缩放、平移、重置、拖拽结束、指针离开画布都要重调——卡片位置依赖视图变换。
 */
function updateCard(index: number | null): void {
  if (index === null) {
    card.value = null
    return
  }
  const n = nodes[index]
  const sx = n.x * scale + tx + width / 2
  const sy = n.y * scale + ty + height / 2
  const s = linkStats.get(n.path) ?? { out: 0, in: 0, dangling: 0 }
  card.value = {
    title: n.title,
    path: n.path,
    dir: n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '',
    out: s.out,
    in: s.in,
    dangling: s.dangling,
    sx,
    sy,
    flipX: sx > width - 250,
    flipY: sy > height - 130,
  }
}

/** 信息卡定位样式：默认在节点右下，贴右缘改右锚、贴下缘整体上移（transform 上翻）。 */
const cardStyle = computed(() => {
  const info = card.value
  if (!info) return {}
  const style: Record<string, string> = info.flipX
    ? { right: `${Math.max(width - info.sx + 14, 8)}px` }
    : { left: `${info.sx + 14}px` }
  style.top = info.flipY ? `${info.sy - 14}px` : `${info.sy + 14}px`
  if (info.flipY) style.transform = 'translateY(-100%)'
  return style
})

/**
 * 按下：命中节点 → 进入拖拽并固定该节点，同时把 alpha 抬到至少 0.35 唤醒模拟；
 * 未命中 → 进入平移。位移阈值 4px 在 move 中判定，用于区分"点击"与"拖动"。
 */
function onPointerDown(event: PointerEvent): void {
  try {
    canvas.value?.setPointerCapture(event.pointerId)
  } catch {
    // 捕获失败（合成事件没有活跃指针 / UA 已回收）只影响拖出画布后事件是否跟随，
    // 不能让它打断按下流程——downX/moved/pick 全都排在它后面。
  }
  downX = event.clientX
  downY = event.clientY
  moved = false
  const hit = pick(event)
  if (hit !== null) {
    dragging = hit
    nodes[hit].fixed = true
    // 拖拽中节点钉在指针下，信息卡跟着抖反而碍事，先收起、松手再回来。
    updateCard(null)
    alpha = Math.max(alpha, 0.35)
    wake()
  } else {
    panning = true
  }
}

/**
 * 移动：拖拽时把节点直接钉在指针的世界坐标上并抬 alpha；平移时改 tx/ty（增量取
 * 上次记录的按下点，等于做差分）；空闲时只更新 hovered 供高亮与命中。
 * 位移超过 4px 才算拖动，否则松开时仍视为点击。
 */
function onPointerMove(event: PointerEvent): void {
  if (Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY) > 4) moved = true

  if (dragging !== null) {
    const p = toWorld(event)
    nodes[dragging].x = p.x
    nodes[dragging].y = p.y
    alpha = Math.max(alpha, 0.25)
    wake()
    return
  }
  if (panning) {
    tx += event.clientX - downX
    ty += event.clientY - downY
    downX = event.clientX
    downY = event.clientY
    // 视图平移了，锚定节点屏幕坐标的信息卡要跟着挪。
    updateCard(hovered)
    wake()
    return
  }
  const hit = pick(event)
  // 高亮真的换了才补一帧：鼠标在静止的图上空扫不该持续重绘。
  if (hit !== hovered) {
    hovered = hit
    updateCard(hit)
    wake()
  }
}

/** 指针离开画布：清掉悬停高亮与信息卡（否则停在最后一个节点上不走）。 */
function onPointerLeave(): void {
  if (hovered === null) return
  hovered = null
  updateCard(null)
  wake()
}

/**
 * 抬起：若按下的是节点且没有发生位移，视为点击——请求打开笔记并关闭图谱；
 * 若落在空白处且未移动过，命中悬停节点时同样打开。随后释放固定与指针捕获。
 */
function onPointerUp(event: PointerEvent): void {
  if (dragging !== null) {
    if (!moved) {
      const n = nodes[dragging]
      emit('open', n.path)
      emit('close')
    }
    nodes[dragging].fixed = false
    dragging = null
    // 松手后指针若还停在节点上，信息卡恢复显示。
    updateCard(hovered)
  } else if (!moved && hovered !== null) {
    emit('open', nodes[hovered].path)
    emit('close')
  }
  panning = false
  try {
    canvas.value?.releasePointerCapture(event.pointerId)
  } catch {
    // 指针抬起/取消时 UA 可能已自动释放捕获，再释放会抛 NotFoundError——忽略即可。
  }
}

/**
 * 滚轮缩放：以光标下的世界坐标为锚点——缩放前后各取一次世界坐标，用差值补偿平移，
 * 使光标所指的点在缩放过程中保持不动。缩放范围钳制在 0.15 ~ 4。
 */
function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const before = toWorld(event)
  const factor = Math.exp(-event.deltaY * 0.0015)
  scale = Math.min(4, Math.max(0.15, scale * factor))
  const after = toWorld(event)
  tx += (after.x - before.x) * scale
  ty += (after.y - before.y) * scale
  // 缩放改变了「世界坐标 → 屏幕坐标」的映射，信息卡要跟着重锚。
  updateCard(hovered)
  wake()
}

/**
 * 恢复默认视图（1:1、居中），并把 alpha 抬到 0.5 让布局轻微回弹，
 * 避免用户缩放平移后完全找不到中心。
 */
function recenter(): void {
  scale = 1
  tx = 0
  ty = 0
  updateCard(hovered)
  alpha = Math.max(alpha, 0.5)
  wake()
}

/** Esc 关闭图谱；stopPropagation 防止外层（如全局快捷键）再处理这次按键。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}

// 「只看邻居」开关变化 → 重建图（load 会复用旧坐标，布局不至于重置）。
watch(local, () => {
  void load()
})

// 「显示标题」只改绘制内容；静止时循环已停表，切换要自己补一帧。
watch(labels, () => wake())

onMounted(async () => {
  resize()
  // 容器尺寸变化（含弹层放大缩小）时重设画布；wheel 用 passive:false 以便 preventDefault。
  observer = new ResizeObserver(resize)
  if (wrap.value) observer.observe(wrap.value)
  canvas.value?.addEventListener('pointerdown', onPointerDown)
  canvas.value?.addEventListener('pointermove', onPointerMove)
  canvas.value?.addEventListener('pointerup', onPointerUp)
  canvas.value?.addEventListener('pointercancel', onPointerUp)
  canvas.value?.addEventListener('pointerleave', onPointerLeave)
  canvas.value?.addEventListener('wheel', onWheel, { passive: false })
  document.addEventListener('keydown', onKeydown)
  await load() // load 内部已经 wake，这里不必再排一次
})

/* 卸载：停掉动画帧、断开尺寸观察、移除 Esc 监听（指针监听随 canvas 一起回收）。 */
onBeforeUnmount(() => {
  if (frame !== null) cancelAnimationFrame(frame)
  frame = null
  observer?.disconnect()
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div class="graph" @mousedown.self="emit('close')">
      <div class="graph__box" role="dialog" aria-label="关系图谱">
        <!-- 工具条：范围筛选（互不排斥时取交集）、统计与视图操作 -->
        <header class="graph__head">
          <h3>关系图谱</h3>
          <label class="graph__toggle">
            <input v-model="local" type="checkbox" :disabled="!hasActive" />
            <span>只看当前笔记的邻居</span>
          </label>
          <label class="graph__toggle">
            <input v-model="labels" type="checkbox" />
            <span>显示标题</span>
          </label>
          <span class="graph__stats">{{ stats.nodes }} 篇 · {{ stats.edges }} 条链接</span>
          <div class="graph__gap"></div>
          <button class="graph__btn" @click="recenter">重置视图</button>
          <button class="graph__close" aria-label="关闭" @click="emit('close')">×</button>
        </header>

        <!-- 画布容器：提供 CSS 尺寸；空态、悬停信息卡与图例浮在其上 -->
        <div ref="wrap" class="graph__canvas">
          <canvas ref="canvas"></canvas>
          <p v-if="stats.nodes === 0" class="graph__empty">还没有笔记可以绘制。</p>
          <!-- 悬停信息卡：HTML 浮层而非 canvas 绘制——文字随 DPI 锐化、样式直接走主题变量；
               pointer-events:none 保证不挡画布的拖拽与点击 -->
          <div v-if="card" class="graph__card" :style="cardStyle">
            <strong class="graph__card-title">{{ card.title }}</strong>
            <span class="graph__card-path">{{ card.path }}</span>
            <span class="graph__card-meta">
              出链 {{ card.out }}<template v-if="card.dangling > 0">({{ card.dangling }} 条未创建)</template> · 入链 {{ card.in }}
            </span>
            <span v-if="card.dir" class="graph__card-dir">目录:{{ card.dir }}</span>
          </div>
          <p class="graph__legend">
            拖动节点可调整位置 · 滚轮缩放 · 拖动空白处平移 · 点击节点打开笔记 · 悬停查看笔记信息
            <span class="dot dot--active"></span>当前笔记
            <span class="dot dot--hover"></span>鼠标所指
          </p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* —— 遮罩层与弹层主体 —— */
.graph {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--scrim);
  backdrop-filter: blur(2px);
}

.graph__box {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 1080px;
  height: 100%;
  max-height: 760px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 18px 50px var(--shadow-color);
  overflow: hidden;
}

/* —— 顶部标题与筛选开关 —— */
.graph__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  flex: none;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}

.graph__head h3 {
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
}

.graph__toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12.5px;
  color: var(--text-muted);
  cursor: pointer;
}

.graph__toggle input:disabled {
  opacity: 0.4;
}

.graph__toggle:has(input:disabled) {
  cursor: default;
  opacity: 0.5;
}

.graph__stats {
  font-size: 11.5px;
  color: var(--text-muted);
}

.graph__gap {
  flex: 1;
}

.graph__btn {
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg);
  font-size: 12px;
  color: var(--text-muted);
}

.graph__btn:hover {
  color: var(--accent);
  border-color: var(--accent);
}

.graph__close {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  font-size: 19px;
  line-height: 1;
  color: var(--text-muted);
}

.graph__close:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* —— 画布区（含空态与底部图例） —— */
.graph__canvas {
  position: relative;
  flex: 1;
  min-height: 0;
  background: var(--bg);
  touch-action: none;
}

.graph__canvas canvas {
  display: block;
  cursor: grab;
}

.graph__canvas canvas:active {
  cursor: grabbing;
}

.graph__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
}

/* —— 悬停信息卡：锚定节点屏幕坐标,不参与指针事件 —— */
.graph__card {
  position: absolute;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 240px;
  padding: 8px 10px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px var(--shadow-color);
  pointer-events: none;
}

.graph__card-title {
  font-size: 13px;
  font-weight: 600;
}

.graph__card-path {
  /* 路径可能很长:允许断行,否则会把卡片撑出弹层 */
  font-size: 11px;
  color: var(--text-muted);
  word-break: break-all;
}

.graph__card-meta {
  font-size: 12px;
  color: var(--text);
}

.graph__card-dir {
  font-size: 11px;
  color: var(--text-muted);
}

/* —— 底部图例与节点状态色标 —— */
.graph__legend {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  margin: 0;
  padding: 7px 12px;
  background: linear-gradient(to top, color-mix(in srgb, var(--bg) 92%, transparent), transparent);
  font-size: 11.5px;
  color: var(--text-muted);
  pointer-events: none;
}

.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin: 0 4px 0 10px;
  border-radius: 50%;
  vertical-align: middle;
}

.dot--active {
  background: var(--ok);
}

.dot--hover {
  background: var(--warn);
}

/* 窄屏（≤640px）：弹层全屏化，统计信息让位给操作按钮 */
@media (max-width: 640px) {
  .graph {
    padding: 0;
  }

  .graph__box {
    max-width: none;
    max-height: none;
    border-radius: 0;
    border: none;
  }

  .graph__stats {
    display: none;
  }
}
</style>
