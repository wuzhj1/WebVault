/**
 * 生成 PWA 所需的 PNG 图标。项目没有任何图像依赖，而只靠 SVG 的 manifest 在 Android 上
 * 安装并不可靠，因此这里手写了一个极小的软件光栅化器，直接按目标尺寸画出像素并编码成 PNG。
 *
 * 边缘抗锯齿用逐像素有符号距离的覆盖率解析计算，而不是超采样，
 * 这样无论图标尺寸多大，内存占用都保持恒定。
 *
 * 运行：node scripts/make-icons.mjs（或 npm run icons），产物写入 public/ 下的各目标路径。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const BG = [30, 30, 46, 255]
const ACCENT = [139, 124, 246, 255]
const SOFT = [166, 227, 161, 255]

// PNG 规范的 CRC-32 查表（多项式 0xedb88320），预先算好 256 项避免逐字节重算。
const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}

/** 计算 PNG chunk 用的 CRC-32 校验值。 */
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** 组装一个 PNG chunk：4 字节大端长度 + 4 字节类型 + 数据 + 类型与数据的 CRC。 */
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/**
 * 把 RGBA 像素缓冲编码成完整 PNG：每行前面放一个 0 号过滤字节（不过滤），
 * IDAT 用 zlib 最高级压缩，最后拼上签名与 IHDR/IEND。
 */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type 0：原样存储该行
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深：每通道 8 bit
  ihdr[9] = 6 // 颜色类型 6：带 alpha 的 RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 方形画布：所有图元最终都通过 put() 以部分覆盖率写入 RGBA 缓冲。 */
class Canvas {
  constructor(size) {
    this.size = size
    this.data = new Uint8Array(size * size * 4)
  }

  /** 标准的 source-over 合成，a 为该像素的覆盖率（0..1），用于把抗锯齿边缘混到已绘内容上。 */
  put(x, y, colour, a) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size || a <= 0) return
    const i = (y * this.size + x) * 4
    const sa = (colour[3] / 255) * a
    const da = this.data[i + 3] / 255
    const oa = sa + da * (1 - sa)
    if (oa <= 0) return
    for (let c = 0; c < 3; c++) {
      const sc = colour[c] / 255
      const dc = this.data[i + c] / 255
      this.data[i + c] = Math.round(((sc * sa + dc * da * (1 - sa)) / oa) * 255)
    }
    this.data[i + 3] = Math.round(oa * 255)
  }

  /**
   * 画一个居中的圆角矩形：逐像素算到矩形边界的有符号距离 d（d<0 在形内），
   * 覆盖率取 0.5-d，即解析式抗锯齿。inset 控制距边缘的内缩量，radius 为圆角半径。
   */
  roundedRect(inset, radius, colour) {
    const s = this.size
    const half = s / 2 - inset
    for (let y = 0; y < s; y++) {
      const qy = Math.abs(y + 0.5 - s / 2) - half + radius
      for (let x = 0; x < s; x++) {
        const qx = Math.abs(x + 0.5 - s / 2) - half + radius
        const d =
          Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
        this.put(x, y, colour, clamp(0.5 - d))
      }
    }
  }

  /** 铺满整幅：inset 取 -1（radius 0），保证最外一圈像素覆盖率完全不透明，不留半透明毛边。 */
  fill(colour) {
    this.roundedRect(-1, 0, colour)
  }

  /** 以 (cx,cy) 为圆心、r 为中线半径的圆环，thickness 为环宽；只扫描外接矩形以省掉无关像素。 */
  ring(cx, cy, r, thickness, colour) {
    const s = this.size
    const outer = r + thickness / 2 + 1
    for (let y = Math.max(0, Math.floor(cy - outer)); y < Math.min(s, Math.ceil(cy + outer + 1)); y++) {
      for (let x = Math.max(0, Math.floor(cx - outer)); x < Math.min(s, Math.ceil(cx + outer + 1)); x++) {
        const d = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r) - thickness / 2
        this.put(x, y, colour, clamp(0.5 - d))
      }
    }
  }

  /** 两点之间的线段（带圆头），thickness 为线宽；先把像素投影到线段上再取距离。 */
  segment(x1, y1, x2, y2, thickness, colour) {
    const s = this.size
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - thickness))
    const maxX = Math.min(s, Math.ceil(Math.max(x1, x2) + thickness + 1))
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - thickness))
    const maxY = Math.min(s, Math.ceil(Math.max(y1, y2) + thickness + 1))
    const dx = x2 - x1
    const dy = y2 - y1
    const len2 = dx * dx + dy * dy || 1
    for (let y = minY; y < maxY; y++) {
      for (let x = minX; x < maxX; x++) {
        const t = Math.min(1, Math.max(0, ((x + 0.5 - x1) * dx + (y + 0.5 - y1) * dy) / len2))
        const d = Math.hypot(x + 0.5 - (x1 + dx * t), y + 0.5 - (y1 + dy * t)) - thickness / 2
        this.put(x, y, colour, clamp(0.5 - d))
      }
    }
  }
}

/** 把覆盖率截断到 [0,1]，超出边界的像素由 put() 直接丢弃。 */
function clamp(v) {
  return v <= 0 ? 0 : v >= 1 ? 1 : v
}

/**
 * 两个相连的节点——与 public/icon.svg 是同一个图形。`safe` 会把画面整体缩小，
 * 让 maskable 图标的内容落在 Android 裁切所用的中央圆形安全区内。
 */
function drawIcon(size, maskable) {
  const c = new Canvas(size)
  if (maskable) c.fill(BG)
  else c.roundedRect(0, size * 0.19, BG)

  const safe = maskable ? 0.16 : 0
  const cx = size / 2
  const cy = size / 2
  const spread = size * (0.21 - safe * 0.35)
  const r = size * (0.125 - safe * 0.2)
  const th = size * (0.052 - safe * 0.16)

  const a = { x: cx - spread, y: cy - spread * 0.62 }
  const b = { x: cx + spread, y: cy + spread * 0.62 }
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  const ux = (b.x - a.x) / len
  const uy = (b.y - a.y) / len
  const gap = r + th * 0.55

  c.segment(a.x + ux * gap, a.y + uy * gap, b.x - ux * gap, b.y - uy * gap, th, ACCENT)
  c.ring(a.x, a.y, r, th, SOFT)
  c.ring(b.x, b.y, r, th, ACCENT)
  return encodePng(size, size, c.data)
}

// 输出清单：[仓库相对路径, 边长, 是否 maskable]。maskable 版铺满背景并留安全边距，
// 普通版画圆角，Apple 触摸图标按惯例用 180 且走 maskable 的构图。
const TARGETS = [
  ['public/pwa/pwa-192x192.png', 192, false],
  ['public/pwa/pwa-512x512.png', 512, false],
  ['public/pwa/maskable-icon-192x192.png', 192, true],
  ['public/pwa/maskable-icon-512x512.png', 512, true],
  ['public/apple-touch-icon.png', 180, true],
]

// 逐个尺寸渲染并写出；目标目录可能尚不存在（尤其刚 clone 时），先递归建好。
for (const [rel, size, maskable] of TARGETS) {
  const out = join(ROOT, rel)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, drawIcon(size, maskable))
  console.log(`wrote ${rel} (${size}x${size}${maskable ? ', maskable' : ''})`)
}
