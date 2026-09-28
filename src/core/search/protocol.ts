/**
 * 搜索「主线程 ↔ Worker」的消息契约。
 *
 * 拆分依据:索引构建(addAll 的分词与倒排)与 search() 都是纯 CPU,大库上会卡住输入和
 * 滚动,必须离开主线程;而 Dexie(IndexedDB)读取与 OPFS 正文读取是异步 I/O,留在主线程
 * 本来就不阻塞渲染——OPFS 的异步 `navigator.storage.getDirectory()` 在 Worker 里的浏览器
 * 覆盖面反而不完整,搬过去会把搜索变成兼容性风险。所以:主线程负责读,Worker 负责算。
 *
 * 双方都只从本文件取类型;postMessage 载荷只含纯数据(结构化克隆),不携带类实例。
 */
/** 一条待入索引的文档;`id` 即笔记路径,删除与摘除都按 id 进行。 */
export interface IndexDoc {
  id: string
  title: string
  body: string
  tags: string
}

/** 查询命中的最小载荷:标题来自索引的 storeFields,摘要由主线程回读正文生成,故不随消息传递。 */
export interface QueryHit {
  id: string
  /** 索引 storeFields 里的标题;缺失时主线程回退 titleOf(path)。 */
  title?: string
  score: number
}

export type MainToWorker =
  /** 差量同步:先摘 removes,再逐条「discard + add」upserts —— discard 在前,旧词条才不会残留。 */
  | { type: 'sync'; upserts: IndexDoc[]; removes: string[] }
  /** 查询:reqId 关联请求与响应,允许在途多发(面板防抖后的最新一次顶掉旧的)。 */
  | { type: 'query'; reqId: number; q: string; limit: number }

export type WorkerToMain =
  | { type: 'query'; reqId: number; hits: QueryHit[] }
  /**
   * 带 reqId = 只有这次查询失败,拒绝对应 Promise 即可;
   * 不带 reqId = 同步在 Worker 内炸了,主线程会终止整个 Worker 并清账重建(下次全量重发)。
   */
  | { type: 'error'; reqId?: number; message: string }
