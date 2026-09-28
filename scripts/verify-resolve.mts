/**
 * 链接解析验证（src/core/index/resolve.ts）：
 * - buildResolver：墓碑排除、basename 桶按路径长度排序、zid 冲突取字典序最小路径、墓碑上的卡不进索引；
 * - resolveTarget：固定优先级 精确 → 忽略大小写 → 省扩展名 → 剥前导斜杠 → basename 最短 → zid；
 *   附件与悬链一律 null；`[[202609151423]]` 这类目标先当 basename 找真笔记，找不到才落进 id 索引；
 * - preferredLinkText / validateNewPath：重命名改链的写法与改名目标校验；
 * - resolverEquivalent：漂移扫描的跳过判定（路径集与 ID 映射逐一相等才算等价）。
 *
 * 运行：npm run verify（第 11 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import type { NoteMeta } from '../src/core/db.ts'
import {
  buildResolver,
  isAttachmentTarget,
  preferredLinkText,
  resolveTarget,
  resolverEquivalent,
  validateNewPath,
} from '../src/core/index/resolve.ts'

let pass = 0
let fail = 0

/** 用 JSON 序列化后比较，失败时打印 expected/actual 差异。 */
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`)
  }
}

function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else {
    fail++
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ''}`)
  }
}

/** 构造一条默认"已缓存、未同步、未删除"的笔记元数据，patch 覆盖要测的字段。 */
function note(path: string, patch: Partial<NoteMeta> = {}): NoteMeta {
  return {
    path,
    title: path.replace(/\.md$/, '').split('/').pop() ?? path,
    baseSha: null,
    localSha: null,
    remoteSha: null,
    mtime: 0,
    size: 0,
    dirty: 0,
    cached: 1,
    removedLocal: 0,
    removedRemote: 0,
    ...patch,
  }
}

// 三个同名 Redis 笔记（验证最短路径胜出）+ 唯一名 + 文件名本身是 zid 的真笔记 + 墓碑
// + 两张卡片笔记本身（zid 只有在路径存在于有效笔记里时才进索引，见 buildResolver）。
const notes: NoteMeta[] = [
  note('Redis.md'),
  note('notes/Redis.md'),
  note('archive/2024/Redis.md'),
  note('notes/Untitled.md'),
  note('202609151423.md'),
  note('cards/a.md'),
  note('cards/b.md'),
  note('old/Legacy.md', { removedLocal: 1 }),
]

const cards = [
  // 同 ID 两行（两台设备各建一张）→ 取字典序最小路径。
  { path: 'cards/b.md', zid: '202601010000' },
  { path: 'cards/a.md', zid: '202601010000' },
  // 带字母后缀的 id 归卡片。
  { path: 'notes/Untitled.md', zid: '202609151423a' },
  // 墓碑上的卡：无论索引以什么顺序重建都不该进 id 索引。
  { path: 'old/Legacy.md', zid: '202602020000' },
]

const r = buildResolver(notes, cards)

// ---- buildResolver 的集合与桶 ----
ok('tombstone path not in resolver', !r.paths.has('old/Legacy.md'))
check('basename bucket sorted shortest first', r.byBasename.get('redis'), ['Redis.md', 'notes/Redis.md', 'archive/2024/Redis.md'])
check('duplicate zid picks lexicographically smallest path', r.byZid.get('202601010000'), 'cards/a.md')
ok('tombstone card zid absent', !r.byZid.has('202602020000'))

