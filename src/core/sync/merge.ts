/**
 * 三方合并：以「共同祖先 / 本地 / 远端」三份文本判定该保留谁，以及怎么合。
 *
 * 两条硬约束：
 * 1. 只依赖 node-diff3，不导入浏览器 API（IndexedDB / OPFS / Pinia 一律不碰），可单测也可在 node 下直跑。
 * 2. 只用相对导入（`import type` 同理），无 `@/` 别名。
 */
import { diff3Merge } from 'node-diff3'

/** 合并结论。`conflict` 表示两侧都改过且无法自动重合，不代表一定丢东西。 */
export type MergeStatus = 'unchanged' | 'local-only' | 'remote-only' | 'merged' | 'conflict'

export interface MergeOutcome {
  status: MergeStatus
  /** 本地该留的文本。冲突时是未经改动的原始本地文本，绝不含冲突标记。 */
  text: string
  /** 仅冲突时给出远端文本，调用方据此另存一份 `.conflict-<stamp>.md` 副本。 */
  remoteText?: string
  /** 无法自动解决的 hunk 数量，用于统计与提示。 */
  conflicts: number
}

/**
 * 只凭三个 blob sha 判定该走哪条分支，完全不下载内容——这是「先索引后正文」省请求的关键。
 * `baseSha` 是上次同步成功时记下的共同祖先。
 * 注意：两侧都相对祖先变过就直接判 `conflict`，这里不尝试合并；真正的行级合并交给 threeWayMerge。
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
 * 行级三方合并。三份文本先各自等值比较，能一眼定论的就不要交给 diff3；其余才逐 hunk 重合。
 *
 * 硬约束：node-diff3 对字符串默认按 `/\s+/` 切分，会把换行整个抹掉、连带毁掉 markdown 结构，
 * 因此这里必须传 string[]（按 `\n` 切）再自行 join('\n')。
 */
export function threeWayMerge(local: string, base: string, remote: string): MergeOutcome {
  if (local === remote) return { status: 'merged', text: local, conflicts: 0 }
  if (local === base) return { status: 'remote-only', text: remote, conflicts: 0 }
  if (remote === base) return { status: 'local-only', text: local, conflicts: 0 }

  const regions = diff3Merge(local.split('\n'), base.split('\n'), remote.split('\n'), {
    // 两侧相对祖先做了相同改动时不算冲突（假冲突），直接采信，少制造无谓的冲突副本。
    excludeFalseConflicts: true,
  })

  let conflicts = 0
  const out: string[] = []
  for (const region of regions) {
    if (region.ok) {
      out.push(...region.ok)
    } else if (region.conflict) {
      conflicts++
      // 只把本地侧就地留下；远端侧另存冲突副本，而不是内联 `<<<<<<<` 标记，
      // 否则一篇正常笔记会被同步过程静默改坏。
      out.push(...region.conflict.a)
    }
  }

  // 全部 hunk 都能合 → 合成文本即结果；存在无法自动解决的 hunk 时不吐任何合成文本，
  // 交由调用方按「本地原样保留、远端另存冲突副本」处理。
  if (conflicts === 0) return { status: 'merged', text: out.join('\n'), conflicts: 0 }
  return { status: 'conflict', text: local, remoteText: remote, conflicts }
}
