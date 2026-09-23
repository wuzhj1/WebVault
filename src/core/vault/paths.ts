/**
 * 全应用唯一的路径规范化入口：vault 内一律用「相对根目录、以 `/` 分隔、无前导斜杠」的规范路径，
 * 所有外部输入（用户输入、文件名、同步回来的 tree entry）都必须先过 `normalizePath` 再落盘。
 *
 * 硬约束：只用相对导入且不得引入任何依赖 —— `opfs.ts`、`hash.ts`、store、脚本与验证工具都会拉通
 * 过它，一旦反向依赖浏览器 API 就会让纯 Node 侧的路径校验跑不起来。
 */

/** 笔记扩展名；大小写判定统一走 `toLowerCase()`，因为 OPFS 在 Windows 上大小写不敏感。 */
const MD_EXT = '.md'

/** 路径越界（`..` 逃逸、盘符、NUL、空串）时抛出，调用方一律拒绝而不是修正。 */
export class UnsafePathError extends Error {
  constructor(path: string) {
    super(`拒绝不安全的路径: ${path}`)
    this.name = 'UnsafePathError'
  }
}

/**
 * 折叠 `./`、`../`、重复与末尾斜杠，并反斜杠归一为 `/`。
 * 抛错的四种情况：清洗后为空、含 NUL、带 `C:` 盘符、以及 `..` 试图爬到根之上。
 * 「先折叠再判长度」是关键顺序 —— 字符串级的 startsWith 防护会被 `a/../../etc` 绕过。
 */
export function normalizePath(raw: string): string {
  const cleaned = raw.trim().replace(/\\/g, '/').replace(/^\//, '')
  if (cleaned === '' || cleaned.includes('\0')) throw new UnsafePathError(raw)
  if (/^[a-zA-Z]:/.test(cleaned)) throw new UnsafePathError(raw)

  const out: string[] = []
  for (const segment of cleaned.split('/')) {
    // 空段与 `.` 直接丢弃，等于顺手做了重复斜杠归一。
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      // 栈空说明要爬到 vault 根之上（含 `/../a.md` 这种被剥掉前导斜杠后的形态），拒绝。
      if (out.length === 0) throw new UnsafePathError(raw)
      out.pop()
      continue
    }
    out.push(segment)
  }
  if (out.length === 0) throw new UnsafePathError(raw)
  return out.join('/')
}

/** 是否笔记路径。只看扩展名，不做规范化 —— 入参必须是已经 `normalizePath` 过的。 */
export function isNotePath(path: string): boolean {
  return path.toLowerCase().endsWith(MD_EXT)
}

/** 补全 `.md` 后缀；已带任何大小写后缀的原样返回，避免把 `A.MD` 改成 `A.MD.md`。 */
export function ensureMdExt(name: string): string {
  const trimmed = name.trim()
  return isNotePath(trimmed) ? trimmed : trimmed + MD_EXT
}

/**
 * 文件名里的 zettel id 前缀：本地时间 `YYYYMMDDHHmm` 十二位数字、可选字母后缀（用于拆开同一分钟
 * 内的碰撞）、再接一个分隔符。
 *
 * 分隔符是必需的，所以它与 `isZid` 并非同一个模式：名为 `202609151423.md` 的笔记应当把这串数字当
 * 标题，而不是被剥成空标题。
 */
export const ZID_PREFIX = /^\d{12}[a-z]{0,3}[ _-]+/

/**
 * `notes/sub/a.md` -> `a`，`202609151423 卡片盒.md` -> `卡片盒`。
 *
 * 把「剥 id」放在这里而不是每个调用点，是本函数存在的理由：`titleOf` 同时供顶栏、文件树、反向链
 * 接、关系图标签、同步进度、搜索文档和链接选择器使用，改一处就能让时间戳从所有地方消失。
 * 另外它使 `[[卡片盒]]` 与 `[[202609151423 卡片盒]]` 指向同一篇 —— resolver 就是按这个值分桶的。
 */
export function titleOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const stem = isNotePath(base) ? base.slice(0, -MD_EXT.length) : base
  const stripped = stem.replace(ZID_PREFIX, '')
  // 整名恰好就是「id + 分隔符」时不能返回空串，退回未剥离的 stem。
  return stripped === '' ? stem : stripped
}

/** `notes/sub/a.md` -> `notes/sub`；`a.md` -> `''`（根目录用空串表示，不是 `.`）。 */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** 拼目录与名字；dir 为空或 `/` 时退化成裸文件名。不校验结果，调用方需再走 `normalizePath`。 */
export function joinPath(dir: string, name: string): string {
  const d = dir.trim()
  return d === '' || d === '/' ? name : `${d}/${name}`
}

/** 会让标题凭空造出一个子目录、或者任何文件系统都不接受的字符；\p{Cc} 即全部控制字符。 */
const FORBIDDEN_TITLE = /[\\/:*?"<>|\p{Cc}]/gu
/** 文件名里标题部分的码点上限；与 id 前缀合计也远低于 git 每段路径 255 字节的限制。 */
const TITLE_MAX_CHARS = 48

/**
 * 可以安全用作文件名的标题。
 *
 * 原属 `core/zettel/card.ts`，卡片盒移除时迁入：它是「新建笔记」的通用能力，不该活在一个
 * 只剩链接兼容职责的模块里；这次迁移同时切断了 card→paths 的反向依赖。
 *
 * `/` 和 `\` 必须去掉：`normalizePath` 只拦 `..` 逃逸，不拦的话一个内容为 `a/b` 的标题就会悄悄建出
 * 目录来。截断按码点进行，绝不会把一个代理对切一半。
 */
export function sanitizeTitle(raw: string): string {
  const collapsed = raw
    .replace(FORBIDDEN_TITLE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (collapsed === '') throw new Error('标题不能为空,也不能只包含 / \\ : * ? " < > | 等字符')

  const chars = [...collapsed]
  const cut = chars.length > TITLE_MAX_CHARS ? chars.slice(0, TITLE_MAX_CHARS).join('') : collapsed
  // 再清一次尾部：截断本身可能让结尾又露出点号或空白，而 Windows 会把它们吃掉。
  const trimmed = cut.replace(/[.\s]+$/, '')
  if (trimmed === '') throw new Error('标题不能为空,也不能只包含 / \\ : * ? " < > | 等字符')
  return trimmed
}

/** `dir` 试图逃出仓库根目录时抛 `UnsafePathError`。 */
export function cardPath(dir: string, filename: string): string {
  return normalizePath(joinPath(dir, filename))
}

/** 一条路径的全部祖先目录，由浅到深（`a/b/c.md` -> `['a', 'a/b']`）。OPFS 建目录必须按此顺序。 */
export function ancestorDirs(path: string): string[] {
  const dirs: string[] = []
  let d = dirOf(path)
  while (d !== '') {
    dirs.unshift(d)
    d = dirOf(d)
  }
  return dirs
}

/** 排序键：目录在前、笔记在后由调用方处理，这里只做中文自然序（`numeric` 让 `2` 排在 `10` 前）。 */
export function comparePath(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true })
}
