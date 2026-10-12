/**
 * 日记日历的日期语义：frontmatter `date:` ↔ 日期、新建路径、今天、月矩阵。
 *
 * 契约：**日期是笔记的一个字段，不是它的存放位置**。frontmatter 的 `date:` 是权威来源——
 * 任何笔记只要写了 `date: 2026-10-10` 就是那一天的日记，哪怕它住在 `工作/` 下。位置与含义解耦
 * 之后，拖动、整理、改名都不会再把一篇日记悄悄踢出日历；那正是「日期在目录段」那版的真实缺陷：
 * 从 `日记/2026-10-10/会议.md` 挪进 `工作/`，它就无声地从日历上消失了。
 *
 * 路径那套仍然留着，但**只用来写、不再用来读**：
 * - `dailyPathOf` / `dailyDirOf` 照旧把新建的日记放到 `日记/YYYY-MM-DD/标题.md`——一天一个目录
 *   在文件树里按天折叠仍然好用，目录形态本身不是问题，把它当索引才是；
 * - `dateOfDaily` 只服务两处**写**（都在 stores/vault.ts）：回填 `repairDailyIndex` 给缺字段的
 *   存量/外部日记补上 `date:`，以及 `renameNote` 在搬进日期目录时把字段改成目标日期。
 *   两处都是「让字段跟上文件所在的那一天」，读取端不因此多出任何一条规则。
 *
 * 硬约束/注意事项：
 * - 全部是无依赖、无浏览器 API 的纯函数：store（stores/vault.ts 的 dailyByDate）与
 *   scripts/verify-daily.mts（裸 node 直跑）共用同一份实现，日期算错会立刻在 CI 暴露。
 *   唯一的相对导入 `./parse/frontmatter.ts` 同样是裸 node 能解析的——那模块自己就有这条约束。
 * - 所有日期字符串都是本地日历日（`todayStr` 取 getFullYear/getMonth/getDate）；**绝不能**
 *   改成 `toISOString()`——UTC+8 的 0–8 点会算成前一天。
 * - 日期运算一律走 UTC（addDays/monthMatrix），免得夏令时把格子挪一位。
 * - 旧版单文件形态 `日记/YYYY-MM-DD.md` **不识别**：它从来就不是按目录算的，回填也补不到它头上
 *   （存量几乎为零，不为它保留第二套判定）。
 */
import { parseFrontmatter, readScalar, writeKeys } from './parse/frontmatter.ts'

/**
 * 新建日记的落盘目录；**不是索引**——读取端只看 frontmatter（见模块头）。
 * 不设配置项，路径约定与 `dailyPathOf` 绑定。
 */
export const DAILY_DIR = '日记'

/**
 * 严格匹配 `日记/YYYY-MM-DD/标题.md`（扩展名大小写不敏感，对齐 paths.ts 的 OPFS 口径）。
 * 两处刻意的写法：标题段用字符类 `[^/]+` 而不是 `(.+)`——`.` 只排除换行、**照样匹配** `/`，
 * 用它会让 `日记/2026-10-10/上午/晨间.md` 这种多嵌一层的路径也通过；`[^/]+` 把标题锁死在一段里，
 * 深层嵌套因此进不来。日期是否真实存在由 `dateOfDaily` 再验一轮。
 *
 * 现在它只出现在写入端（回填、搬进日期目录）：认不出形状的文件没有可推的日期，跳过即可。
 */
const DAILY_RE = /^日记\/(\d{4})-(\d{2})-(\d{2})\/([^/]+)\.md$/i

/** 会让日期目录下凭空多出一层、或路径折叠后语义漂移的标题；`.` 与 `..` 必须显式拦，normalizePath 只拦 `..` 逃逸。 */
const BAD_DAILY_TITLE = /^(?:\.{1,2})$/

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

/**
 * `YYYY-MM-DD` -> `日记/YYYY-MM-DD`（该日的目录）。
 * 入参须是 `todayStr`/`monthMatrix` 产出的规范串；本函数不校验日期是否真实存在，
 * 调用方通常紧接着就拼标题成路径。
 */
export function dailyDirOf(date: string): string {
  return `${DAILY_DIR}/${date}`
}

/**
 * `YYYY-MM-DD` + 标题 -> `日记/YYYY-MM-DD/标题.md`。
 * 标题按 paths.ts 的 `sanitizeTitle` 口径由调用方先洗过；这里只再挡一次 `.`/`..`
 * ——它们会让路径折叠到上一层，写出日期目录之外的文件。
 */
export function dailyPathOf(date: string, title: string): string {
  if (BAD_DAILY_TITLE.test(title)) throw new Error(`日记标题不能是 ${title}`)
  return `${dailyDirOf(date)}/${title}.md`
}

/**
 * 该路径的日期部分（`2026-10-10`，取自目录段）；不是合法日记路径则 null。
 *
 * **只用于写入端**：回填（补 `date:`）与搬进日期目录（改 `date:`）两处见 daily.ts 模块头。
 * 补完之后读取端一律走 `dailyDateOf`，本函数不再是「某篇是不是日记」的判定。
 * 标题段不在此处解析：日记的标题就是文件名，`titleOf`（core/vault/paths.ts）原样可用。
 */
export function dateOfDaily(path: string): string | null {
  const m = DAILY_RE.exec(path)
  if (!m) return null
  if (BAD_DAILY_TITLE.test(m[4])) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  return isRealDate(y, mo, d) ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/** 是否日记**目录**下的路径。只看形状，不看文件里有没有 `date:`——回填用，不是日历判定。 */
export function isDailyPath(path: string): boolean {
  return dateOfDaily(path) !== null
}

/**
 * 正文 frontmatter 的 `date:` -> `YYYY-MM-DD`；缺失、挂成列表、或写不出真实日期一律 null。
 *
 * 宽容在两处：值带时间（`2026-10-10T09:30`，Obsidian 模板的常见写法）只取日期段；引号包裹
 * （`date: '2026-10-10'`）由 `readScalar` 解开。严格在一处：`2026-02-30`、`2026-13-01` 这类
 * 不存在的日子一律 null——放进日历，月历上会多出一个永远点不中的日期。
 *
 * 这是日历唯一认可的日期来源（store 的 `dailyByDate` 由 `dailies` 索引反查，而索引就建在本函数上）。
 */
export function dailyDateOf(text: string): string | null {
  return normalizeDailyDate(readScalar(parseFrontmatter(text), 'date'))
}

/** 把任意形态的日期值收敛成 `YYYY-MM-DD`；前缀必须是完整年-月-日，其余一律 null。 */
function normalizeDailyDate(raw: string | null): string | null {
  if (raw === null) return null
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  if (!m) return null
  return isRealDate(Number(m[1]), Number(m[2]), Number(m[3])) ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * 新建日记的初始正文：只有 frontmatter 的 `date:`，正文留空。
 *
 * 走 `writeKeys` 而不是手拼 `---\ndate: ...\n---`：引号策略、`KEY_ORDER`、无块文件的补块规则
 * 全由它一处决定，手拼迟早和解析侧的口径漂移（写出带引号、按不带引号解析，或反过来）。
 * 空字符串入、`---\ndate: X\n---\n` 出，恒等式由 writeKeys 的拼接构造保证。
 */
export function initialDailyContent(date: string): string {
  return writeKeys('', { date })
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
