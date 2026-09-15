<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { db } from '@/core/db.ts'
import { cssColor } from '@/core/theme/apply.ts'
import { titleOf } from '@/core/vault/paths.ts'
import { useAppearanceStore } from '@/stores/appearance.ts'
import { useVaultStore } from '@/stores/vault.ts'

const emit = defineEmits<{ (e: 'open', path: string): void; (e: 'close'): void }>()

const vault = useVaultStore()
const appearance = useAppearanceStore()

const canvas = ref<HTMLCanvasElement | null>(null)
const wrap = ref<HTMLElement | null>(null)
const local = ref(false)
const stats = ref({ nodes: 0, edges: 0 })

interface GNode {
  path: string
  title: string
  degree: number
  x: number
  y: number
  vx: number
  vy: number
  fixed: boolean
}

const SPRING = 78
const REPULSE = 1400
const CUTOFF = 190
const CELL = 190

let nodes: GNode[] = []
let edges: [number, number][] = []
let byPath = new Map<string, number>()
let alpha = 1
let scale = 1
let tx = 0
let ty = 0
let frame = 0
let hovered: number | null = null
let dragging: number | null = null
let panning = false
let downX = 0
let downY = 0
let moved = false
let width = 0
let height = 0
let dpr = 1
let observer: ResizeObserver | null = null

interface Palette {
  node: string
  active: string
  hovered: string
  edgeIdle: string
  labelBg: string
  label: string
}

