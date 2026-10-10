/**
 * 日记日历的纯函数层：日期字符串 ↔ 路径、今天、月矩阵。
 *
 * 契约：日记固定落在 `日记/YYYY-MM-DD.md`（见 DAILY_DIR），文件名即日期，不引入 frontmatter
 * 字段、不加 Dexie 列——因此徽标计数与日历打点都能直接从路径算出来，删除/改名自然跟着走。
 *
 * 硬约束/注意事项：
 * - 全部是无依赖、无浏览器 API 的纯函数：store（stores/vault.ts 的 dailyDates）与
 *   scripts/verify-daily.mts（裸 node 直跑）共用同一份实现，日期算错会立刻在 CI 暴露。
 * - 所有日期字符串都是本地日历日（`todayStr` 取 getFullYear/getMonth/getDate）；**绝不能**
 *   改成 `toISOString()`——UTC+8 的 0–8 点会算成前一天。
 * - 日期运算一律走 UTC（addDays/monthMatrix），免得夏令时把格子挪一位。
 */

/** 日记目录常量；不设配置项，路径约定就是索引。 */
export const DAILY_DIR = '日记'

/** 严格匹配 `日记/YYYY-MM-DD.md`（扩展名大小写不敏感，对齐 paths.ts 的 OPFS 口径）；日期是否真实存在由 `dateOfDaily` 再验一轮。 */
const DAILY_RE = /^日记\/(\d{4})-(\d{2})-(\d{2})\.md$/i

/** 月历表头，周一开头（与 `monthMatrix` 的列位一致）。 */
export const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'] as const

/** 月历的一格：`date` 是 `YYYY-MM-DD`，`day` 是格内显示的号数，`inMonth` 标记是否当月（相邻月灰显）。 */
export interface DayCell {
  date: string
  day: number
  inMonth: boolean
}

/** 补两位数：`2026-01-05` 这类字符串的唯一格式化出口。 */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 用 setUTCFullYear 而不是 Date.UTC 构造：后者把 0–99 的年份映射成 1900+，
 * 会让 `日记/0050-02-29.md` 这种路径的合法性判定随实现漂移。
 * 入参 day 越界（如 2 月 30 日）时 Date 自己会归一化，由调用方比对回程结果识别。
 */
function utcDate(year: number, month1: number, day: number): Date {
  const d = new Date(0)
  d.setUTCFullYear(year, month1 - 1, day)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

/** 真实存在的 `年-月-日`（月 1–12、日落在该月内）；2026-02-30、2026-13-01 一律 false。 */
export function isRealDate(year: number, month1: number, day: number): boolean {
  const d = utcDate(year, month1, day)
  return d.getUTCFullYear() === year && d.getUTCMonth() === month1 - 1 && d.getUTCDate() === day
}

/** 该月天数（28–31）；用「下月第 0 天」的技巧取，等价于上月最后一天。 */
export function daysInMonth(year: number, month1: number): number {
  return utcDate(year, month1 + 1, 0).getUTCDate()
}

/** `YYYY-MM-DD` -> `日记/YYYY-MM-DD.md`。入参须是 `todayStr`/`monthMatrix` 产出的规范串。 */
export function dailyPathOf(date: string): string {
  return `${DAILY_DIR}/${date}.md`
}

/** 该路径的日期部分（`2026-10-10`）；不是合法日记路径则 null（含目录不符、日期不存在）。 */
export function dateOfDaily(path: string): string | null {
  const m = DAILY_RE.exec(path)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  return isRealDate(y, mo, d) ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/** 是否日记路径。只看路径形状，不查文件是否真的存在。 */
export function isDailyPath(path: string): boolean {
  return dateOfDaily(path) !== null
}

/**
 * 今天的本地日历日 `YYYY-MM-DD`；`now` 可注入便于测试。
 * 刻意不用 toISOString()：那是 UTC 日，UTC+8 的 0–8 点会退成昨天。
 */
export function todayStr(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

/** `YYYY-MM-DD` ± n 天（n 可为负）；跨月跨年由 UTC 日期运算自动进位/退位。 */
export function addDays(date: string, delta: number): string {
  const d = utcDate(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)))
  d.setUTCDate(d.getUTCDate() + delta)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/**
 * 星期几，0=周一 … 6=周日——与 `monthMatrix` 的列序同一口径，
 * 故与 JS 的 `getDay()`（0=周日）差一位。
 */
export function weekdayOf(date: string): number {
  const d = utcDate(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)))
  return (d.getUTCDay() + 6) % 7
}

/**
 * 月矩阵：周一开头，行数 = ceil((首日偏移 + 当月天数) / 7)，即 4–6 行 × 7 格。
 * 首尾格可能是相邻月（`inMonth: false`），调用方负责灰显；格子是真实日期，点击即可用。
 */
export function monthMatrix(year: number, month1: number): DayCell[][] {
  const first = `${year}-${pad2(month1)}-01`
  const start = addDays(first, -weekdayOf(first))
  const rows = Math.ceil((weekdayOf(first) + daysInMonth(year, month1)) / 7)
  const cells: DayCell[] = []
  for (let i = 0; i < rows * 7; i++) {
    const date = addDays(start, i)
    cells.push({
      date,
      day: Number(date.slice(8, 10)),
      inMonth: date.slice(0, 7) === `${year}-${pad2(month1)}`,
    })
  }
  const out: DayCell[][] = []
  for (let r = 0; r < rows; r++) out.push(cells.slice(r * 7, r * 7 + 7))
  return out
}
