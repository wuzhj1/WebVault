/**
 * Card lifecycle on top of the vault: the backfill that builds the index, the type changes that
 * rewrite a file's frontmatter, and the derived lists the UI shows.
 *
 * Dependency direction is one-way — this store reads the vault store, never the reverse. The vault
 * keeps `cards` current through `reindexContent`, so nothing here has to hook into saving.
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import { db, getSetting, putSetting, type CardRow } from '@/core/db.ts'
import { titleOf } from '@/core/vault/paths.ts'
import * as opfs from '@/core/vault/opfs.ts'
import { writeKeys } from '@/core/parse/frontmatter.ts'
import {
  cardFilename,
  cardFromBody,
  cardPath,
  createdStamp,
  isCardType,
  nextFreeZid,
  sanitizeTitle,
  zidFromPath,
  zidStamp,
  type CardType,
} from '@/core/zettel/card.ts'
import { renderCardTemplate } from '@/core/zettel/template.ts'
import { buildDegrees, findOrphans, type LinkEdge } from '@/core/zettel/orphans.ts'
import { rankRelated, type RelatedHit } from '@/core/zettel/related.ts'
import { hasIndex, searchIds } from '@/core/search/index.ts'
import {
  DEFAULT_ZETTEL_SETTINGS,
  ZETTEL_SETTINGS_KEY,
  inferIdPrefix,
  normalizeSettings,
  type ZettelSettings,
} from '@/core/zettel/settings.ts'
import { useSyncStore } from './sync.ts'
import { useVaultStore } from './vault.ts'

/** Notes parsed per macrotask. Small enough to stay invisible, large enough to finish. */
const BACKFILL_CHUNK = 40
const RELOAD_DEBOUNCE_MS = 500
const RELATED_DEBOUNCE_MS = 250
const CREATE_ATTEMPTS = 30
const NO_TAGS: readonly string[] = []

/** What the new-card dialog collects. `title` is the only required field. */
export interface NewCard {
  title: string
  /** Vault-relative directory, empty for the root. */
  dir: string
  type: CardType
  tags: readonly string[]
}

