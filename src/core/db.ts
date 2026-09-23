/**
 * Dexie(IndexedDB) 的 schema 定义与通用存取辅助：笔记同步元数据、链接/标签/卡片派生索引、
 * 键值设置、同步日志。
 *
 * 硬约束/注意事项：
 * - NoteMeta 的 baseSha/localSha/remoteSha 三方合并语义，以及 dirty/cached/removedLocal/removedRemote
 *   四个标志位，是同步引擎（core/sync/engine.ts）的全部判定依据，只可增补注释、不可改名或改类型。
 * - version(1) 的五个 store 一经发布即冻结；新增 store 只能挂新版本号（见 cards 的 version(2)）。
 *   不写 upgrade 函数意味着没有数据转换风险，表从空开始由回填补齐。
 * - links/tags/cards 均为纯派生索引：随时可从 OPFS 正文清空重建，不承载用户唯一数据。
 */
import Dexie, { type EntityTable } from 'dexie'
import type { CardType } from './zettel/card.ts'

/**
 * 单篇笔记的同步状态。
 *
 * `baseSha` 是共同祖先：上次同步成功时本地与远端共同认可的 blob sha。
 * 没有它三方合并就无从谈起，因此必须与 localSha/remoteSha 分开存——推送时拿 base 分别对比
 * local/remote，就能只凭 sha 判断哪一侧动过（见 merge.ts 的 classifySync）。
 *
 * 四个标志位的语义与生命周期：
 * - `dirty`：本地改过、尚未推送；推送成功后由 engine 的 settle() 清零。
 * - `cached`：正文已落盘 OPFS；0 表示只有索引的 stub，打开时按需下载。
 * - `removedLocal`：本地已删、删除动作尚未推到远端的「墓碑」；推送成功前不可清除。
 * - `removedRemote`：远端已删、本地副本尚未移除；由 pullIndex 标记、applyRemoteDeletions 消费。
 */
export interface NoteMeta {
  path: string
  title: string
  /** 上次同步成功时的共同祖先 blob sha，三方合并的基准；null = 从未同步过 */
  baseSha: string | null
  /** 当前 OPFS 正文对应的 git blob sha */
  localSha: string | null
  /** 最近一次在远端观测到的 blob sha；null = 还没推上去过 */
  remoteSha: string | null
  mtime: number
  size: number
  /** 1 = 本地已编辑，尚未推送 */
  dirty: 0 | 1
  /** 1 = 正文已下载进 OPFS；0 = 仅有索引的 stub，等待按需拉取 */
  cached: 0 | 1
  /** 1 = 本地已删除，删除动作尚未推送（墓碑） */
  removedLocal: 0 | 1
  /** 1 = 远端已删除，本地副本尚未移除 */
  removedRemote: 0 | 1
}

/** 双链索引的一行：一条出链的完整解析结果，供反链面板与链接解析查询。纯派生数据。 */
export interface LinkRow {
  id?: number
  /** 源笔记路径 */
  src: string
  /** 书写时的原始链接文本，如 `Redis` 或 `notes/Redis` */
  target: string
  /** 解析后的目标笔记路径；目标尚不存在时为 null */
  targetPath: string | null
  alias: string | null
  heading: string | null
  blockRef: string | null
  embed: 0 | 1
  line: number
  /** 链接上下文片段，展示在反链面板里 */
  context: string
}

/** 标签索引的一行：`#tag` 在某篇笔记某行的出现。纯派生数据。 */
export interface TagRow {
  id?: number
  tag: string
  path: string
  line: number
}

/**
 * 单篇笔记的旧卡片元数据，从其 frontmatter 镜像而来。
 *
 * 卡片盒功能已整体移除，但**这张表必须保留**：`zid` 是 `[[202609151423]]` 这类 ID 链接
 * 唯一的解析数据源（buildResolver 按 zid 建索引），删表即断链；`type/created/aliases`
 * 对新代码已是无人读写的死数据，留着只为 schema 冻结——version(2) 只增不减。
 * 单独建表而不是给 `notes` 加列：`notes` 装的是同步引擎赖以生存的 sha 与脏标记，不该被业务字段搅浑。
 *
 * 与 `links`、`tags` 一样是纯派生数据：任何时候都能清空并从 OPFS 重建，
 * 不会丢失用户写过的任何东西。
 */
export interface CardRow {
  /** 兼作与 `notes` 关联的主键 */
  path: string
  /** 永久 id；笔记没有时为 '' */
  zid: string
  type: CardType
  /** 从 `created` 解析出的 epoch 毫秒；缺失为 0，保证排序确定性 */
  created: number
  /** 原样保留的字符串，用于无损回写 */
  createdRaw: string
  aliases: string[]
  /** frontmatter 的 `tags:` 与正文 `#tag` 合并，去重并转小写 */
  tags: string[]
  /** 1 = 正文已真实解析；0 = 占位行，可续传的回填尚未扫到该篇 */
  parsed: 0 | 1
}

/** 键值设置表；value 一律以 JSON 字符串存取（见 getSetting/putSetting）。 */
export interface SettingRow {
  key: string
  value: string
}

/** 同步日志表；logSync 写入时自动裁剪，只保留最近约 300 条。 */
export interface SyncLogRow {
  id?: number
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}

/** Dexie 数据库类：表引用在此声明类型，schema 版本在构造函数里定义。 */
class VaultDB extends Dexie {
  notes!: EntityTable<NoteMeta, 'path'>
  links!: EntityTable<LinkRow, 'id'>
  tags!: EntityTable<TagRow, 'id'>
  cards!: EntityTable<CardRow, 'path'>
  settings!: EntityTable<SettingRow, 'key'>
  syncLog!: EntityTable<SyncLogRow, 'id'>

  constructor() {
    super('webvault')
    this.version(1).stores({
      notes: 'path, title, dirty, cached, remoteSha',
      links: '++id, src, target, targetPath',
      tags: '++id, tag, path',
      settings: 'key',
      syncLog: '++id, at',
    })
    // 只列出新增的 store；Dexie 会原样沿用 version-1 的 schema，其余五个表不受影响。
    this.version(2).stores({
      cards: 'path, type, zid, created, parsed',
    })
  }
}

/** 全局单例，贯穿应用的唯一 Dexie 句柄。 */
export const db = new VaultDB()

/**
 * 读取设置项。value 以 JSON 存储，故按 T 反序列化；键不存在或 JSON 损坏都返回 fallback，
 * 绝不向上抛错——设置读取失败不应阻断应用启动。
 */
export async function getSetting<T = string>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

/** 写入设置项，value 用 JSON 序列化后存入（任意可 JSON 序列化的值）。 */
export async function putSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value: JSON.stringify(value) })
}

/**
 * 追加一条同步日志并顺手裁剪：超过 300 条时按时间升序删掉最旧的，
 * 避免 IndexedDB 里的日志无限增长。
 */
export async function logSync(level: SyncLogRow['level'], message: string): Promise<void> {
  await db.syncLog.add({ at: Date.now(), level, message })
  const count = await db.syncLog.count()
  if (count > 300) {
    const oldest = await db.syncLog.orderBy('at').limit(count - 300).primaryKeys()
    await db.syncLog.bulkDelete(oldest)
  }
}
