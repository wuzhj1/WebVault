/**
 * 全文检索层：用 MiniSearch 在内存里为整个 vault 建索引，正文来自 OPFS、标签来自 Dexie。
 *
 * 硬约束：只能在浏览器里跑（依赖 `@/core/db.ts` 的 IndexedDB 与 OPFS）；索引是纯派生数据，
 * 任何时候都可从「元数据索引 + OPFS 正文」整体重建，因此不持久化。
 * 索引对象放在模块作用域而非 store 里，好让多个调用方共用同一份，不必各自持一份副本。
 * 增量维护（按 localSha 跳过未变笔记）的状态也一并放在模块作用域，与索引同生命周期。
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
/**
 * 每条已索引文档对应的 `localSha`。增量刷新靠它断定「这篇正文没动过」，从而跳过重读 OPFS ——
 * 没有它，保存一篇就要重扫全库正文（见 ensureIndex）。
 */
const indexedSha = new Map<string, string>()

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
 * 让索引跟上 vault：`revision` 是调用方传来的廉价单调递增量（vault.revision），相等直接短路。
 *
 * revision 变了也只做**增量**更新——先摘掉已删/失效的 id，再只为 `localSha` 变过的笔记重读
 * OPFS，其余文档原样沿用；`localSha` 为空（无从断言内容没变）时才退化为重读。
 * 只有 `invalidateIndex()` 作废后才会整库重建。
 */
export async function ensureIndex(revision: number): Promise<MiniSearch<Doc>> {
  if (index && revision === indexedRevision) return index

  const notes = await db.notes.toArray()
  // 整张标签表只读一次再按 path 分组：原先每篇一次 where('path').equals()，N 篇就是 N+1 次 IDB 往返。
  const tagsByPath = new Map<string, string[]>()
  for (const t of await db.tags.toArray()) {
    const list = tagsByPath.get(t.path)
    if (list) list.push(t.tag)
    else tagsByPath.set(t.path, [t.tag])
  }

  // 墓碑与未下载的 stub 都没有正文可读，只能排除在索引之外（UI 另有「尚未下载」计数提示）。
  const live = notes.filter((n) => n.cached && !n.removedLocal)
  const liveIds = new Set(live.map((n) => n.path))

  const fresh = index ?? createIndex()
  if (index) {
    // 旧文档里已经不存在的（删除、转 stub、墓碑）先摘掉，否则会留下查得到却打不开的幽灵命中。
    for (const id of indexedSha.keys()) {
      if (liveIds.has(id)) continue
      fresh.discard(id)
      indexedSha.delete(id)
    }
  }

  const docs: Doc[] = []
  for (const n of live) {
    if (index && n.localSha && indexedSha.get(n.path) === n.localSha) continue
    const body = (await opfs.readNote(n.path)) ?? ''
    docs.push({ id: n.path, title: n.title, body, tags: (tagsByPath.get(n.path) ?? []).join(' ') })
    if (n.localSha) indexedSha.set(n.path, n.localSha)
    else indexedSha.delete(n.path)
    // 增量更新：同 id 的旧文档先摘再加，replace 不会静默丢掉旧词条。
    if (fresh.has(n.path)) fresh.discard(n.path)
  }
  if (docs.length > 0) fresh.addAll(docs)

  // 先换引用再记 revision：两者之间若有并发读，最坏情况只是多建一次，不会读到半新半旧。
  index = fresh
  indexedRevision = revision
  return fresh
}

/** 作废索引，用于强制下次重建（外部改动未被 revision 变化反映出来的场合）。 */
export function invalidateIndex(): void {
  index = null
  indexedRevision = -1
  indexedSha.clear()
}

/**
 * 索引是否已经恰好建在这个 revision 上。
 *
 * 只要一个排序信号的调用方用它来避免触发 `ensureIndex` —— 后者至少要把元数据与标签表读一遍
 * （增量后已不再全量重读正文）。用户已经搜过时很廉价；否则就跳过文本信号，
 * 这正是「在笔记间来回切换不会变成全库扫描」的原因。
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