export const useZettelStore = defineStore('zettel', () => {
  const vault = useVaultStore()

  const edges = shallowRef<LinkEdge[]>([])
  /** `path -> tags`, body and frontmatter merged. Loaded with the edges so ranking is one pass. */
  const tagIndex = shallowRef<Map<string, string[]>>(new Map())
  const related = shallowRef<RelatedHit[]>([])
  /** Which note `related` was ranked for; the panel renders only when it still matches. */
  const relatedFor = ref<string | null>(null)
  const backfill = ref<{ done: number; total: number } | null>(null)
  const settings = ref<ZettelSettings>({ ...DEFAULT_ZETTEL_SETTINGS })
  /** False until the user has saved a choice; an inferred preference must never be persisted. */
  const settingsPinned = ref(false)

  let backfilling = false
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  let reloadSeq = 0
  let relatedTimer: ReturnType<typeof setTimeout> | null = null
  let relatedSeq = 0

  const degrees = computed(() => buildDegrees(edges.value))

  const livePaths = computed(() =>
    vault.notes.filter((n) => !n.removedLocal).map((n) => n.path),
  )

  const byPath = computed(() => new Map(vault.cards.map((c) => [c.path, c])))

  const counts = computed(() => {
    const out: Record<CardType, number> = {
      plain: 0,
      fleeting: 0,
      literature: 0,
      permanent: 0,
      index: 0,
    }
    for (const p of livePaths.value) out[typeOf(p)]++
    return out
  })

  /**
   * Fleeting notes waiting to be worked through, oldest first: the point of an inbox is that what
   * has been sitting longest is on top. Notes with no parseable `created` sort last rather than
   * jumping the queue with a zero timestamp.
   */
  const inbox = computed(() =>
    livePaths.value
      .filter((p) => typeOf(p) === 'fleeting')
      .sort((a, b) => compareCreated(a, b) || comparePath(a, b)),
  )

  const orphans = computed(() =>
    findOrphans(livePaths.value, degrees.value, (p) => byPath.value.get(p)?.created ?? 0),
  )

  /**
   * Every live note, newest card first. This is also the escape hatch for a vault that never
   * adopted frontmatter: notes without metadata have no stamp, so they sort last instead of
   * crowding out the cards that do.
   */
  const allCards = computed(() =>
    [...livePaths.value].sort((a, b) => {
      const ca = byPath.value.get(a)?.created ?? 0
      const cb = byPath.value.get(b)?.created ?? 0
      if (ca !== cb) return ca === 0 ? 1 : cb === 0 ? -1 : cb - ca
      return comparePath(a, b)
    }),
  )

  function cardOf(path: string): CardRow | null {
    return byPath.value.get(path) ?? null
  }

  /** `plain` for any note without usable metadata, which is every pre-existing note in the vault. */
  function typeOf(path: string): CardType {
    const t = byPath.value.get(path)?.type
    return t && isCardType(t) ? t : 'plain'
  }

  function createdOf(path: string): string {
    return byPath.value.get(path)?.createdRaw ?? ''
  }

  function aliasesOf(path: string): string[] {
    return byPath.value.get(path)?.aliases ?? []
  }

  function zidOf(path: string): string {
    return byPath.value.get(path)?.zid ?? ''
  }

  async function reload(): Promise<void> {
    const mine = ++reloadSeq
    const [rows, tagRows] = await Promise.all([db.links.toArray(), db.tags.toArray()])
    if (mine !== reloadSeq) return
    edges.value = rows.map((r) => ({ src: r.src, targetPath: r.targetPath }))

    const grouped = new Map<string, string[]>()
    for (const t of tagRows) {
      const bucket = grouped.get(t.path)
      if (bucket) {
        if (!bucket.includes(t.tag)) bucket.push(t.tag)
      } else {
        grouped.set(t.path, [t.tag])
      }
    }
    tagIndex.value = grouped
  }

  function scheduleReload(): void {
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      reloadTimer = null
      void reload()
    }, RELOAD_DEBOUNCE_MS)
  }

  /**
   * Rank the cards that probably belong next to the one being read.
   *
   * Deliberately not driven by saving: while typing, a re-rank every 700ms would be pure churn on a
   * list the user is not looking at. Switching notes, and a sync-driven rewrite of the open note,
   * are the two moments it can meaningfully change.
   */
  async function refreshRelated(): Promise<void> {
    const mine = ++relatedSeq
    const path = vault.activePath
    if (!path) {
      related.value = []
      relatedFor.value = null
      return
    }

    // Only worth having when the index is already warm: `ensureIndex` would otherwise read every
    // body in the vault just to decorate one panel, turning browsing into a full scan.
    let text: Map<string, number> | undefined
    if (hasIndex(vault.revision)) {
      const query = [titleOf(path), ...aliasesOf(path)].filter((s) => s !== '').join(' ')
      if (query !== '') {
        const hits = await searchIds(query, vault.revision, 60)
        if (mine !== relatedSeq) return
        if (hits.length > 0) text = new Map(hits.map((h) => [h.id, h.score]))
      }
    }

    const ranked = rankRelated({
      path,
      live: livePaths.value,
      edges: edges.value,
      tagsOf: (p) => tagIndex.value.get(p) ?? NO_TAGS,
      text,
    })
    if (mine !== relatedSeq) return
    related.value = ranked
    relatedFor.value = path
  }

  function scheduleRelated(): void {
    if (relatedTimer) clearTimeout(relatedTimer)
    relatedTimer = setTimeout(() => {
      relatedTimer = null
      void refreshRelated()
    }, RELATED_DEBOUNCE_MS)
  }

  /**
   * Read every cached body once and fill the card index.
   *
   * Runs after `ready` is already true, so the UI is never gated on it, and yields between chunks
   * because the user is reading and typing while it works. Resumable: a row is written only once
   * its body has actually been parsed, so a closed tab or an ITP wipe continues where it stopped.
   *
   * Strictly read-only against OPFS. Writing frontmatter here would silently rewrite the whole
   * existing vault, which is the one thing this feature must not do.
   */
  async function warmUp(): Promise<void> {
    await vault.reloadCards()
    await runBackfill()
    await reload()
    await loadSettings()
    await refreshRelated()
  }

  async function runBackfill(): Promise<void> {
    if (backfilling) return

    const parsed = new Set(
      vault.cards.filter((c) => c.parsed === 1).map((c) => c.path),
    )
    // Uncached stubs have no body to read; `reindexContent` writes their row when sync fetches them.
    const todo = vault.notes.filter((n) => !n.removedLocal && n.cached && !parsed.has(n.path))
    if (todo.length === 0) return

    backfilling = true
    backfill.value = { done: 0, total: todo.length }
    try {
      let buffer: CardRow[] = []
      for (let i = 0; i < todo.length; i++) {
        const body = await opfs.readNote(todo[i].path)
        // A file that vanished mid-run is reconcile's business, not this one's.
        if (body !== null) buffer.push(cardFromBody(todo[i].path, body))

        const last = i === todo.length - 1
        if (buffer.length >= BACKFILL_CHUNK || last) {
          if (buffer.length > 0) {
            await db.cards.bulkPut(buffer)
            buffer = []
          }
          await vault.reloadCards()
          backfill.value = { done: i + 1, total: todo.length }
          if (!last) await new Promise((r) => setTimeout(r, 0))
        }
      }
    } finally {
      backfilling = false
      backfill.value = null
      await vault.reloadCards()
    }
  }

  /** Ids already spoken for, in the index or in a filename. */
  async function takenZids(): Promise<Set<string>> {
    const taken = new Set<string>((await db.cards.orderBy('zid').keys()) as string[])
    for (const n of vault.notes) {
      const fromName = zidFromPath(n.path)
      if (fromName) taken.add(fromName)
    }
    return taken
  }

  /**
   * Change a card's type, which means editing its frontmatter.
   *
   * The caller must have flushed the editor and awaited it first: the body is read here, after that
   * flush, so it cannot pick up stale text and write it back over the last few keystrokes.
   */
  async function setCardType(path: string, type: CardType): Promise<void> {
    const sync = useSyncStore()
    const meta = vault.byPath.get(path)
    if (!meta) return

    if (!meta.cached) {
      await sync.fetchBody(path)
      if (!vault.byPath.get(path)?.cached) {
        sync.notify('warn', `「${titleOf(path)}」的内容还没下载到本机,联网同步后再改类型。`)
        return
      }
    }

    const body = await opfs.readNote(path)
    if (body === null) {
      sync.notify('warn', `读不到「${titleOf(path)}」的内容,无法修改类型。`)
      return
    }

    const next = writeKeys(body, { type })
    if (next === body) return
    await writeMeta(path, next)
  }

  /**
   * Promote an ordinary note to a card by giving it an id, a type and a creation stamp.
   *
   * `created` is the note's own mtime rather than now: this records when the thought was written
   * down, and a note that has been in the vault for a year must not claim to be brand new.
   */
  async function addCardMeta(path: string, type: CardType = settings.value.defaultType): Promise<void> {
    const sync = useSyncStore()
    const body = await opfs.readNote(path)
    if (body === null) {
      sync.notify('warn', `「${titleOf(path)}」的内容还没下载到本机,联网同步后再添加卡片信息。`)
      return
    }

    const meta = vault.byPath.get(path)
    const at = new Date(meta?.mtime ?? Date.now())
    const zid = nextFreeZid(zidStamp(at), await takenZids())
    const next = writeKeys(body, {
      id: zid,
      type,
      created: createdStamp(at),
    })
    if (next === body) return
    await writeMeta(path, next)
  }

  async function writeMeta(path: string, text: string): Promise<void> {
    const sync = useSyncStore()
    await vault.saveBody(path, text)
    // The editor keeps the body in its own DOM and only reloads on a bodyRevision bump; without
    // this the user would keep looking at the pre-edit text after a successful write.
    await vault.notifyBodyChanged(path)
    sync.schedulePush()
  }

  /**
   * Create a card: allocate an id, render the metadata block, write the file.
   *
   * Retries on a name collision because `createNote` answers one by returning the *existing* path
   * rather than failing — for a card that would silently open somebody else's note and let the user
   * type into it. Bounded at 30, matching the id allocator and the sync engine's conflict-copy
   * writer. With the id prefix off the filename cannot change between attempts, so that case fails
   * immediately and says so instead of looping.
   */
  async function createCard(draft: NewCard): Promise<string> {
    const title = sanitizeTitle(draft.title)
    const dir = draft.dir.trim()
    const idPrefix = settings.value.idPrefix
    const taken = await takenZids()

    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt++) {
      const zid = nextFreeZid(zidStamp(), taken)
      const path = cardPath(dir, cardFilename(zid, title, { idPrefix }))
      if (!vault.byPath.has(path)) {
        await vault.createNote(
          path,
          renderCardTemplate({
            zid,
            type: draft.type,
            created: createdStamp(),
            title,
            tags: draft.tags,
          }),
        )
        return path
      }
      if (!idPrefix) throw new Error(`已存在同名笔记: ${path}`)
      taken.add(zid)
    }
    throw new Error('同一分钟里创建的卡片太多,稍后再试或换个标题。')
  }

  /**
   * The dialog's escape hatch: an ordinary `.md` with no metadata block.
   *
   * This is also where every other creation path already lands — 待建列表, 右栏待创建, LinkPicker,
   * 编辑器芯片, `[[` 补全 — and none of them may gain an id prefix. A note born from
   * `[[待建链接]]` that got renamed on the way in would break the very link that created it.
   */
  async function createPlainNote(title: string, dir: string): Promise<string> {
    const path = cardPath(dir.trim(), `${sanitizeTitle(title)}.md`)
    return vault.createNote(path)
  }

  async function rebuildCards(): Promise<void> {
    if (backfilling) return
    await db.cards.clear()
    await vault.reloadCards()
    await runBackfill()
    await reload()
    await refreshRelated()
  }

  async function loadSettings(): Promise<void> {
    const raw = await getSetting<unknown>(ZETTEL_SETTINGS_KEY, null)
    if (raw === null) {
      // Never chosen on this device. Read the answer off the library so a second machine converges
      // on the first one's naming, but do not persist the guess: a written setting can no longer be
      // told apart from a chosen one.
      settings.value = {
        ...DEFAULT_ZETTEL_SETTINGS,
        idPrefix: inferIdPrefix(vault.cards),
      }
      settingsPinned.value = false
      return
    }
    settings.value = normalizeSettings(raw)
    settingsPinned.value = true
  }

  async function saveSettings(next: ZettelSettings): Promise<void> {
    settings.value = { ...next }
    settingsPinned.value = true
    await putSetting(ZETTEL_SETTINGS_KEY, settings.value)
  }

  function compareCreated(a: string, b: string): number {
    const ca = byPath.value.get(a)?.created ?? 0
    const cb = byPath.value.get(b)?.created ?? 0
    if (ca === cb) return 0
    if (ca === 0) return 1
    if (cb === 0) return -1
    return ca - cb
  }

  watch(() => vault.revision, scheduleReload)
  // Not `vault.revision`: that moves on every debounced save, so typing would re-rank constantly.
  watch(() => [vault.activePath, vault.bodyRevision] as const, scheduleRelated)

  return {
    edges,
    degrees,
    tagIndex,
    related,
    relatedFor,
    backfill,
    settings,
    settingsPinned,
    livePaths,
    byPath,
    counts,
    inbox,
    orphans,
    allCards,
    cardOf,
    typeOf,
    zidOf,
    createdOf,
    aliasesOf,
    reload,
    refreshRelated,
    warmUp,
    takenZids,
    setCardType,
    addCardMeta,
    createCard,
    createPlainNote,
    rebuildCards,
    loadSettings,
    saveSettings,
  }
})

function comparePath(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true })
}
