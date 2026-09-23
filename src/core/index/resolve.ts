/**
 * 把 `[[target]]` 解析成具体的笔记路径。
 *
 * 规则尽量贴近 Obsidian，以便与既有 vault 保持兼容：精确路径 → 忽略大小写的路径 → 文件名
 * （basename 歧义时取最短路径）；按 ID 解析放在最后一位，这样一篇真叫
 * `202609151423.md` 的笔记仍会凭自己的路径胜出，而不是被 ID 索引抢走。
 *
 * 硬约束：只用相对导入（验证脚本以裸 node 直跑，无 `@/` 别名解析）；对 `db.ts` 只允许
 * `import type`，运行时不得导入——它在模块作用域构造 Dexie。
 */
import type { NoteMeta } from '../db.ts'
import { normalizePath, titleOf } from '../vault/paths.ts'
import { isZid } from '../zettel/card.ts'

/** ID 索引所需的两个字段；`CardRow` 天然满足，本模块因此无需知道 Dexie 的存在。 */
export interface ZidHolder {
  path: string
  zid: string
}

/**
 * 预先建好的解析索引。调用方在笔记/卡片变化时重建，`resolveTarget` 只读查询、不做 I/O。
 */
export interface Resolver {
  /** 全部有效笔记的原始路径 */
  paths: Set<string>
  /** 精确路径 → 路径 */
  byExactPath: Map<string, string>
  /** 小写化路径 → 路径（容错大小写不一致） */
  byLowerPath: Map<string, string>
  /** 去掉 `.md` 后小写化的路径 → 路径（容忍书写时省扩展名） */
  byLowerPathNoExt: Map<string, string>
  /** 小写化文件名 → 路径列表，同名时按「最短优先」排序 */
  byBasename: Map<string, string[]>
  /** zettel ID → 路径，仅按 ID 解析时使用 */
  byZid: Map<string, string>
}

/** 附件扩展名：带这些后缀的目标永远不解析成笔记（悬链即为答案）。 */
const NON_NOTE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico|pdf|mp[34]|wav|webm|ogg|zip|canvas|excalidraw)$/i

/**
 * 从笔记元数据（可选再加卡片行）构建 `Resolver`。
 * 忽略墓碑记录、basename 桶按路径长度排序、ID 冲突取字典序最小路径——三处规则共同保证：
 * 同样的输入在任何设备、任何重建顺序下都得到同一个答案。
 */
export function buildResolver(notes: NoteMeta[], cards?: readonly ZidHolder[]): Resolver {
  const r: Resolver = {
    paths: new Set(),
    byExactPath: new Map(),
    byLowerPath: new Map(),
    byLowerPathNoExt: new Map(),
    byBasename: new Map(),
    byZid: new Map(),
  }
  for (const n of notes) {
    // 墓碑只是远端删除的记账，不是笔记：索引它们会让「指向已删文件」的链接看起来仍可解析，
    // 还会在重命名时让 basename 变得假歧义。
    if (n.removedLocal) continue
    r.paths.add(n.path)
    r.byExactPath.set(n.path, n.path)
    r.byLowerPath.set(n.path.toLowerCase(), n.path)
    r.byLowerPathNoExt.set(stripMd(n.path).toLowerCase(), n.path)
    const base = titleOf(n.path).toLowerCase()
    const bucket = r.byBasename.get(base)
    if (bucket) bucket.push(n.path)
    else r.byBasename.set(base, [n.path])
  }
  for (const bucket of r.byBasename.values()) {
    bucket.sort((a, b) => a.length - b.length || a.localeCompare(b))
  }

  if (cards) {
    // 两台设备在同一分钟各建一张同 ID 卡片、同步引擎又把两边都保留时，两个文件会共享同一 ID。
    // 没有协调者能告诉你作者指的是哪张，所以取字典序最小的路径：虽是任意解，但在每台设备、
    // 每次重建上给出的答案都一致。
    const claimed = new Map<string, string>()
    for (const c of cards) {
      if (c.zid === '' || !isZid(c.zid)) continue
      // 过滤依据是 `paths` 而非信任调用方，因此墓碑笔记的 ID 永远解析不出来，
      // 无论两个索引碰巧以什么顺序刷新。
      if (!r.paths.has(c.path)) continue
      const held = claimed.get(c.zid)
      if (held === undefined || c.path < held) claimed.set(c.zid, c.path)
    }
    r.byZid = claimed
  }

  return r
}

/** 目标是否指向附件而非笔记（按扩展名判定）。 */
export function isAttachmentTarget(target: string): boolean {
  return NON_NOTE_EXT.test(target.trim())
}

/**
 * 按固定优先级解析目标，返回笔记路径；解析不到（悬链）返回 null：
 * 1. 精确路径（先剥掉 `./` 前缀）；
 * 2. 忽略大小写的完整路径；
 * 3. 忽略大小写、去 `.md` 的路径（书写时省扩展名）；
 * 4. 同上，但再剥掉开头的 `/`；
 * 5. basename：同名取最短路径（`buildResolver` 已排好序）；
 * 6. 最后才是 zettel ID，且必须先通过 `isZid` 校验。
 */
export function resolveTarget(resolver: Resolver, rawTarget: string): string | null {
  const target = rawTarget.trim()
  if (target === '') return null
  if (isAttachmentTarget(target)) return null

  const cleaned = target.replace(/^\.\//, '')
  if (resolver.byExactPath.has(cleaned)) return cleaned

  const direct = resolver.byLowerPath.get(cleaned.toLowerCase())
  if (direct) return direct

  const noExt = resolver.byLowerPathNoExt.get(stripMd(cleaned).toLowerCase())
  if (noExt) return noExt

  const asPath = resolver.byLowerPathNoExt.get(stripMd(cleaned).toLowerCase().replace(/^\/+/, ''))
  if (asPath) return asPath

  const byBase = resolver.byBasename.get(titleOf(cleaned).toLowerCase())
  if (byBase && byBase.length > 0) return byBase[0]

  // 按 ID 解析排在最后，且只对格式合法的 ID 尝试：没有 `isZid` 这道闸，
  // 目标 `2026` 就能顺手匹配任何以这些数字开头的 ID。
  if (isZid(cleaned)) {
    const byId = resolver.byZid.get(cleaned)
    if (byId) return byId
  }

  return null
}

/**
 * 重命名后链接应写成的文本：最短的无歧义形式。
 * basename 全局唯一时只写笔记名，否则退回去 `.md` 的完整路径。
 */
export function preferredLinkText(resolver: Resolver, path: string): string {
  const base = titleOf(path)
  const bucket = resolver.byBasename.get(base.toLowerCase())
  if (bucket && bucket.length === 1) return base
  return stripMd(path)
}

/** 去掉 `.md` 扩展名并小写化（大小写比较统一交给调用方的索引键处理）。 */
function stripMd(p: string): string {
  return p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p
}

/** 安全的重命名目标：已归一化、保证带 `.md`、且不得与现有笔记重名。 */
export function validateNewPath(
  resolver: Resolver,
  candidate: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  let path: string
  try {
    path = normalizePath(candidate)
  } catch {
    return { ok: false, reason: '路径不合法(不能为空、不能包含 `..`)' }
  }
  if (!path.toLowerCase().endsWith('.md')) path += '.md'
  if (resolver.paths.has(path)) return { ok: false, reason: `已存在同名笔记: ${path}` }
  return { ok: true, path }
}
