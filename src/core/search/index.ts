/**
 * 全文检索层：用 MiniSearch 在内存里为整个 vault 建索引，正文来自 OPFS、标签来自 Dexie。
 *
 * 硬约束：只能在浏览器里跑（依赖 `@/core/db.ts` 的 IndexedDB 与 OPFS）；索引是纯派生数据，
 * 任何时候都可从「元数据索引 + OPFS 正文」整体重建，因此不持久化。
 * 索引对象放在模块作用域而非 store 里，好让多个调用方共用同一份，不必各自持一份副本。
 */
import MiniSearch, { type SearchResult } from 'minisearch'
import { db } from '@/core/db.ts'
import * as opfs from '@/core/vault/opfs.ts'
import { titleOf } from '@/core/vault/paths.ts'
import { buildExcerpt, tokenize } from './text.ts'

/** 分词与摘要的再导出，保证调用方与索引走的是同一套实现。 */
export { buildExcerpt, tokenize } from './text.ts'

export interface SearchHit {
  path: string
  title: string
  score: number
  /** 命中处上下文摘要；生成时会对每条命中额外读一次 OPFS 正文。 */
  excerpt: string
  /** 标题里确实含查询串 —— 供 UI 把「标题命中」与「仅正文命中」区分开。 */
  matchedTitle: boolean
}

/** 索引文档形状：`id` 即笔记路径，故删除笔记可直接按 id 摘除。 */
interface Doc {
  id: string
  title: string
  body: string
  tags: string
}

let index: MiniSearch<Doc> | null = null
/** 已建索引对应的 revision；-1 表示尚未建立或已被作废。 */
let indexedRevision = -1

function createIndex(): MiniSearch<Doc> {
  return new MiniSearch<Doc>({
    fields: ['title', 'body', 'tags'],
    // 只存 title：结果需要展示标题，而 path 就是 id、正文反正要回读 OPFS，多存只是白占内存。
    storeFields: ['title'],
    tokenize,
    searchOptions: {
      tokenize,
      boost: { title: 5, tags: 3 },
      // 前缀匹配对拉丁词的半截输入有用；对 CJK 的单字/二元组 token 只会增加噪声，故那些保持精确匹配。
      prefix: (term) => term.length >= 2 && /^[a-z0-9_$]/.test(term),
      fuzzy: false,
    },
  })
}

/**
 * vault 有变动就整体重建。`revision` 让调用方传一个廉价的单调递增量，而不必逐篇比对内容。
 * 注：这里是全量重建而非增量 add/remove —— 保存一篇也要重扫所有缓存正文，靠 revision 相等来短路。
 */
export async function ensureIndex(revision: number): Promise<MiniSearch<Doc>> {
  if (index && revision === indexedRevision) return index

  const fresh = createIndex()
  const notes = await db.notes.toArray()
  const docs: Doc[] = []
  for (const n of notes) {
    // 墓碑与未下载的 stub 都没有正文可读，只能排除在索引之外（UI 另有「尚未下载」计数提示）。
    if (n.removedLocal || !n.cached) continue
    const body = (await opfs.readNote(n.path)) ?? ''
    const tags = (await db.tags.where('path').equals(n.path).toArray()).map((t) => t.tag)
    docs.push({ id: n.path, title: n.title, body, tags: tags.join(' ') })
  }
  fresh.addAll(docs)
  // 先换引用再记 revision：两者之间若有并发读，最坏情况只是多建一次，不会读到半新半旧。
  index = fresh
  indexedRevision = revision
  return fresh
}

/** 强制下次 `ensureIndex` 重建，用于外部改动未被 revision 变化反映出来的场合。 */
export function invalidateIndex(): void {
  indexedRevision = -1
}

/**
 * 索引是否已经恰好建在这个 revision 上。
 *
 * 只要一个排序信号的调用方用它来避免触发 `ensureIndex` —— 后者会把每篇缓存正文从 OPFS 读一遍。
 * 用户已经搜过时很廉价；否则就跳过文本信号，这正是「在笔记间来回切换不会变成全库扫描」的原因。
 */
export function hasIndex(revision: number): boolean {
  return index !== null && indexedRevision === revision
}

/** 只返回带分数的 id —— 不做摘要，因此每条命中不会二次读 OPFS。 */
export async function searchIds(
  query: string,
  revision: number,
  limit = 60,
): Promise<{ id: string; score: number }[]> {
  const q = query.trim()
  if (q === '') return []
  const idx = await ensureIndex(revision)
  return idx
    .search(q)
    .slice(0, limit)
    .map((r) => ({ id: String(r.id), score: r.score }))
}

/** 带摘要的完整搜索：先按分数截断到 limit，再只为留下的若干条读正文，避免全库二次扫描。 */
export async function search(query: string, revision: number, limit = 40): Promise<SearchHit[]> {
  const q = query.trim()
  if (q === '') return []
  const idx = await ensureIndex(revision)
  const results: SearchResult[] = idx.search(q)

  const hits: SearchHit[] = []
  for (const r of results.slice(0, limit)) {
    const path = String(r.id)
    // 回退到 titleOf：正文未缓存或 storeFields 缺失时，标题仍能从路径确定地推出来。
    const title = (r.title as string | undefined) ?? titleOf(path)
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
