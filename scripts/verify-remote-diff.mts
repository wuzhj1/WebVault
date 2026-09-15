import type { NoteMeta } from '../src/core/db.ts'
import { findRemoteDeletions, needsRemoteDelete } from '../src/core/sync/remote-diff.ts'

let pass = 0
let fail = 0

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

// ---- needsRemoteDelete ----
check('undefined meta needs no remote delete', needsRemoteDelete(undefined), false)
check('never-pushed note needs no remote delete', needsRemoteDelete(meta('a.md')), false)
check('pushed note needs a remote delete', needsRemoteDelete(meta('a.md', { remoteSha: 'r1' })), true)

// ---- findRemoteDeletions ----
const synced = meta('synced.md', { baseSha: 'b', localSha: 'b', remoteSha: 'r' })
const localOnly = meta('new.md', { baseSha: 'b', localSha: 'b', dirty: 1 })
const tombstone = meta('gone.md', { remoteSha: 'r', removedLocal: 1, cached: 0 })
const alreadyFlagged = meta('flagged.md', { remoteSha: 'r', removedRemote: 1, cached: 0 })
const stillThere = meta('kept.md', { remoteSha: 'r' })

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
check(
  'mixed vault keeps only the real remote deletion',
  findRemoteDeletions([localOnly, tombstone, alreadyFlagged, stillThere, synced], new Set(['kept.md'])).map(
    (n) => n.path,
  ),
  ['synced.md'],
)
check(
  'accepts a Map as the remote path set',
  findRemoteDeletions([synced], new Map([['other.md', 'sha']])).map((n) => n.path),
  ['synced.md'],
)
check('empty vault yields nothing', findRemoteDeletions([], new Set(['a.md'])).length, 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
