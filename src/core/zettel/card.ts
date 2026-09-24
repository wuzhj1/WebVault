/**
 * 卡片盒功能已彻底移除；本模块只保留链接层兼容所需的最小集合。
 *
 * 旧库里已有卡片 frontmatter（`id`/`type`/`created`），且正文里存在 `[[202609151423]]`
 * 形式的永久 ID 双链。ID 双链的解析数据源是 `db.cards` 表（schema 冻结，只作派生索引），
 * 而这张表的每一行由 `cardFromBody` 从文件派生——所以「从 frontmatter 读出 id/type/tags」
 * 这条链路必须原样保留，否则老笔记的 `[[id]]` 链接会集体失联。
 *
 * id 住在 frontmatter 里而不是文件名里，因此用户改文件名不影响 `[[id]]` 解析（文件名清洗
 * 与路径拼接已迁至 `../vault/paths.ts`，那里也是本模块曾经的反向依赖方，循环导入就此消除）。
 *
 * 两条硬约束（违反即静默失效）：
 * 1. 只用相对导入，`scripts/verify-frontmatter.mts` 以 plain node 直跑，没有别名解析器。
 * 2. `../db.ts` 只做类型导入——它在模块作用域构造 Dexie，在浏览器之外会抛错。
 */
import type { CardRow, TagRow } from '../db.ts'
import { parseFrontmatter, readList, readScalar, type Frontmatter } from '../parse/frontmatter.ts'
import { parseNote, type ParsedTag } from '../parse/links.ts'

/** 旧卡片的分类；`plain` 只出现在读取端，见 `CARD_TYPES`。 */
export type CardType = 'plain' | 'fleeting' | 'literature' | 'permanent' | 'index'

/**
 * 可写进 frontmatter 的类型。列表里没有 `plain`：它是「一张没有任何可用元数据的笔记」
 * 上报出来的值，从来不会被写进文件。
 */
export const CARD_TYPES = ['fleeting', 'literature', 'permanent', 'index'] as const

/** zid 的形状：12 位本地 `YYYYMMDDHHmm`，再跟至多 3 个字母后缀。 */
const ZID = /^\d{12}[a-z]{0,3}$/

/** 接受 `202609151423`、`202609151423a`。不接受 `202609151423-1`：连字符会让 id 读起来像两个词。 */
export function isZid(value: string): boolean {
  return ZID.test(value)
}

/** 判断字符串是否是可写入 frontmatter 的卡片类型（不含 `plain`）。 */
export function isCardType(value: string): value is CardType {
  return (CARD_TYPES as readonly string[]).includes(value)
}

/**
 * 用于排序的 epoch 毫秒；缺失或解析不出来时返回 0，好让顺序保持确定。
 * 尾部带 `Z` 或显式时区偏移的按 UTC 解析；其余一律按写入这个时间戳时的本地挂钟。
 */
export function parseCreated(raw: string): number {
  const text = raw.trim()
  if (text === '') return 0
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const utc = Date.parse(text)
    return Number.isNaN(utc) ? 0 : utc
  }
  // 秒是可选的：手写或从别处拷来的 created 常常只精确到分钟，缺的分量一律按 0 补。
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/)
  if (!m) return 0
  const local = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
  ).getTime()
  return Number.isNaN(local) ? 0 : local
}

/**
 * 一篇笔记正文对应的索引行。
 *
 * 每篇笔记都会有一行，不只是卡片：`parsed` 是可续跑的回填用来判断自己读到哪儿的依据，而「这不是一张
 * 卡片」只有在和「还没读过」同样都有行的情况下才区分得出来。`type: 'plain'` 表示这篇不是卡片。
 *
 * `fm` / `bodyTags` 是可选的复用位：`reindexContent` 保存一篇正文时本来就要解析 frontmatter 与
 * `parseNote`，把结果传进来即可，同一篇不再解析两遍；不传则各自现算，老调用方行为不变。
 */
export function cardFromBody(
  path: string,
  content: string,
  fm: Frontmatter = parseFrontmatter(content),
  bodyTags: readonly ParsedTag[] = parseNote(content).tags,
): CardRow {
  const id = readScalar(fm, 'id') ?? ''
  const type = readScalar(fm, 'type') ?? ''
  const createdRaw = readScalar(fm, 'created') ?? ''

  const merged = mergeTags(bodyTags, readList(fm, 'tags'))

  return {
    path,
    // 一个不成其为 zid 的 id 属于别人的标识符。把它挡在索引之外，好过让它在按 zid 查表时与真 id 相撞。
    zid: isZid(id) ? id : '',
    type: isCardType(type) ? type : 'plain',
    created: parseCreated(createdRaw),
    createdRaw,
    aliases: readList(fm, 'aliases'),
    tags: merged,
    parsed: 1,
  }
}

/**
 * 正文没有提供的那些 frontmatter 标签，作为附加行落在 line 0 上。
 *
 * 有意做成独立函数，而不是去改 `parseNote`：后者的契约是「扫散文，跳过 frontmatter」，并且被
 * `verify-parse.mts` 钉死了。line 0 是一个标记，意思是「这个标签来自元数据块，它没有可跳转的行」。
 */
export function frontmatterTagRows(
  path: string,
  content: string,
  bodyTags: readonly ParsedTag[],
  /** 复用调用方已解析的 frontmatter（reindexContent 每次保存都要解析一遍，见 cardFromBody）。 */
  fm: Frontmatter = parseFrontmatter(content),
): TagRow[] {
  const have = new Set(bodyTags.map((t) => t.tag.toLowerCase()))
  const rows: TagRow[] = []
  const seen = new Set<string>()
  for (const raw of readList(fm, 'tags')) {
    // frontmatter 是一次显式声明，所以 `tags: [2024]` 算数——尽管散文扫描器会因为 `#2024` 里一个
    // 非数字字符都没有而把它判成不是标签。
    const tag = raw.trim().toLowerCase()
    if (tag === '' || have.has(tag) || seen.has(tag)) continue
    seen.add(tag)
    rows.push({ tag, path, line: 0 })
  }
  return rows
}

/** 正文标签保持自身顺序并赢得行号；frontmatter 标签追加在后面。 */
function mergeTags(bodyTags: readonly ParsedTag[], fmTags: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  // 正文标签已由 `parseNote` 统一小写，这里只滤空并去重；frontmatter 那一轮才需要自己 trim + 转小写。
  for (const t of bodyTags) {
    if (t.tag === '' || seen.has(t.tag)) continue
    seen.add(t.tag)
    out.push(t.tag)
  }
  for (const raw of fmTags) {
    const tag = raw.trim().toLowerCase()
    if (tag === '' || seen.has(tag)) continue
    seen.add(tag)
    out.push(tag)
  }
  return out
}
