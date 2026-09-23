/**
 * 远端删除判定验证（src/core/sync/remote-diff.ts）：
 * - needsRemoteDelete：单条笔记要不要向远端发删除请求——只有推送过（有 remoteSha）的才有东西可删；
 * - findRemoteDeletions：一次同步里找出“远端已消失、本地还认为存在”的笔记，
 *   同时跳过从未推送过的、本地已删的（墓碑）和已经标记过的，避免重复标记与误删。
 *
 * 运行：npm run verify（第 6 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import type { NoteMeta } from '../src/core/db.ts'
import { findRemoteDeletions, needsRemoteDelete } from '../src/core/sync/remote-diff.ts'

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

/** 构造一条默认“已缓存、未同步、未删除”的笔记元数据，patch 覆盖要测的字段。 */
function meta(path: string, patch: Partial<NoteMeta> = {}): NoteMeta {
  return {
    path,
    title: path.replace(/\.md$/, '').split('/').pop() ?? path,
    baseSha: null,
    localSha: null,
    remoteSha: null,
    mtime: 0,
    size: 0,
    dirty: 0,
    cached: 1,
    removedLocal: 0,
    removedRemote: 0,
    ...patch,
  }
}

// ---- needsRemoteDelete：没有 remoteSha 就没有对应远端对象，删除请求只会得到 404 ----
check('undefined meta needs no remote delete', needsRemoteDelete(undefined), false)
check('never-pushed note needs no remote delete', needsRemoteDelete(meta('a.md')), false)
check('pushed note needs a remote delete', needsRemoteDelete(meta('a.md', { remoteSha: 'r1' })), true)

// ---- findRemoteDeletions：以“远端现存路径集合”为基准扫描本地，只有确实推送过又消失的才算 ----
// 先造一批典型状态：已同步、从未推送、本地墓碑、已标记的墓碑、仍在远端的
const synced = meta('synced.md', { baseSha: 'b', localSha: 'b', remoteSha: 'r' })
const localOnly = meta('new.md', { baseSha: 'b', localSha: 'b', dirty: 1 })
const tombstone = meta('gone.md', { remoteSha: 'r', removedLocal: 1, cached: 0 })
const alreadyFlagged = meta('flagged.md', { remoteSha: 'r', removedRemote: 1, cached: 0 })
const stillThere = meta('kept.md', { remoteSha: 'r' })

// 远端快照里只留 kept.md，其余路径都视为“远端已删”
const remote = new Set(['kept.md'])
check(
  'synced note missing from the remote is flagged',
  findRemoteDeletions([synced], remote).map((n) => n.path),
  ['synced.md'],
)
check(
  'synced note still on the remote is left alone',
  findRemoteDeletions([stillThere], remote).map((n) => n.path),
  [],
)
check(
  'never-pushed note is not a remote deletion',
  findRemoteDeletions([localOnly], new Set<string>()).map((n) => n.path),
  [],
)
check(
  'local tombstones are skipped',
  findRemoteDeletions([tombstone], new Set<string>()).map((n) => n.path),
  [],
)
check(
  'already flagged notes are not re-flagged',
  findRemoteDeletions([alreadyFlagged], new Set<string>()).map((n) => n.path),
  [],
)
// 混合库是整个契约的汇总：五条里只有 synced.md 同时满足“推送过 + 不在远端 + 尚未标记”
check(
  'mixed vault keeps only the real remote deletion',
  findRemoteDeletions([localOnly, tombstone, alreadyFlagged, stillThere, synced], new Set(['kept.md'])).map(
    (n) => n.path,
  ),
  ['synced.md'],
)
// 调用方可能传 Map（路径 → sha 的树快照），这里只关心键是否存在
check(
  'accepts a Map as the remote path set',
  findRemoteDeletions([synced], new Map([['other.md', 'sha']])).map((n) => n.path),
  ['synced.md'],
)
check('empty vault yields nothing', findRemoteDeletions([], new Set(['a.md'])).length, 0)

// 汇总：任一断言失败即以非 0 退出
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
