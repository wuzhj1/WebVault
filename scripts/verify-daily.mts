/**
 * 日历纯函数验证（src/core/daily.ts）：
 * - 路径契约：日记只认 `日记/YYYY-MM-DD.md`（大小写不敏感的扩展名，对齐 paths.ts 口径），
 *   日期必须真实存在——`2026-02-30`、`2026-13-01` 一律拒收，否则徽标会点亮一个造不出来的文件；
 * - 本地日：`todayStr` 走 getFullYear/getMonth/getDate，UTC+8 的 0–8 点不能退成前一天
 *   （与 toISOString 的 UTC 日对照钉死这一点）；
 * - 日期运算：addDays 跨月/跨年/闰日，daysInMonth 与闰年（2024-02 = 29 天）；
 * - 星期口径：weekdayOf 是 0=周一…6=周日（月矩阵列序），比 JS 的 getDay() 少偏一位；
 * - 月矩阵：周一开头、行数 = ceil((首日偏移 + 当月天数) / 7) 即 4–6 行、首尾格可跨相邻月
 *   且 inMonth 标记正确、当月每一天恰好出现一次——这是日历面板渲染与方向键漫游的地基。
 *
 * 运行：pnpm verify（第 17 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import {
  DAILY_DIR,
  WEEKDAY_NAMES,
  addDays,
  dailyPathOf,
  dateOfDaily,
  daysInMonth,
  isDailyPath,
  isRealDate,
  monthMatrix,
  todayStr,
  weekdayOf,
} from '../src/core/daily.ts'

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

// ---- 目录常量与往返 ----
check('DAILY_DIR is 日记', DAILY_DIR, '日记')
check('path round trip', dateOfDaily(dailyPathOf('2026-10-10')), '2026-10-10')
check('dailyPathOf shape', dailyPathOf('2026-01-05'), '日记/2026-01-05.md')

// ---- 严格路径契约：目录、补零、扩展名、真实日期，缺一不可 ----
check('accept normal', isDailyPath('日记/2026-10-10.md'), true)
check('accept upper ext', isDailyPath('日记/2026-10-10.MD'), true)
check('reject wrong dir', isDailyPath('notes/2026-10-10.md'), false)
check('reject subdir', isDailyPath('日记/2026/10-10.md'), false)
check('reject bare filename', isDailyPath('2026-10-10.md'), false)
check('reject unpadded', isDailyPath('日记/2026-1-5.md'), false)
check('reject wrong ext', isDailyPath('日记/2026-10-10.txt'), false)
check('reject prefix bleed', isDailyPath('日记本/2026-10-10.md'), false)
check('reject no dir slash', isDailyPath('日记2026-10-10.md'), false)
check('reject feb 30', isDailyPath('日记/2026-02-30.md'), false)
check('reject month 13', isDailyPath('日记/2026-13-01.md'), false)
check('reject month 00', isDailyPath('日记/2026-00-10.md'), false)
check('reject day 00', isDailyPath('日记/2026-10-00.md'), false)
check('reject day 32', isDailyPath('日记/2026-10-32.md'), false)
check('accept leap day', isDailyPath('日记/2024-02-29.md'), true)
check('reject leap day in common year', isDailyPath('日记/2026-02-29.md'), false)
check('accept century leap day', isDailyPath('日记/2000-02-29.md'), true)
check('reject non-century 1900', isDailyPath('日记/1900-02-29.md'), false)
check('dateOfDaily on non-daily', dateOfDaily('notes/a.md'), null)
check('dateOfDaily on feb 30', dateOfDaily('日记/2026-02-30.md'), null)

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
  // 每一格的日期都是合法日记路径——方向键漫游到哪都能建文件
  check(`${year}-${month1} every cell is daily path`, flat.every((c) => isDailyPath(dailyPathOf(c.date))), true)
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
