/**
 * 同步引擎与 vault store 共用的纯判定逻辑（谁被远端删了、谁还需要在远端删）。
 * 刻意不碰任何浏览器 API，`NoteMeta` 也只走 `import type`，因此可在 node 下直跑并被断言覆盖。
 *
 * 硬约束：只用相对导入，无 `@/` 别名——一旦被打包进浏览器专用模块，这层的可测性就没了。
 */
import type { NoteMeta } from '../db.ts'

/** 只要求 `has`，方便调用方直接传 Set，也便于测试里塞假集合。 */
export interface PathSet {
  has(path: string): boolean
}

/**
 * 找出「远端曾有、现在树里已经没有」的笔记，即被对端删除的那些。
 *
 * 刻意排除从未推上去过的笔记（`remoteSha === null`）：它们不在远端文件树里只是因为还没上传，
 * 一旦误判为「远端已删」，就会每轮同步都提示用户文件被远端删掉并把它重新传一遍。
 */
export function findRemoteDeletions(local: readonly NoteMeta[], remotePaths: PathSet): NoteMeta[] {
  return local.filter(
    (n) => !n.removedLocal && !n.removedRemote && n.remoteSha !== null && !remotePaths.has(n.path),
  )
}

/** 只有远端确实存过该文件，本地删除/重命名才需要在远端补一次删除。 */
export function needsRemoteDelete(meta: Pick<NoteMeta, 'remoteSha'> | undefined): boolean {
  return meta?.remoteSha != null
}
