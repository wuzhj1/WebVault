/**
 * `.config` 落盘的簿记状态：哪些表脏了、写到第几代、上次失败有没有报过。
 *
 * 为什么单独成模块（而不是继续写在 datafiles.ts 的模块级变量里）：这三样东西合起来
 * 是一个有竞态的小状态机，而 datafiles.ts 依赖 Dexie + OPFS，验证脚本以裸 node 直跑、
 * 装不了 IndexedDB —— 把状态机剥出来，`scripts/verify-flush-state.mts` 才测得到那条
 * 「写在落盘途中发生」的竞态。
 *
 * 三条不变量（对应 verify 用例）：
 * 1. 落盘成功后只有「代次没变」才摘脏标 —— 否则期间的新写入会跟着一起被标成已落盘，
 *    从此再没有任何一次 flush 覆盖它，直到下次有别的写入才被捎上；
 * 2. 落盘失败必定重新标脏，等下一轮重试；
 * 3. 同一张表连续失败只上报第一次，成功一次后重新武装 —— 否则每次防抖、每次页面隐藏
 *    都会再报一遍同一条错误。
 *
 * 硬约束：零导入，不碰 db.ts —— 纯函数状态机，可被验证脚本以裸 node 直接引用。
 */

/** 落盘簿记状态机。每个实例独立，datafiles.ts 里只有一个进程级实例。 */
export interface FlushState {
  /** 表被写入（Dexie 写 hook 回调）：代次 +1 并标脏。 */
  markWrite(table: string): void
  /** 该表是否还有未落盘的写入。 */
  isDirty(table: string): boolean
  /** 落笔前取当前代次，落笔后原样交回 settleOk。 */
  gen(table: string): number
  /**
   * 落笔成功。`gen` 与当前代次一致才摘脏标 —— 不一致说明这次快照没覆盖到期间的写入，
   * 必须留着等下一轮。同时清除「已上报失败」标记，让下一次失败能再报一次。
   */
  settleOk(table: string, gen: number): void
  /** 落笔失败：重新标脏；返回 `true` 表示这是该表当前这一轮的首次失败，应当上报。 */
  settleFail(table: string): boolean
}

/** 建一个独立的落盘簿记实例。 */
export function createFlushState(): FlushState {
  /** 写过后还没落盘的表。 */
  const dirty = new Set<string>()
  /** 每张表的写入代次，只增不减。 */
  const gen = new Map<string, number>()
  /** 已经报过失败的表；成功一次后摘掉。 */
  const failed = new Set<string>()

  return {
    markWrite(table) {
      gen.set(table, (gen.get(table) ?? 0) + 1)
      dirty.add(table)
    },
    isDirty(table) {
      return dirty.has(table)
    },
    gen(table) {
      return gen.get(table) ?? 0
    },
    settleOk(table, before) {
      // 代次变了 = 落盘期间这张表又被写过：快照是旧的，脏标必须留着。
      if ((gen.get(table) ?? 0) === before) dirty.delete(table)
      failed.delete(table)
    },
    settleFail(table) {
      dirty.add(table)
      if (failed.has(table)) return false
      failed.add(table)
      return true
    },
  }
}
