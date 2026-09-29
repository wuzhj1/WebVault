/**
 * 落盘簿记验证（src/core/vault/flush-state.ts）：
 * - 脏标与代次：写入即标脏、代次单调；
 * - 竞态：落盘「途中」发生的新写入不能被 settleOk 一并摘掉脏标 —— 那条路径上的数据
 *   会从此没有任何一次 flush 覆盖它，是静默丢数据；
 * - 失败上报：连续失败只报第一次，成功一次后重新武装；
 * - 端到端模拟：按 datafiles.doFlush 的真实调用顺序（取代次 → 快照 → 写文件 → settle）
 *   跑一遍，断言两轮之后文件内容与表内容逐字节一致。
 *
 * 运行：pnpm verify（第 12 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import { createFlushState } from '../src/core/vault/flush-state.ts'

let pass = 0
let fail = 0

/** 用 JSON 序列化后比较，失败时打印 expected/actual 差异。 */
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`)
  }
}

function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else {
    fail++
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ''}`)
  }
}

// ---- 基本事实：写入即标脏，代次只增不减 ----
const s1 = createFlushState()
check('fresh state is clean', s1.isDirty('notes'), false)
s1.markWrite('notes')
check('write marks dirty', s1.isDirty('notes'), true)
const g1 = s1.gen('notes')
s1.markWrite('notes')
ok('gen only grows', s1.gen('notes') > g1)
check('unrelated table unaffected', s1.isDirty('tags'), false)

// ---- 干净收尾：代次没变才摘脏标 ----
const s2 = createFlushState()
s2.markWrite('notes')
const g2 = s2.gen('notes')
s2.settleOk('notes', g2)
check('settleOk with unchanged gen clears dirty', s2.isDirty('notes'), false)

// ---- 竞态核心：落盘途中又写了一次 ----
const s3 = createFlushState()
s3.markWrite('notes')
const g3 = s3.gen('notes')
// 模拟「rows 已经读出来、文件还没写完」的窗口内发生的新写入
s3.markWrite('notes')
s3.settleOk('notes', g3)
check('write during flush keeps dirty', s3.isDirty('notes'), true)
// 下一轮必须能把这轮漏掉的写入落下去
const g3b = s3.gen('notes')
s3.settleOk('notes', g3b)
check('a clean follow-up round does clear dirty', s3.isDirty('notes'), false)

// ---- 竞态：多次写入、代次连跳同样不能被摘掉 ----
const s4 = createFlushState()
s4.markWrite('links')
const g4 = s4.gen('links')
s4.markWrite('links')
s4.markWrite('links')
s4.settleOk('links', g4)
check('multiple writes during flush keep dirty', s4.isDirty('links'), true)

// ---- 失败：必定重新标脏，且只报第一次 ----
const s5 = createFlushState()
s5.markWrite('tags')
const g5 = s5.gen('tags')
s5.settleOk('tags', g5)
check('prepped clean before failure', s5.isDirty('tags'), false)
check('first failure reports', s5.settleFail('tags'), true)
check('failure re-marks dirty', s5.isDirty('tags'), true)
check('second failure is silent', s5.settleFail('tags'), false)
check('third failure is silent', s5.settleFail('tags'), false)

// ---- 成功一次即重新武装：下一次失败要能再报一次 ----
const g5b = s5.gen('tags')
s5.settleOk('tags', g5b)
check('recovery clears dirty', s5.isDirty('tags'), false)
check('failure after recovery reports again', s5.settleFail('tags'), true)

// ---- 摘脏标不能顺带把失败标记也留着：成功即 disarms ----
const s6 = createFlushState()
s6.markWrite('cards')
s6.settleFail('cards')
s6.settleOk('cards', s6.gen('cards'))
check('settleOk after failure clears dirty', s6.isDirty('cards'), false)
check('settleOk disarms the failure latch', s6.settleFail('cards'), true)

/**
 * 端到端模拟 datafiles.doFlush 的真实顺序：
 *   gen = state.gen() → rows = 读表 → 写文件 → state.settleOk(gen)
 * `table` 是「表内容」，`file` 是「落盘后的内容」，`gate` 用来在写文件的窗口里插一次写入。
 */
async function flushOnce(
  table: string[],
  file: string[],
  state: ReturnType<typeof createFlushState>,
  duringWrite?: () => void,
): Promise<void> {
  const gen = state.gen('notes')
  const snapshot = [...table]
  // 这里刻意留一个真实的异步间隙 —— 竞态就发生在这两行之间
  await Promise.resolve()
  duringWrite?.()
  file.length = 0
  file.push(...snapshot)
  state.settleOk('notes', gen)
}

// 场景 A：落盘期间没有新写入，一轮收工
{
  const table = ['a']
  const file: string[] = []
  const state = createFlushState()
  state.markWrite('notes')
  await flushOnce(table, file, state)
  check('scenario A: file matches table', file, table)
  check('scenario A: clean after one round', state.isDirty('notes'), false)
}

// 场景 B：落盘期间又写了一行 —— 第一轮必然漏掉它，脏标必须留着，第二轮补上
{
  const table = ['a']
  const file: string[] = []
  const state = createFlushState()
  state.markWrite('notes')
  await flushOnce(table, file, state, () => {
    table.push('b')
    state.markWrite('notes')
  })
  check('scenario B: first round misses the concurrent write', file, ['a'])
  check('scenario B: still dirty after settling', state.isDirty('notes'), true)
  await flushOnce(table, file, state)
  check('scenario B: second round catches up', file, table)
  check('scenario B: clean after catch-up', state.isDirty('notes'), false)
}

// 场景 C：脏标一旦被错摘，后续写入永远追不上 —— 反证 settleOk 必须比对代次
{
  const table: string[] = []
  const file: string[] = []
  const state = createFlushState()
  state.markWrite('notes')
  // 故意传一个过期的代次（模拟「不比对代次」的错误实现）
  state.settleOk('notes', state.gen('notes') - 1)
  check('scenario C: stale gen never clears dirty', state.isDirty('notes'), true)
  await flushOnce(table, file, state)
  check('scenario C: eventually converges', state.isDirty('notes'), false)
}

console.log(`${fail === 0 ? 'OK  ' : 'FAIL'} verify-flush-state: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
