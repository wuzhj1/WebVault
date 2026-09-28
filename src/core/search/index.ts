/**
 * 全文检索层(门面):Dexie/OPFS 的 I/O 留在主线程,MiniSearch 的算力下沉到 Worker。
 *
 * 分工:
 * - 本文件(主线程):按 vault.revision 算差量——读元数据与标签表、只为 localSha 变过的笔记
 *   重读 OPFS,把 {upserts, removes} 发给 Worker;命中后的摘要也在这里回读正文生成。
 * - worker.ts(Worker):唯一持有 MiniSearch 索引,执行 addAll/discard 与 search()——
 *   这两件是纯 CPU,大库上会卡住输入与渲染(见 protocol.ts 里「为什么不把 I/O 也搬过去」)。
 *
 * 生命周期与容错:Worker 惰性拉起、常驻复用;主线程的账本(indexedSha/syncedRevision)与
 * Worker 实例绑定在同一 generation 上——Worker 崩溃或收到无 reqId 的 error 时整套作废清零,
 * 下一次 search() 拉新 Worker 并整库重发,宁可多读一遍也不让「账记着、索引没有」的错位留存。
 * 索引是纯派生数据,任何时候都能从「元数据 + OPFS 正文」整体重建,故不持久化。
 */
import { db } from '@/core/db.ts'
import * as opfs from '@/core/vault/opfs.ts'
import { titleOf } from '@/core/vault/paths.ts'
import type { IndexDoc, MainToWorker, QueryHit, WorkerToMain } from './protocol.ts'
import { buildExcerpt } from './text.ts'

export interface SearchHit {
  path: string
  title: string
  score: number
  /** 命中处上下文摘要;生成时会对每条命中额外读一次 OPFS 正文。 */
  excerpt: string
  /** 标题里确实含查询串 —— 供 UI 把「标题命中」与「仅正文命中」区分开。 */
  matchedTitle: boolean
}

/** 常驻的 Worker 实例;null 表示尚未拉起或已被作废。 */
let worker: Worker | null = null
/**
 * Worker 代次:每次「作废重建」自增。在途的差量同步在 await 恢复后先比代次,
 * 对不上就整体丢弃——差量属于已死的旧实例,新实例的账本已清空、将由整库重发补齐。
 */
let generation = 0
/** 账本:已同步到的 revision;相等即短路,连消息都不发。-1 = 未同步或已作废。 */
let syncedRevision = -1
/**
 * 每条已同步文档对应的 `localSha`。增量靠它断定「这篇正文没动过」从而跳过重读 OPFS ——
 * 没有它,保存一篇就要重扫全库正文。
 */
const indexedSha = new Map<string, string>()
/** 在途查询:reqId → Promise 两端;Worker 按 reqId 回包,坏掉的 Worker 拒掉全部。 */
const pending = new Map<number, { resolve: (hits: QueryHit[]) => void; reject: (reason: unknown) => void }>()
let reqSeq = 0
/**
 * 同步链:所有 doSync 串成一条队列,并发的 search() 各追加一段,读表与发消息天然不交叠。
 * 前一段失败也不堵后一段(两个回调都落 doSync);失败本身会冒给 await 方,由面板记日志。
 */
let syncChain: Promise<void> = Promise.resolve()

/** 拉起 Worker 并挂好收发;重复调用复用同一实例。 */
function ensureWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (event: MessageEvent<WorkerToMain>) => {
    const msg = event.data
    if (msg.type === 'query') {
      const waiter = pending.get(msg.reqId)
      if (waiter) {
        pending.delete(msg.reqId)
        waiter.resolve(msg.hits)
      }
      return
    }
    const reason = new Error(`search worker: ${msg.message}`)
    if (msg.reqId !== undefined) {
      // 只挂掉这一次查询:同步之外的偶发失败不该连坐整库索引。
      const waiter = pending.get(msg.reqId)
      if (waiter) {
        pending.delete(msg.reqId)
        waiter.reject(reason)
      }
    } else {
      failWorker(reason)
    }
  }
  w.onerror = () => failWorker(new Error('search worker 异常退出'))
  worker = w
  return w
}