// ---- resolveTarget 的固定优先级 ----
check('exact path wins over basename ambiguity', resolveTarget(r, 'Redis.md'), 'Redis.md')
check('./ prefix stripped before exact', resolveTarget(r, './notes/Redis.md'), 'notes/Redis.md')
check('case-insensitive full path', resolveTarget(r, 'NOTES/REDIS.MD'), 'notes/Redis.md')
check('missing extension', resolveTarget(r, 'notes/Untitled'), 'notes/Untitled.md')
check('leading slash stripped at step 4', resolveTarget(r, '/notes/Untitled'), 'notes/Untitled.md')
check('basename picks shortest path', resolveTarget(r, 'Redis'), 'Redis.md')
check('full path sans extension resolves exactly', resolveTarget(r, 'archive/2024/Redis'), 'archive/2024/Redis.md')
check('bare zid resolves via id index', resolveTarget(r, '202601010000'), 'cards/a.md')
check('zid with letter suffix resolves', resolveTarget(r, '202609151423a'), 'notes/Untitled.md')
check('real note beats id index (basename first)', resolveTarget(r, '202609151423'), '202609151423.md')
check('non-zid digits resolve nothing', resolveTarget(r, '2026'), null)
check('tombstone target is a dead link', resolveTarget(r, 'old/Legacy.md'), null)
check('empty target is a dead link', resolveTarget(r, ''), null)
check('whitespace target is a dead link', resolveTarget(r, '   '), null)
check('unknown target is a dead link', resolveTarget(r, 'never/existed'), null)

// ---- 附件按扩展名判定，永远不解析成笔记 ----
ok('png is attachment', isAttachmentTarget('img/a.png'))
ok('uppercase extension is attachment', isAttachmentTarget('REPORT.PDF'))
ok('md is not attachment', !isAttachmentTarget('a.md'))
check('attachment resolves to null', resolveTarget(r, 'assets/logo.png'), null)

// ---- preferredLinkText：唯一 basename 写短名，有歧义退回完整路径 ----
check('unique basename prefers short form', preferredLinkText(r, 'notes/Untitled.md'), 'Untitled')
check('ambiguous basename falls back to path', preferredLinkText(r, 'notes/Redis.md'), 'notes/Redis')

// ---- validateNewPath：归一化、补 .md、拒绝重名与越界 ----
check('valid new path gets extension', validateNewPath(r, 'new'), { ok: true, path: 'new.md' })
check('existing path rejected', validateNewPath(r, 'Redis.md'), { ok: false, reason: '已存在同名笔记: Redis.md' })
check('unsafe path rejected', validateNewPath(r, '../evil'), { ok: false, reason: '路径不合法(不能为空、不能包含 `..`)' })
check('empty candidate rejected', validateNewPath(r, ''), { ok: false, reason: '路径不合法(不能为空、不能包含 `..`)' })

// ---- resolverEquivalent：漂移扫描的跳过判定（路径集 + ID 映射逐一相等才等价） ----
const r2 = buildResolver(notes, cards)
ok('identical rebuild is equivalent', resolverEquivalent(r, r2))
ok('resolver equals itself', resolverEquivalent(r, r))
const added = buildResolver([...notes, note('notes/New.md')], cards)
ok('added path breaks equivalence', !resolverEquivalent(r, added))
const removed = buildResolver(
  notes.filter((n) => n.path !== 'notes/Untitled.md'),
  cards,
)
ok('removed path breaks equivalence', !resolverEquivalent(r, removed))
// 同数量但成员不同：尺寸相等绝不能当等价——这正是集合成员逐一比对的意义。
const swapped = buildResolver(
  notes.map((n) => (n.path === 'notes/Untitled.md' ? note('notes/Other.md') : n)),
  cards,
)
ok('same-size different membership breaks equivalence', !resolverEquivalent(r, swapped))
// 墓碑翻转：路径从集合里消失，指向它的链接可能改指 → 必须重扫。
const tombstoned = buildResolver(
  notes.map((n) => (n.path === 'notes/Untitled.md' ? { ...n, removedLocal: 1 } : n)),
  cards,
)
ok('tombstone flip breaks equivalence', !resolverEquivalent(r, tombstoned))
// zid 变化：byZid 映射不同 → `[[id]]` 链接可能改指。
const zidChanged = buildResolver(
  notes,
  cards.map((c) => (c.path === 'cards/b.md' ? { ...c, zid: '202601010001' } : c)),
)
ok('zid change breaks equivalence', !resolverEquivalent(r, zidChanged))
// 无关字段（dirty/mtime/size）变化不进入 resolver → 依然等价。
const dirtyCopy = buildResolver(
  notes.map((n) => ({ ...n, dirty: 1, mtime: 123, size: 999 })),
  cards,
)
ok('unrelated metadata keeps equivalence', resolverEquivalent(r, dirtyCopy))

console.log(`${fail === 0 ? 'OK  ' : 'FAIL'} verify-resolve: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
