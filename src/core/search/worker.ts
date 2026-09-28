/**
 * 搜索索引 Worker:MiniSearch 实例的唯一居所,只做两件事——按差量维护索引、执行查询。
 *
 * 账本(同步到哪个 revision、每篇的 localSha)在主线程(index.ts 的门面),Worker 收到的
 * 消息都是无状态指令:sync 直接落差量,query 立刻回结果。这样 Worker 挂掉时主线程只要
 * 清账重建即可,不存在两边状态对不齐要对账的问题。
 *
 * 消息协议见 protocol.ts;任何异常都回 error 消息而不是让 Worker 带病运行 ——
 * 主线程收到无 reqId 的 error 会 terminate 本 Worker 并整库重发。
 */
import MiniSearch from 'minisearch'
import type { IndexDoc, MainToWorker, QueryHit, WorkerToMain } from './protocol.ts'
import { tokenize } from './text.ts'

/**
 * Worker 侧全局作用域:只声明用到的两个成员。
 * 不引入 webworker lib——它与本项目的 DOM lib 在 `self` 等全局上互相冲突。
 */
const scope = self as unknown as {
  postMessage(message: WorkerToMain): void
  onmessage: ((event: MessageEvent<MainToWorker>) => void) | null
}

let index: MiniSearch<IndexDoc> | null = null

function ensureIndex(): MiniSearch<IndexDoc> {
  if (index) return index
  index = new MiniSearch<IndexDoc>({
    fields: ['title', 'body', 'tags'],
    // 只存 title:结果需要展示标题,而 path 就是 id、正文反正要主线程回读,多存只是白占内存。
    storeFields: ['title'],
    tokenize,
    searchOptions: {
      tokenize,
      boost: { title: 5, tags: 3 },
      // 前缀匹配对拉丁词的半截输入有用;对 CJK 的单字/二元组 token 只会增加噪声,故那些保持精确匹配。
      prefix: (term) => term.length >= 2 && /^[a-z0-9_$]/.test(term),
      fuzzy: false,
    },
  })
  return index
}

scope.onmessage = (event: MessageEvent<MainToWorker>): void => {
  const msg = event.data
  try {
    if (msg.type === 'sync') {
      const idx = ensureIndex()
      // 先摘后加,顺序不能反:摘除晚于添加会把刚写入的同 id 文档一起丢掉。
      for (const id of msg.removes) {
        if (idx.has(id)) idx.discard(id)
      }
      for (const doc of msg.upserts) {
        if (idx.has(doc.id)) idx.discard(doc.id)
      }
      if (msg.upserts.length > 0) idx.addAll(msg.upserts)
      return
    }

    const hits: QueryHit[] = ensureIndex()
      .search(msg.q)
      .slice(0, msg.limit)
      .map((r) => ({ id: String(r.id), title: r.title as string | undefined, score: r.score }))
    const reply: WorkerToMain = { type: 'query', reqId: msg.reqId, hits }
    scope.postMessage(reply)
  } catch (err) {
    const reply: WorkerToMain = {
      type: 'error',
      reqId: msg.type === 'query' ? msg.reqId : undefined,
      message: err instanceof Error ? err.message : String(err),
    }
    scope.postMessage(reply)
  }
}
