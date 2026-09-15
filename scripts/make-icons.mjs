/**
 * Generates the PWA PNG icons. Written as a tiny software rasterizer because the project has
 * no image dependency and SVG-only manifests are unreliable for Android installability.
 *
 * Edges are anti-aliased analytically (per-pixel signed-distance coverage) rather than by
 * supersampling, which keeps memory flat at any icon size.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const BG = [30, 30, 46, 255]
const ACCENT = [139, 124, 246, 255]
const SOFT = [166, 227, 161, 255]

const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

class Canvas {
  constructor(size) {
    this.size = size
    this.data = new Uint8Array(size * size * 4)
  }

  /** Standard source-over composite at fractional coverage. */
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

  /** Full-bleed fill, inset by -1 so the border pixels stay fully opaque. */
  fill(colour) {
    this.roundedRect(-1, 0, colour)
  }

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

function clamp(v) {
  return v <= 0 ? 0 : v >= 1 ? 1 : v
}

/**
 * Two linked nodes — the same mark as public/icon.svg. `safe` shrinks the artwork so a
 * maskable icon keeps its content inside the central circle Android crops to.
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

const TARGETS = [
  ['public/pwa/pwa-192x192.png', 192, false],
  ['public/pwa/pwa-512x512.png', 512, false],
  ['public/pwa/maskable-icon-192x192.png', 192, true],
  ['public/pwa/maskable-icon-512x512.png', 512, true],
  ['public/apple-touch-icon.png', 180, true],
]

for (const [rel, size, maskable] of TARGETS) {
  const out = join(ROOT, rel)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, drawIcon(size, maskable))
  console.log(`wrote ${rel} (${size}x${size}${maskable ? ', maskable' : ''})`)
}
