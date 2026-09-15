import Dexie, { type EntityTable } from 'dexie'

/**
 * Sync state per note.
 *
 * `baseSha` is the common ancestor: the blob sha both local and remote agreed on at
 * the last successful sync. Three-way merge is impossible without it, which is why
 * it is stored separately from localSha/remoteSha.
 */
export interface NoteMeta {
  path: string
  title: string
  /** last synced ancestor blob sha */
  baseSha: string | null
  /** blob sha of the content currently in OPFS */
  localSha: string | null
  /** blob sha last observed on the remote */
  remoteSha: string | null
  mtime: number
  size: number
  /** 1 = edited locally, not yet pushed */
  dirty: 0 | 1
  /** 1 = body downloaded into OPFS; 0 = index-only stub awaiting lazy fetch */
  cached: 0 | 1
  /** 1 = deleted locally, deletion not yet pushed */
  removedLocal: 0 | 1
  /** 1 = deleted on remote, local copy not yet removed */
  removedRemote: 0 | 1
}

export interface LinkRow {
  id?: number
  /** source note path */
  src: string
  /** raw link text as written, e.g. `Redis` or `notes/Redis` */
  target: string
  /** resolved note path, or null when the target does not exist yet */
  targetPath: string | null
  alias: string | null
  heading: string | null
  blockRef: string | null
  embed: 0 | 1
  line: number
  /** surrounding text, shown in the backlink panel */
  context: string
}

export interface TagRow {
  id?: number
  tag: string
  path: string
  line: number
}

export interface SettingRow {
  key: string
  value: string
}

export interface SyncLogRow {
  id?: number
  at: number
  level: 'info' | 'warn' | 'error'
  message: string
}

class VaultDB extends Dexie {
  notes!: EntityTable<NoteMeta, 'path'>
  links!: EntityTable<LinkRow, 'id'>
  tags!: EntityTable<TagRow, 'id'>
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
  }
}

export const db = new VaultDB()

export async function getSetting<T = string>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export async function putSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value: JSON.stringify(value) })
}

export async function logSync(level: SyncLogRow['level'], message: string): Promise<void> {
  await db.syncLog.add({ at: Date.now(), level, message })
  const count = await db.syncLog.count()
  if (count > 300) {
    const oldest = await db.syncLog.orderBy('at').limit(count - 300).primaryKeys()
    await db.syncLog.bulkDelete(oldest)
  }
}
