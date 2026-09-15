import { diff3Merge } from 'node-diff3'

export type MergeStatus = 'unchanged' | 'local-only' | 'remote-only' | 'merged' | 'conflict'

export interface MergeOutcome {
  status: MergeStatus
  /** Text to keep locally. On conflict this is the untouched local text. */
  text: string
  /** Remote text, set only on conflict so the caller can write a conflict copy. */
  remoteText?: string
  /** How many hunks could not be auto-resolved. */
  conflicts: number
}

/**
 * Decide what to do from the three blob shas alone, before touching any content.
 * `base` is the common ancestor recorded at the last successful sync.
 */
export function classifySync(
  localSha: string | null,
  baseSha: string | null,
  remoteSha: string | null,
): MergeStatus {
  if (localSha === remoteSha) return 'unchanged'
  const localChanged = localSha !== baseSha
  const remoteChanged = remoteSha !== baseSha
  if (localChanged && remoteChanged) return 'conflict'
  if (localChanged) return 'local-only'
  if (remoteChanged) return 'remote-only'
  return 'unchanged'
}

/**
 * Line-based three-way merge.
 *
 * node-diff3 defaults to splitting strings on `/\s+/`, which would flatten newlines and
 * mangle markdown, so lines are passed as arrays and rejoined here.
 */
export function threeWayMerge(local: string, base: string, remote: string): MergeOutcome {
  if (local === remote) return { status: 'merged', text: local, conflicts: 0 }
  if (local === base) return { status: 'remote-only', text: remote, conflicts: 0 }
  if (remote === base) return { status: 'local-only', text: local, conflicts: 0 }

  const regions = diff3Merge(local.split('\n'), base.split('\n'), remote.split('\n'), {
    excludeFalseConflicts: true,
  })

  let conflicts = 0
  const out: string[] = []
  for (const region of regions) {
    if (region.ok) {
      out.push(...region.ok)
    } else if (region.conflict) {
      conflicts++
      // Keep the local side in place; the remote side goes to a conflict copy instead of
      // being inlined as markers, so a note is never silently corrupted.
      out.push(...region.conflict.a)
    }
  }

  if (conflicts === 0) return { status: 'merged', text: out.join('\n'), conflicts: 0 }
  return { status: 'conflict', text: local, remoteText: remote, conflicts }
}