/**
 * Canvas wants resolved color strings and the loop runs at 60fps, so the theme variables are
 * read once and cached; changing theme or accent just drops the cache and the next frame
 * re-reads them.
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

watch(
  () => [appearance.theme, appearance.accent] as const,
  () => {
    palette = null
  },
)

const hasActive = computed(() => vault.activePath !== null)

async function load(): Promise<void> {
  const rows = await db.links.toArray()
  const active = vault.activePath
  const scope = vault.notes.filter((n) => !n.removedLocal)

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

  // Reuse existing coordinates so toggling between local and global does not re-explode.
  nodes = chosen.map((n, i) => {
    const old = prev.get(n.path)
    const angle = (i / Math.max(chosen.length, 1)) * Math.PI * 2
    const radius = 60 + Math.sqrt(i) * 22
    return {
      path: n.path,
      title: n.title || titleOf(n.path),
      degree: 0,
      x: old?.x ?? Math.cos(angle) * radius + (Math.random() - 0.5) * 20,
      y: old?.y ?? Math.sin(angle) * radius + (Math.random() - 0.5) * 20,
      vx: 0,
      vy: 0,
      fixed: false,
    }
  })
  byPath = index

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
}

function tick(): void {
  if (alpha < 0.003) return

  const cells = new Map<string, number[]>()
  for (let i = 0; i < nodes.length; i++) {
    const key = cellKey(nodes[i].x, nodes[i].y)
    const bucket = cells.get(key)
    if (bucket) bucket.push(i)
    else cells.set(key, [i])
  }

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

  alpha *= 0.985
}

function cellKey(x: number, y: number): string {
  return `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`
}

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
    ctx.fillStyle = i === activeIndex ? c.active : i === hovered ? c.hovered : c.node
    ctx.beginPath()
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  const labelFor = (i: number | null): void => {
    if (i === null) return
    const n = nodes[i]
    const size = 11 / scale
    ctx.font = `${size}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.globalAlpha = 0.78
    ctx.fillStyle = c.labelBg
    const w = ctx.measureText(n.title).width
    const r = (2.6 + Math.sqrt(n.degree) * 1.5) / Math.max(scale, 0.35)
    ctx.fillRect(n.x - w / 2 - 4 / scale, n.y - r - size - 5 / scale, w + 8 / scale, size + 6 / scale)
    ctx.globalAlpha = 1
    ctx.fillStyle = c.label
    ctx.fillText(n.title, n.x, n.y - r - 5 / scale)
  }
  labelFor(activeIndex)
  labelFor(hovered)
}

function loop(): void {
  tick()
  draw()
  frame = requestAnimationFrame(loop)
}

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
}

function toWorld(event: PointerEvent | WheelEvent): { x: number; y: number } {
  const rect = canvas.value!.getBoundingClientRect()
  const sx = event.clientX - rect.left - tx - width / 2
  const sy = event.clientY - rect.top - ty - height / 2
  return { x: sx / scale, y: sy / scale }
}

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

function onPointerDown(event: PointerEvent): void {
  canvas.value?.setPointerCapture(event.pointerId)
  downX = event.clientX
  downY = event.clientY
  moved = false
  const hit = pick(event)
  if (hit !== null) {
    dragging = hit
    nodes[hit].fixed = true
    alpha = Math.max(alpha, 0.35)
  } else {
    panning = true
  }
}

function onPointerMove(event: PointerEvent): void {
  if (Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY) > 4) moved = true

  if (dragging !== null) {
    const p = toWorld(event)
    nodes[dragging].x = p.x
    nodes[dragging].y = p.y
    alpha = Math.max(alpha, 0.25)
    return
  }
  if (panning) {
    tx += event.clientX - downX
    ty += event.clientY - downY
    downX = event.clientX
    downY = event.clientY
    return
  }
  hovered = pick(event)
}

function onPointerUp(event: PointerEvent): void {
  if (dragging !== null) {
    if (!moved) {
      const n = nodes[dragging]
      emit('open', n.path)
      emit('close')
    }
    nodes[dragging].fixed = false
    dragging = null
  } else if (!moved && hovered !== null) {
    emit('open', nodes[hovered].path)
    emit('close')
  }
  panning = false
  canvas.value?.releasePointerCapture(event.pointerId)
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const before = toWorld(event)
  const factor = Math.exp(-event.deltaY * 0.0015)
  scale = Math.min(4, Math.max(0.15, scale * factor))
  const after = toWorld(event)
  tx += (after.x - before.x) * scale
  ty += (after.y - before.y) * scale
}

function recenter(): void {
  scale = 1
  tx = 0
  ty = 0
  alpha = Math.max(alpha, 0.5)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}

watch(local, () => {
  void load()
})

onMounted(async () => {
  resize()
  observer = new ResizeObserver(resize)
  if (wrap.value) observer.observe(wrap.value)
  canvas.value?.addEventListener('pointerdown', onPointerDown)
  canvas.value?.addEventListener('pointermove', onPointerMove)
  canvas.value?.addEventListener('pointerup', onPointerUp)
  canvas.value?.addEventListener('pointercancel', onPointerUp)
  canvas.value?.addEventListener('wheel', onWheel, { passive: false })
  document.addEventListener('keydown', onKeydown)
  await load()
  frame = requestAnimationFrame(loop)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  observer?.disconnect()
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div class="graph" @mousedown.self="emit('close')">
      <div class="graph__box" role="dialog" aria-label="关系图谱">
        <header class="graph__head">
          <h3>关系图谱</h3>
          <label class="graph__toggle">
            <input v-model="local" type="checkbox" :disabled="!hasActive" />
            <span>只看当前笔记的邻居</span>
          </label>
          <span class="graph__stats">{{ stats.nodes }} 篇 · {{ stats.edges }} 条链接</span>
          <div class="graph__gap"></div>
          <button class="graph__btn" @click="recenter">重置视图</button>
          <button class="graph__close" aria-label="关闭" @click="emit('close')">×</button>
        </header>

        <div ref="wrap" class="graph__canvas">
          <canvas ref="canvas"></canvas>
          <p v-if="stats.nodes === 0" class="graph__empty">还没有笔记可以绘制。</p>
          <p class="graph__legend">
            拖动节点可调整位置 · 滚轮缩放 · 拖动空白处平移 · 点击节点打开笔记
            <span class="dot dot--active"></span>当前笔记
            <span class="dot dot--hover"></span>鼠标所指
          </p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
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

.graph__head {
  display: flex;
  align-items: center;
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
