import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ACCENTS, DEFAULT_ACCENT, DEFAULT_THEME, THEMES, codeThemeFor } from '../src/core/theme/themes.ts'

let pass = 0
let fail = 0

function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass++
  } else {
    fail++
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ''}`)
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

// 注释要一起去掉,否则它会混进紧随其后的选择器文本里。
const css = readFileSync('src/styles/themes.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }))

function rule(selector: string): { sel: string; body: string } | undefined {
  return rules.find((r) => r.sel.split(',').some((s) => s.trim() === selector))
}

function tokens(body: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map.set(m[1], m[2].trim())
  return map
}

function rgb(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
}

function toHex([r, g, b]: number[]): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
}

function luminance(hex: string): number {
  const channel = (v: number): number => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = rgb(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function ratio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `color-mix(in srgb, A p, B)` 叠在不透明底色上等价于这里的线性插值。 */
function mix(fg: string, bg: string, pct: number): string {
  const f = rgb(fg)
  const b = rgb(bg)
  return toHex(f.map((v, i) => v * pct + b[i] * (1 - pct)))
}

const HEX = /^#[0-9a-f]{6}$/i

const palettes = new Map<string, Map<string, string>>()

for (const theme of THEMES) {
  const preview = rule(`[data-theme-preview='${theme.id}']`)
  ok(`主题 ${theme.id} 有调色板块`, !!preview)
  if (!preview) continue

  // 默认主题挂在 :root 上,其余靠 html[data-theme],特异度要压过 :root。
  const selector = theme.id === DEFAULT_THEME ? ':root' : `html[data-theme='${theme.id}']`
  ok(`主题 ${theme.id} 选择器`, preview.sel.split(',').some((s) => s.trim() === selector), `实际 ${preview.sel}`)

  const vars = tokens(preview.body)
  palettes.set(theme.id, vars)
  const scheme = /color-scheme:\s*(\w+)/.exec(preview.body)?.[1]
  ok(`主题 ${theme.id} 声明 color-scheme: ${theme.mode}`, scheme === theme.mode, `实际 ${scheme}`)
}

// 五套主题必须声明同一组令牌,否则切主题时会有变量停在上一套的值上。
const shape = [...(palettes.get(DEFAULT_THEME)?.keys() ?? [])].sort().join(',')
for (const theme of THEMES) {
  const vars = palettes.get(theme.id)
  if (!vars) continue
  const own = [...vars.keys()].sort().join(',')
  ok(`主题 ${theme.id} 令牌齐全`, own === shape, `差异:${own}`)
}

function accentRaw(id: string): string {
  const r = rule(`[data-accent='${id}']`)
  return r ? (tokens(r.body).get('--accent-raw') ?? '') : ''
}

const lightAccents = new Map<string, string>()
for (const r of rules) {
  const m = /^\[data-mode='light'\]\[data-accent='([\w-]+)'\]$/.exec(r.sel)
  if (m) lightAccents.set(m[1], tokens(r.body).get('--accent') ?? '')
}

for (const accent of ACCENTS) {
  const preview = rule(`[data-accent-preview='${accent.id}']`)
  ok(`强调色 ${accent.id} 有预览块`, !!preview)
  ok(`强调色 ${accent.id} 原值是纯色`, HEX.test(accentRaw(accent.id)), `实际 ${accentRaw(accent.id)}`)
  ok(`强调色 ${accent.id} 有浅色版`, HEX.test(lightAccents.get(accent.id) ?? ''), `实际 ${lightAccents.get(accent.id)}`)
}

// 派生令牌:淡底百分比、淡底上的强调色文字、复选框对勾。深色默认写在 :root,浅色由 data-mode 覆盖。
const darkDerived = tokens(rules.find((r) => r.sel === ':root' && tokens(r.body).has('--accent-soft'))?.body ?? '')
const lightDerived = tokens(rule("[data-mode='light']")?.body ?? '')

function softPct(vars: Map<string, string>): number {
  return Number(/var\(--accent\)\s*(\d+(?:\.\d+)?)%/.exec(vars.get('--accent-soft') ?? '')?.[1] ?? NaN)
}

/** `color-mix(in srgb, #fff 24%, var(--accent))` → 掺多少白/黑。 */
function textMix(vars: Map<string, string>): { with: string; pct: number } {
  const m = /color-mix\(in srgb,\s*(#[0-9a-f]{3,6})\s+(\d+(?:\.\d+)?)%,\s*var\(--accent\)\)/i.exec(
    vars.get('--accent-text') ?? '',
  )
  if (!m) return { with: '', pct: NaN }
  const short = m[1]
  const hex = short.length === 4 ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : short
  return { with: hex, pct: Number(m[2]) }
}

function checkStroke(vars: Map<string, string>): string {
  return /stroke='%23([0-9a-f]{6})'/i.exec(vars.get('--check-mark') ?? '')?.[1] ?? ''
}

const modes = [
  { mode: 'dark' as const, derived: darkDerived },
  { mode: 'light' as const, derived: lightDerived },
]

for (const { mode, derived } of modes) {
  ok(`${mode} 声明 --accent-text`, !!derived.get('--accent-text'), `实际 ${derived.get('--accent-text')}`)
  ok(`${mode} 声明 --check-mark`, /%23[0-9a-f]{6}/i.test(derived.get('--check-mark') ?? ''))
}

const darkSoft = softPct(darkDerived) / 100
const lightSoft = softPct(lightDerived) / 100
const darkText = textMix(darkDerived)
const lightText = textMix(lightDerived)
const darkTick = `#${checkStroke(darkDerived)}`
const lightTick = `#${checkStroke(lightDerived)}`

// 对比度按 WCAG 算:正文 7:1,小字号的次要文本、语义色、强调色 4.5:1,图形 3:1。
for (const theme of THEMES) {
  const vars = palettes.get(theme.id)
  if (!vars) continue
  const bg = vars.get('--bg') ?? ''
  const dark = theme.mode === 'dark'
  const soft = dark ? darkSoft : lightSoft
  const text = dark ? darkText : lightText
  const tick = dark ? darkTick : lightTick

  const check = (label: string, color: string, min: number, on = bg): void => {
    const got = ratio(color, on)
    ok(`${theme.id} ${label} ≥ ${min}:1`, got >= min, `${color} on ${on} = ${got.toFixed(2)}`)
  }

  check('正文', vars.get('--text') ?? '', 7)
  check('次要文本', vars.get('--text-muted') ?? '', 4.5)
  check('danger', vars.get('--danger') ?? '', 4.5)
  check('ok', vars.get('--ok') ?? '', 4.5)
  check('warn', vars.get('--warn') ?? '', 4.5)
  check('正文压在浮起面上', vars.get('--text') ?? '', 7, vars.get('--bg-elevated') ?? '')

  // GraphView 把这几个令牌直接交给 ctx.fillStyle,canvas 不认 color-mix,只能是纯色。
  for (const name of ['--bg', '--text', '--text-muted', '--ok', '--warn']) {
    ok(`${theme.id} ${name} 是画布可用的纯色`, HEX.test(vars.get(name) ?? ''), `实际 ${vars.get(name)}`)
  }

  for (const { id } of ACCENTS) {
    const accent = dark ? accentRaw(id) : (lightAccents.get(id) ?? '')
    if (!HEX.test(accent)) continue
    check(`${id} 强调色`, accent, 4.5)
    // 选中态是「淡底 + 强调色文字」,淡底把对比度拉低,--accent-text 要能补回来。
    const tinted = mix(accent, bg, soft)
    check(`${id} 淡底上的文字`, mix(text.with, accent, text.pct / 100), 4.5, tinted)
    check(`${id} 复选框对勾`, tick, 3, accent)
  }
}

ok('默认主题在注册表里', THEMES.some((t) => t.id === DEFAULT_THEME))
ok('默认强调色在注册表里', ACCENTS.some((a) => a.id === DEFAULT_ACCENT))

// 代码高亮样式必须已经本地化,否则离线时 Vditor 会去 CDN 拉。
for (const mode of ['dark', 'light'] as const) {
  const file = `public/vditor/dist/js/highlight.js/styles/${codeThemeFor(mode)}.min.css`
  ok(`${mode} 代码主题已本地化`, existsSync(file), file)
}

// 组件只准用令牌:写死的色值会让新主题出现「只有一半跟着变」的情况。
const styled = walk('src').filter((f) => f.endsWith('.vue') || (f.endsWith('.css') && !f.endsWith('themes.css')))
const hardcoded: string[] = []
for (const file of styled) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line)) hardcoded.push(`${file}:${i + 1} ${line.trim()}`)
    })
}
ok('组件里没有写死的颜色', hardcoded.length === 0, hardcoded.join('\n  '))

// 用到的变量必须有人声明,写错名字时 CSS 不会报错,只会静默用初始值。
const declared = new Set<string>()
for (const file of ['src/styles/themes.css', 'src/styles/main.css']) {
  for (const m of readFileSync(file, 'utf8').matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1])
}
const used = new Set<string>()
for (const file of walk('src').filter((f) => f.endsWith('.vue') || f.endsWith('.css'))) {
  for (const m of readFileSync(file, 'utf8').matchAll(/var\((--[\w-]+)/g)) used.add(m[1])
}
const missing = [...used].filter((name) => !declared.has(name)).sort()
ok('用到的变量都已声明', missing.length === 0, missing.join(', '))

console.log(`${fail === 0 ? 'OK  ' : 'FAIL'} verify-theme: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
