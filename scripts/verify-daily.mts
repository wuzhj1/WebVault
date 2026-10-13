/**
 * 日历纯函数验证（src/core/daily.ts）：
 * - **日期来源（读取端）**：frontmatter 的 `date:`——`dailyDateOf` 是日历唯一认可的日期来源。
 *   位置不再承担索引职责，因此把日记挪出 `日记/` 也不会从日历上消失；
 * - **路径契约（写入端与回填）**：新建**平铺**落 `日记/标题.md`（大小写不敏感的扩展名，
 *   对齐 paths.ts 口径），标题即文件名、`titleOf` 原样可用，同名由 `uniqueDailyPath` 按
 *   `标题 2 / 3 …` 退让；`dateOfDaily` 只服务回填与搬移（给缺 `date:` 的存量日记补字段、
 *   搬进日期名文件时改字段），认三种历史形态——`日记/YYYY-MM-DD/标题.md`（一天一目录那版）、
 *   `日记/YYYY-MM-DD.md`（单文件那版）与根目录的 `YYYY-MM-DD.md`。
 *   日期必须真实存在——`2026-02-30`、`2026-13-01` 一律拒收，否则徽标会点亮一个造不出来的文件；
 * - 本地日：`todayStr` 走 getFullYear/getMonth/getDate，UTC+8 的 0–8 点不能退成前一天
 *   （与 toISOString 的 UTC 日对照钉死这一点）；
 * - 日期运算：addDays 跨月/跨年/闰日，daysInMonth 与闰年（2024-02 = 29 天）；
 * - 星期口径：weekdayOf 是 0=周一…6=周日（月矩阵列序），比 JS 的 getDay() 少偏一位；
 * - 月矩阵：周一开头、行数 = ceil((首日偏移 + 当月天数) / 7) 即 4–6 行、首尾格可跨相邻月
 *   且 inMonth 标记正确、当月每一天恰好出现一次——这是日历视图渲染与方向键漫游的地基。
 *
 * 运行：pnpm verify（第 17 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import {
  DAILY_DIR,
  WEEKDAY_NAMES,
  addDays,
  dailyDateOf,
  dailyDirDateOf,
  dailyPathOf,
  dateOfDaily,
  daysInMonth,
  initialDailyContent,
  isDailyPath,
  isRealDate,
  monthMatrix,
  todayStr,
  uniqueDailyPath,
  weekdayOf,
} from '../src/core/daily.ts'
import { titleOf } from '../src/core/vault/paths.ts'

let pass = 0
let fail = 0

/** 用 JSON 序列化后比较，失败时打印 expected/actual 差异。 */
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`)
  }
}

/** 断言某段代码必须抛错：用于「构造本身就不该被接受」的入口（如 dailyPathOf 的标题守卫）。 */
function checkThrows(name: string, fn: () => unknown): void {
  try {
    fn()
    fail++
    console.log(`FAIL ${name}\n  expected a throw, but it returned normally`)
  } catch {
    pass++
  }
}

// ---- 目录常量与新建路径 ----
check('DAILY_DIR is 日记', DAILY_DIR, '日记')
check('dailyPathOf shape', dailyPathOf('晨间'), '日记/晨间.md')
// 标题就是文件名，故全库通用的 titleOf 原样可用——这是「日记不单开一个取标题函数」的依据
check('title comes from filename', titleOf(dailyPathOf('晨间')), '晨间')
// 新建路径不带日期：日期在初始正文的字段里。路径推不出日子，才说明两者真的解耦了
check('new path carries no date', dateOfDaily(dailyPathOf('晨间')), null)

// ---- 标题守卫：`.` 与 `..` 会让路径折叠到日记目录之外，构造阶段就该拒 ----
checkThrows('dailyPathOf rejects dot', () => dailyPathOf('.'))
checkThrows('dailyPathOf rejects dotdot', () => dailyPathOf('..'))

// ---- uniqueDailyPath：平铺之后跨天同名是常态，退让要与 createNote 的幂等早退配合 ----
check('unique path when free', uniqueDailyPath('晨间', () => false), '日记/晨间.md')
check(
  'unique path falls back to 2',
  uniqueDailyPath('晨间', (p) => p === '日记/晨间.md'),
  '日记/晨间 2.md',
)
check(
  'unique path walks to 3',
  uniqueDailyPath('晨间', (p) => p === '日记/晨间.md' || p === '日记/晨间 2.md'),
  '日记/晨间 3.md',
)

// ---- 路径 → 日期：三种历史形态都认（只服务写入端的回填与搬移）----
// 认不全的后果很实在：用户库里躺着的是单文件那版，回填就一篇都补不到，
// 整库日记从日历上无声消失——这正是上一版只认目录形态踩过的坑。
check('accept per-day dir form', isDailyPath('日记/2026-10-10/晨间.md'), true)
check('accept flat file form', isDailyPath('日记/2026-10-10.md'), true)
check('accept root file form', isDailyPath('2026-10-10.md'), true)
check('accept upper ext', isDailyPath('日记/2026-10-10/晨间.MD'), true)
check('accept upper ext on flat', isDailyPath('日记/2026-10-10.MD'), true)
check('accept ascii title', isDailyPath('日记/2026-10-10/morning.md'), true)
check('accept title with space', isDailyPath('日记/2026-10-10/2026-10-10 周六.md'), true)
check('flat file date', dateOfDaily('日记/2026-10-10.md'), '2026-10-10')
check('root file date', dateOfDaily('2026-10-10.md'), '2026-10-10')
// 目录段说了算：标题里再出现一个日期也不会被误判
check('date lives in dir segment', dateOfDaily('日记/2026-10-10/2026-09-09 晨间.md'), '2026-10-10')
// 一天多篇：同一天的两个不同标题归到同一个日期
check(
  'two diaries share one date',
  [dateOfDaily('日记/2026-10-10/晨间.md'), dateOfDaily('日记/2026-10-10/会议.md')],
  ['2026-10-10', '2026-10-10'],
)

// ---- dailyDirDateOf：拍平只搬「日期还赖在目录段上」的那一种 ----
check('dir form is flatten candidate', dailyDirDateOf('日记/2026-10-10/晨间.md'), '2026-10-10')
check('flat form is not a candidate', dailyDirDateOf('日记/2026-10-10.md'), null)
check('root form is not a candidate', dailyDirDateOf('2026-10-10.md'), null)
check('new daily is not a candidate', dailyDirDateOf(dailyPathOf('晨间')), null)
check('wrong dir is not a candidate', dailyDirDateOf('notes/2026-10-10/晨间.md'), null)
check('feb 30 is not a candidate', dailyDirDateOf('日记/2026-02-30/晨间.md'), null)

check('reject wrong dir', isDailyPath('notes/2026-10-10/晨间.md'), false)
check('reject bare filename', isDailyPath('2026-10-10/晨间.md'), false)
check('reject unpadded', isDailyPath('日记/2026-1-5/晨间.md'), false)
check('reject wrong ext', isDailyPath('日记/2026-10-10/晨间.txt'), false)
check('reject prefix bleed', isDailyPath('日记本/2026-10-10/晨间.md'), false)
check('reject no dir slash', isDailyPath('日记2026-10-10/晨间.md'), false)
// 标题段锁在一层里（正则用 `[^/]+`），故深层嵌套天然进不来
check('reject deep nesting', isDailyPath('日记/2026-10-10/上午/晨间.md'), false)
check('reject empty title', isDailyPath('日记/2026-10-10/.md'), false)
check('reject dot title', isDailyPath('日记/2026-10-10/..md'), false)
check('reject dotdot title', isDailyPath('日记/2026-10-10/...md'), false)
check('reject feb 30', isDailyPath('日记/2026-02-30/晨间.md'), false)
check('reject feb 30 on flat', isDailyPath('日记/2026-02-30.md'), false)
check('reject feb 30 on root', isDailyPath('2026-02-30.md'), false)
check('reject month 13', isDailyPath('日记/2026-13-01/晨间.md'), false)
check('reject month 00', isDailyPath('日记/2026-00-10/晨间.md'), false)
check('reject day 00', isDailyPath('日记/2026-10-00/晨间.md'), false)
check('reject day 32', isDailyPath('日记/2026-10-32/晨间.md'), false)
check('accept leap day', isDailyPath('日记/2024-02-29/leap.md'), true)
check('accept leap day on flat', isDailyPath('日记/2024-02-29.md'), true)
check('reject leap day in common year', isDailyPath('日记/2026-02-29/x.md'), false)
check('accept century leap day', isDailyPath('日记/2000-02-29/x.md'), true)
check('reject non-century 1900', isDailyPath('日记/1900-02-29/x.md'), false)
// 日期目录本身不是笔记：它没有文件名段，读进来也不该被当成一篇日记
check('reject the date dir itself', isDailyPath('日记/2026-10-10'), false)
check('dateOfDaily on non-daily', dateOfDaily('notes/a.md'), null)
check('dateOfDaily on feb 30', dateOfDaily('日记/2026-02-30/晨间.md'), null)

// ---- dailyDateOf：日历唯一认可的日期来源（frontmatter 的 date:）----
// 头一条是这次搬家的全部理由：住在日记目录下**再也不是**进日历的充分条件，
// 判定只看文件里的字段——所以「搬走就丢日期」那条路被彻底封死。
check('path alone is not enough', dailyDateOf('# 晨间\n\n今天很忙。'), null)
check('read plain date', dailyDateOf('---\ndate: 2026-10-10\n---\n正文'), '2026-10-10')
check('read date on a note outside 日记/', dailyDateOf('---\ndate: 2026-10-10\n---\n# 周会'), '2026-10-10')
check('block without date', dailyDateOf('---\nid: 20261010\n---\n正文'), null)
check('date hiding in the body is not frontmatter', dailyDateOf('---\nid: x\n---\n建于 date: 2026-10-10'), null)
check('nested map is not top-level', dailyDateOf('---\nmeta:\n  date: 2026-10-10\n---\nx'), null)
check('commented out counts as absent', dailyDateOf('---\n# date: 2026-10-10\n---\nx'), null)
check('list value is not a scalar date', dailyDateOf('---\ndate: [2026-10-10]\n---\nx'), null)
// 带时间与带引号是最常见的两种手写/模板写法，都只取日期段
check('value with time', dailyDateOf('---\ndate: 2026-10-10T09:30\n---\nx'), '2026-10-10')
check('quoted value', dailyDateOf("---\ndate: '2026-10-10'\n---\nx"), '2026-10-10')
check('trailing comment stripped', dailyDateOf('---\ndate: 2026-10-10 # 当天\n---\nx'), '2026-10-10')
// 不存在的日子放进日历，月历上会多出一个永远点不中的格子
check('reject feb 30 in field', dailyDateOf('---\ndate: 2026-02-30\n---\nx'), null)
check('reject month 13 in field', dailyDateOf('---\ndate: 2026-13-01\n---\nx'), null)
check('reject bare year', dailyDateOf('---\ndate: 2026\n---\nx'), null)
check('reject non-date text', dailyDateOf('---\ndate: 昨天\n---\nx'), null)
check('reject empty value', dailyDateOf('---\ndate:\n---\nx'), null)
check('accept leap day in field', dailyDateOf('---\ndate: 2024-02-29\n---\nx'), '2024-02-29')
check('BOM before the block', dailyDateOf('\uFEFF---\ndate: 2026-10-10\n---\nx'), '2026-10-10')
// 字段说了算：路径是 10-10、字段写 10-09，归到字段那天（反之亦然，见下方初始正文）
check('field beats the dir segment', dailyDateOf('---\ndate: 2026-10-09\n---\nx'), '2026-10-09')

// ---- initialDailyContent：新建日记的初始正文，必须自己就能被读回 ----
check('initial content shape', initialDailyContent('2026-10-10'), '---\ndate: 2026-10-10\n---\n')
check('initial content round trip', dailyDateOf(initialDailyContent('2026-10-10')), '2026-10-10')
check('initial content has an empty body', initialDailyContent('2026-10-10').endsWith('---\n'), true)
// 出生即带字段 ⇒ 新建的日记从不依赖回填；回填只服务存量文件
check('initial content is never dateless', dailyDateOf(initialDailyContent('2024-02-29')), '2024-02-29')

// ---- isRealDate：年 0–99 也不会被 Date.UTC 拉到 1900 年代 ----
check('real date ok', isRealDate(2026, 10, 10), true)
check('year 50 stays year 50', isRealDate(50, 2, 29), false)
check('year 4 is leap', isRealDate(4, 2, 29), true)
check('month out of range', isRealDate(2026, 13, 1), false)
check('day out of range', isRealDate(2026, 4, 31), false)

// ---- todayStr：本地时区，绝不能是 toISOString 的 UTC 日 ----
// 两头各钉一个：凌晨 0:30 在 UTC 以东的时区会被 toISOString 退成前一天，
// 年末 23:30 在 UTC 以西的时区会被推到后一天——两个方向都对上才说明取的是本地分量。
check('todayStr local date', todayStr(new Date(2026, 0, 5, 0, 30)), '2026-01-05')
check('todayStr year end', todayStr(new Date(2026, 11, 31, 23, 30)), '2026-12-31')
check('todayStr no time part', /^\d{4}-\d{2}-\d{2}$/.test(todayStr()), true)

// ---- addDays：跨月跨年闰日全靠 UTC 日期运算进位 ----
check('add across month', addDays('2026-10-31', 1), '2026-11-01')
check('sub across month', addDays('2026-11-01', -1), '2026-10-31')
check('add across year', addDays('2026-12-31', 1), '2027-01-01')
check('sub across year', addDays('2026-01-01', -1), '2025-12-31')
check('add leap day', addDays('2024-02-28', 1), '2024-02-29')
check('add skips leap day', addDays('2026-02-28', 1), '2026-03-01')
check('add zero', addDays('2026-10-10', 0), '2026-10-10')
check('add a week', addDays('2026-10-10', 7), '2026-10-17')

// ---- daysInMonth ----
check('jan 31', daysInMonth(2026, 1), 31)
check('apr 30', daysInMonth(2026, 4), 30)
check('feb common 28', daysInMonth(2026, 2), 28)
check('feb leap 29', daysInMonth(2024, 2), 29)
check('feb century non-leap', daysInMonth(1900, 2), 28)

// ---- weekdayOf：0=周一 … 6=周日（月矩阵列序），比 getDay() 少偏一位 ----
check('monday is 0', weekdayOf('2026-01-05'), 0)
check('sunday is 6', weekdayOf('2026-01-11'), 6)
check('weekday beats getDay by one', weekdayOf('2026-01-05') === new Date(2026, 0, 5).getDay() - 1, true)
check('weekday counts', WEEKDAY_NAMES.length, 7)
check('week starts monday', WEEKDAY_NAMES[0], '一')

/** 断言某月矩阵的通用形状：行数公式、周一开头、日期连续、当月恰好各出现一次。 */
function matrixShape(year: number, month1: number, rows: number): void {
  const m = monthMatrix(year, month1)
  check(`${year}-${month1} rows`, m.length, rows)
  check(`${year}-${month1} cells = rows*7`, m.flatMap((r) => r).length, rows * 7)
  check(`${year}-${month1} first is monday`, weekdayOf(m[0][0].date), 0)
  check(`${year}-${month1} last is sunday`, weekdayOf(m[rows - 1][6].date), 6)
  const flat = m.flat()
  check(
    `${year}-${month1} consecutive`,
    flat.every((c, i) => i === 0 || addDays(flat[i - 1].date, 1) === c.date),
    true,
  )
  const inMonth = flat.filter((c) => c.inMonth)
  check(`${year}-${month1} inMonth count`, inMonth.length, daysInMonth(year, month1))
  check(
    `${year}-${month1} inMonth = all days`,
    inMonth.map((c) => c.day),
    Array.from({ length: daysInMonth(year, month1) }, (_, i) => i + 1),
  )
  // 相邻月格子必须标 out：面板靠它灰显，标错会把上月末画成本月头
  check(
    `${year}-${month1} out flags match`,
    flat.every((c) => c.inMonth === c.date.startsWith(`${year}-${String(month1).padStart(2, '0')}`)),
    true,
  )
  // 每一格都能建出一篇属于那一天的日记：路径不再带日期，归日靠初始正文里的 `date:`
  check(
    `${year}-${month1} every cell starts a dated note`,
    flat.every((c) => dailyDateOf(initialDailyContent(c.date)) === c.date),
    true,
  )
  check(
    `${year}-${month1} day numbers from date`,
    flat.every((c) => c.day === Number(c.date.slice(8, 10))),
    true,
  )
}

// 2026-10：10/1 是周四 → 偏移 3、31 天 → 5 行，首格 9/28（周一）
matrixShape(2026, 10, 5)
check('2026-10 first cell', monthMatrix(2026, 10)[0][0].date, '2026-09-28')
check('2026-10 first of month', monthMatrix(2026, 10)[0][3].date, '2026-10-01')
check('2026-10 last cell', monthMatrix(2026, 10)[4][6].date, '2026-11-01')

// 2026-01：跨年收尾（首格落在 2025-12-29）
matrixShape(2026, 1, 5)
check('2026-01 first cell', monthMatrix(2026, 1)[0][0].date, '2025-12-29')

// 2026-02：2/1 是周日 → 偏移 6、28 天 → 5 行
matrixShape(2026, 2, 5)

// 2024-02：闰月，29 天
matrixShape(2024, 2, 5)
check('leap day present', monthMatrix(2024, 2).flat().some((c) => c.date === '2024-02-29'), true)

// 2021-02：2/1 是周一 → 偏移 0、28 天 → 4 行（月矩阵最短的一档）
matrixShape(2021, 2, 4)

// 2025-03：3/1 是周六、31 天 → 偏移 5 + 31 = 36 → 6 行（最长的一档，首格 2/24）
matrixShape(2025, 3, 6)
check('2025-03 first cell', monthMatrix(2025, 3)[0][0].date, '2025-02-24')

// 2026-12 与 2027-01：跨年边界两侧都各自成立
matrixShape(2026, 12, 5)
matrixShape(2027, 1, 5)

// 覆盖一整年：每个月的行数都在 4–6 之间，且长度恒为 7 的倍数
const yearShape = Array.from({ length: 12 }, (_, i) => {
  const m = monthMatrix(2026, i + 1)
  return [m.length, m[0].length]
})
check('2026 all months rows in 4..6 and 7 wide', yearShape.every(([r, w]) => r >= 4 && r <= 6 && w === 7), true)

console.log(`${fail === 0 ? 'OK  ' : 'FAIL'} verify-daily: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
