import Dexie, { type EntityTable } from 'dexie'
import type { CardType } from './zettel/card.ts'

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

/**
 * Zettelkasten metadata for one note, mirrored out of its frontmatter.
 *
 * A separate table rather than new columns on `notes`: `notes` carries the base/local/remote shas
 * and the dirty flags the sync engine lives on, and declaring `version(2)` with only a new store
 * leaves the five version-1 stores byte-identical. There is no upgrade function because there is
 * nothing to convert — the table starts empty and the backfill fills it.
 *
 * Like `links` and `tags` this is purely derived: it can be cleared and rebuilt from OPFS at any
 * time without losing anything the user wrote.
 */
export interface CardRow {
  /** also the join key into `notes` */
  path: string
  /** the permanent id, or '' when the note has none */
  zid: string
  type: CardType
  /** epoch ms parsed out of `created`, or 0 when absent, so ordering stays deterministic */
  created: number
  /** the string as written, for lossless rewrite */
  createdRaw: string
  aliases: string[]
  /** frontmatter `tags:` merged with the body's `#tag`s, deduped and lowercased */
  tags: string[]
  /** 1 = the body was actually read; 0 = placeholder the resumable backfill has not reached */
  parsed: 0 | 1
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
    // Only the new store is listed; Dexie carries the version-1 schema forward untouched.
    this.version(2).stores({
      cards: 'path, type, zid, created, parsed',
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