/**
 * 作废整套状态:终止 Worker、清账本、拒绝所有在途查询。
 * 「状态对不上就重建」永远比修补便宜——下一次 search() 会拉新 Worker 并整库重发。
 */
function failWorker(reason: Error): void {
  generation++
  worker?.terminate()
  worker = null
  syncedRevision = -1
  indexedSha.clear()
  for (const waiter of pending.values()) waiter.reject(reason)
  pending.clear()
}

/** 把 revision 的差量排队同步;返回的 Promise 落定时,该 revision 已可安全查询。 */
function syncIndex(revision: number): Promise<void> {
  syncChain = syncChain.then(
    () => doSync(revision),
    () => doSync(revision),
  )
  return syncChain
}

async function doSync(revision: number): Promise<void> {
  if (revision === syncedRevision) return
  const gen = generation
  const w = ensureWorker()

  const notes = await db.notes.toArray()
  // 整张标签表只读一次再按 path 分组:原先每篇一次 where('path').equals(),N 篇就是 N+1 次 IDB 往返。
  const tagsByPath = new Map<string, string[]>()
  for (const t of await db.tags.toArray()) {
    const list = tagsByPath.get(t.path)
    if (list) list.push(t.tag)
    else tagsByPath.set(t.path, [t.tag])
  }

  // 墓碑与未下载的 stub 都没有正文可读,只能排除在索引之外(UI 另有「尚未下载」计数提示)。
  const live = notes.filter((n) => n.cached && !n.removedLocal)
  const liveIds = new Set(live.map((n) => n.path))

  // 旧账里已经不存在的(删除、转 stub、墓碑)先摘,否则 Worker 会留下查得到却打不开的幽灵命中。
  const removes: string[] = []
  for (const id of indexedSha.keys()) {
    if (liveIds.has(id)) continue
    removes.push(id)
    indexedSha.delete(id)
  }

  const upserts: IndexDoc[] = []
  for (const n of live) {
    // localSha 为空表示无从断言内容没变,退化为重读。
    if (n.localSha && indexedSha.get(n.path) === n.localSha) continue
    const body = (await opfs.readNote(n.path)) ?? ''
    upserts.push({ id: n.path, title: n.title, body, tags: (tagsByPath.get(n.path) ?? []).join(' ') })
    if (n.localSha) indexedSha.set(n.path, n.localSha)
    else indexedSha.delete(n.path)
  }

  // 中途被作废(generation 变了):差量属于旧实例,丢弃;新实例账本已清空,整库重发会补齐。
  if (gen !== generation) return

  if (upserts.length > 0 || removes.length > 0) {
    const msg: MainToWorker = { type: 'sync', upserts, removes }
    w.postMessage(msg)
  }
  // 先发消息再记账:同一条消息队列里查询必排在它后面,不会查到没同步完的索引。
  syncedRevision = revision
}

/** 向 Worker 发起查询,按 reqId 关联回包;Worker 阵亡时由 failWorker 整体拒绝。 */
function requestQuery(q: string, limit: number): Promise<QueryHit[]> {
  const w = ensureWorker()
  const reqId = ++reqSeq
  return new Promise((resolve, reject) => {
    pending.set(reqId, { resolve, reject })
    const msg: MainToWorker = { type: 'query', reqId, q, limit }
    w.postMessage(msg)
  })
}

/**
 * 带摘要的完整搜索:先同步索引到给定 revision,再问 Worker 要分数排名,
 * 最后只为留下的至多 `limit` 条回读正文生成摘要,避免全库二次扫描。
 */
export async function search(query: string, revision: number, limit = 40): Promise<SearchHit[]> {
  const q = query.trim()
  if (q === '') return []
  await syncIndex(revision)
  const results = await requestQuery(q, limit)

  const hits: SearchHit[] = []
  for (const r of results) {
    const path = r.id
    // 回退到 titleOf:storeFields 缺失时,标题仍能从路径确定地推出来。
    const title = r.title ?? titleOf(path)
    const body = (await opfs.readNote(path)) ?? ''
    hits.push({
      path,
      title,
      score: r.score,
      excerpt: buildExcerpt(body, q),
      matchedTitle: title.toLowerCase().includes(q.toLowerCase()),
    })
  }
  return hits
}
