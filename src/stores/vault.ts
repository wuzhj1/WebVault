import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { db, type LinkRow, type NoteMeta, type TagRow } from '@/core/db.ts'
import { gitBlobSha } from '@/core/vault/hash.ts'
import * as opfs from '@/core/vault/opfs.ts'
import {
  dirOf,
  ensureMdExt,
  isNotePath,
  joinPath,
  normalizePath,
  titleOf,
} from '@/core/vault/paths.ts'
import { parseNote } from '@/core/parse/links.ts'
import { rewriteWikilinks } from '@/core/parse/rewrite.ts'
import {
  buildResolver,
  isAttachmentTarget,
  preferredLinkText,
  resolveTarget,
  type Resolver,
} from '@/core/index/resolve.ts'
import { needsRemoteDelete } from '@/core/sync/remote-diff.ts'

export interface TreeNode {
  name: string
  path: string
  kind: 'dir' | 'note'
  children: TreeNode[]
}

export interface BacklinkEntry {
  path: string
  title: string
  line: number
  context: string
  embed: boolean
}

export interface OutgoingEntry {
  target: string
  targetPath: string | null
  alias: string | null
  heading: string | null
  embed: boolean
  line: number
  attachment: boolean
}

function newMeta(path: string): NoteMeta {
  return {
    path,
    title: titleOf(path),
    baseSha: null,
    localSha: null,
    remoteSha: null,
    mtime: Date.now(),
    size: 0,
    dirty: 0,
    cached: 0,
    removedLocal: 0,
    removedRemote: 0,
  }
}

export const useVaultStore = defineStore('vault', () => {
  const notes = shallowRef<NoteMeta[]>([])
  const ready = ref(false)
  const activePath = ref<string | null>(null)
  const fatal = ref<string | null>(null)
  /** Set when OPFS came back empty while the metadata index still knew about notes. */
  const storageWasWiped = ref(false)
  const inbound = shallowRef<BacklinkEntry[]>([])
  const outgoing = shallowRef<OutgoingEntry[]>([])
  const unresolvedTargets = shallowRef<string[]>([])
  const allTags = shallowRef<{ tag: string; count: number }[]>([])
  /** Bumped when the sync engine rewrites the body of the note currently open. */
  const bodyRevision = ref(0)

  const resolver = computed<Resolver>(() => buildResolver(notes.value))
  const byPath = computed(() => new Map(notes.value.map((n) => [n.path, n])))

  const tree = computed<TreeNode[]>(() => {
    const root: TreeNode[] = []
    const dirs = new Map<string, TreeNode>()

    const ensureDir = (dirPath: string): TreeNode[] => {
      if (dirPath === '') return root
      const existing = dirs.get(dirPath)
      if (existing) return existing.children
      const node: TreeNode = {
        name: dirPath.slice(dirPath.lastIndexOf('/') + 1),
        path: dirPath,
        kind: 'dir',
        children: [],
      }
      dirs.set(dirPath, node)
      ensureDir(dirOf(dirPath)).push(node)
      return node.children
    }

    for (const n of notes.value) {
      if (n.removedLocal) continue
      ensureDir(dirOf(n.path)).push({
        name: n.title,
        path: n.path,
        kind: 'note',
        children: [],
      })
    }

    const sortNodes = (list: TreeNode[]): void => {
      list.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
      })
      for (const n of list) if (n.kind === 'dir') sortNodes(n.children)
    }
    sortNodes(root)
    return root
  })

  const activeNote = computed(() =>
    activePath.value ? byPath.value.get(activePath.value) ?? null : null,
  )
  const pendingUpload = computed(() => notes.value.filter((n) => n.dirty || n.removedLocal).length)
  /** Notes we know exist remotely but have no local body yet. */
  const uncached = computed(() => notes.value.filter((n) => !n.cached && !n.removedLocal))

  async function init(): Promise<void> {
    if (!opfs.isOpfsSupported()) {
      fatal.value =
        '当前浏览器不支持 OPFS(源私有文件系统),无法在本地保存笔记。请使用较新的 Chrome / Edge / Safari,并通过 HTTPS 或 localhost 访问。'
      return
    }
    try {
      await opfs.persistedStorageGranted()
      await reconcile()
      ready.value = true
    } catch (err) {
      fatal.value = err instanceof Error ? err.message : String(err)
    }
  }

  /**
   * Bring OPFS and the metadata index back into agreement. Handles three real cases:
   * files created outside the app, notes deleted outside the app, and Safari's ITP
   * wiping OPFS while IndexedDB survives.
   */
  async function reconcile(): Promise<void> {
    const onDisk = new Set(await opfs.listNotePaths())
    const stored = await db.notes.toArray()

    // A tombstone for a file the remote never held can never be pushed; without this it
    // would sit in the pending-upload count forever.
    const stale = new Set(
      stored.filter((n) => n.removedLocal && n.remoteSha === null).map((n) => n.path),
    )
    if (stale.size > 0) await db.notes.bulkDelete([...stale])
    const known = stored.filter((n) => !stale.has(n.path))

    if (known.length > 0 && onDisk.size === 0) {
      storageWasWiped.value = true
      // Keep the index: the sync store re-pulls bodies from Gitee using remoteSha.
      const reset = known.map((n) => ({ ...n, cached: 0 as const }))
      await db.notes.bulkPut(reset)
      notes.value = reset
      await refreshDerived()
      return
    }
    storageWasWiped.value = false

    const storedPaths = new Set(known.map((n) => n.path))
    const adopted: NoteMeta[] = []
    for (const path of onDisk) {
      if (storedPaths.has(path)) continue
      const content = (await opfs.readNote(path)) ?? ''
      const meta = newMeta(path)
      meta.localSha = await gitBlobSha(content)
      meta.baseSha = meta.localSha
      meta.size = content.length
      meta.cached = 1
      // Never pushed, so it has to ride along on the first sync.
      meta.dirty = 1
      adopted.push(meta)
      await reindexContent(path, content)
    }
    if (adopted.length > 0) await db.notes.bulkPut(adopted)

    // Notes the index says are cached but that are gone from disk.
    const lost: NoteMeta[] = []
    for (const n of known) {
      if (n.removedLocal || onDisk.has(n.path)) continue
      lost.push(n.cached ? { ...n, cached: 0 } : n)
    }
    if (lost.length > 0) await db.notes.bulkPut(lost)

    if ((await db.notes.count()) === 0 && onDisk.size === 0) {
      await db.links.clear()
      await db.tags.clear()
    }

    notes.value = await db.notes.toArray()
    await refreshDerived()
  }

  async function refreshDerived(): Promise<void> {
    const r = buildResolver(notes.value)

    const links = await db.links.toArray()
    let drifted = false
    for (const l of links) {
      const resolved = resolveTarget(r, l.target)
      if (resolved !== l.targetPath) {
        l.targetPath = resolved
        drifted = true
      }
    }
    if (drifted) await db.links.bulkPut(links)

    const unresolved = new Map<string, number>()
    for (const l of links) {
      if (l.targetPath === null && l.target !== '' && !isAttachmentTarget(l.target)) {
        unresolved.set(l.target, (unresolved.get(l.target) ?? 0) + 1)
      }
    }
    unresolvedTargets.value = [...unresolved.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t]) => t)

    const tags = await db.tags.toArray()
    const counts = new Map<string, number>()
    for (const t of tags) counts.set(t.tag, (counts.get(t.tag) ?? 0) + 1)
    allTags.value = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag, count]) => ({ tag, count }))

    await refreshActiveLinks()
  }

  async function refreshActiveLinks(): Promise<void> {
    const path = activePath.value
    if (!path) {
      inbound.value = []
      outgoing.value = []
      return
    }
    const inRows = await db.links.where('targetPath').equals(path).toArray()
    inbound.value = inRows
      .filter((l) => l.src !== path)
      .sort((a, b) => a.src.localeCompare(b.src) || a.line - b.line)
      .map((l) => ({
        path: l.src,
        title: titleOf(l.src),
        line: l.line,
        context: l.context,
        embed: l.embed === 1,
      }))

    const outRows = await db.links.where('src').equals(path).toArray()
    outgoing.value = outRows
      .sort((a, b) => a.line - b.line)
      .map((l) => ({
        target: l.target,
        targetPath: l.targetPath,
        alias: l.alias,
        heading: l.heading,
        embed: l.embed === 1,
        line: l.line,
        attachment: isAttachmentTarget(l.target),
      }))
  }

  async function reindexContent(path: string, content: string): Promise<void> {
    const { links, tags } = parseNote(content)
    const r = resolver.value

    const linkRows: LinkRow[] = links.map((l) => ({
      src: path,
      target: l.target,
      targetPath: resolveTarget(r, l.target),
      alias: l.alias,
      heading: l.heading,
      blockRef: l.blockRef,
      embed: l.embed ? 1 : 0,
      line: l.line,
      context: l.context,
    }))
    const tagRows: TagRow[] = tags.map((t) => ({ tag: t.tag, path, line: t.line }))

    await db.transaction('rw', db.links, db.tags, async () => {
      await db.links.where('src').equals(path).delete()
      await db.tags.where('path').equals(path).delete()
      if (linkRows.length) await db.links.bulkAdd(linkRows)
      if (tagRows.length) await db.tags.bulkAdd(tagRows)
    })
  }

  async function readBody(path: string): Promise<string | null> {
    const meta = byPath.value.get(path)
    if (meta && !meta.cached) return null
    return opfs.readNote(path)
  }

  async function openNote(path: string): Promise<void> {
    activePath.value = path
    await refreshActiveLinks()
  }

  /** Re-read the metadata index after the sync engine changed it behind our back. */
  async function reloadNotes(): Promise<void> {
    notes.value = await db.notes.toArray()
    await refreshDerived()
  }

  /** Called by the sync engine after it writes a body from the network. */
  async function notifyBodyChanged(path: string): Promise<void> {
    await reloadNotes()
    if (activePath.value === path) bodyRevision.value++
  }

  /** Write a body to OPFS and refresh everything derived from it. */
  async function saveBody(path: string, content: string, markDirty = true): Promise<NoteMeta> {
    await opfs.writeNote(path, content)
    const sha = await gitBlobSha(content)
    const prev = byPath.value.get(path)
    const meta: NoteMeta = {
      ...(prev ?? newMeta(path)),
      path,
      title: titleOf(path),
      localSha: sha,
      size: content.length,
      mtime: Date.now(),
      cached: 1,
      dirty: markDirty ? 1 : (prev?.dirty ?? 0),
      removedLocal: 0,
    }
    await db.notes.put(meta)
    await reindexContent(path, content)
    notes.value = await db.notes.toArray()
    if (activePath.value === path) await refreshActiveLinks()
    else await refreshDerived()
    return meta
  }

  async function createNote(rawPath: string, content = ''): Promise<string> {
    const path = normalizePath(ensureMdExt(rawPath))
    if (!isNotePath(path)) throw new Error('只能创建 .md 笔记')
    if (byPath.value.has(path)) return path

    await opfs.writeNote(path, content)
    const sha = await gitBlobSha(content)
    const meta: NoteMeta = {
      ...newMeta(path),
      localSha: sha,
      baseSha: sha,
      size: content.length,
      cached: 1,
      dirty: 1,
    }
    await db.notes.put(meta)
    await reindexContent(path, content)
    notes.value = await db.notes.toArray()
    await refreshDerived()
    return path
  }

  /**
   * Rename/move a note. Rewrites every inbound `[[link]]` across the vault so nothing
   * silently becomes a dangling reference.
   */
  async function renameNote(from: string, rawTo: string): Promise<string> {
    const to = normalizePath(ensureMdExt(rawTo))
    if (from === to) return from
    if (byPath.value.has(to)) throw new Error(`已存在同名笔记: ${to}`)

    const body = (await opfs.readNote(from)) ?? ''
    await opfs.writeNote(to, body)
    await opfs.deleteNote(from)

    const prev = byPath.value.get(from) ?? newMeta(from)
    await db.notes.delete(from)
    const meta: NoteMeta = {
      ...prev,
      path: to,
      title: titleOf(to),
      mtime: Date.now(),
      dirty: 1,
      cached: 1,
      removedLocal: 0,
    }
    await db.notes.put(meta)

    // A delete followed by an add at a new path is how git records a move, so the old
    // path must stay queued for deletion on the remote — but only if it ever got there.
    if (needsRemoteDelete(prev)) {
      const tombstone: NoteMeta = {
        ...newMeta(from),
        baseSha: prev.baseSha,
        remoteSha: prev.remoteSha,
        localSha: prev.localSha,
        cached: 0,
        dirty: 0,
        removedLocal: 1,
      }
      await db.notes.put(tombstone)
    }

    await db.transaction('rw', db.links, db.tags, async () => {
      const ownLinks = await db.links.where('src').equals(from).toArray()
      const ownTags = await db.tags.where('path').equals(from).toArray()
      await db.links.where('src').equals(from).delete()
      await db.tags.where('path').equals(from).delete()
      if (ownLinks.length) await db.links.bulkAdd(ownLinks.map((l) => ({ ...l, src: to })))
      if (ownTags.length) await db.tags.bulkAdd(ownTags.map((t) => ({ ...t, path: to })))
    })

    await rewriteInboundLinks(from, to)
    notes.value = await db.notes.toArray()
    if (activePath.value === from) activePath.value = to
    await refreshDerived()
    return to
  }

  /** Rewrite `[[old]]` -> `[[new]]` in every other note, preserving alias/heading. */
  async function rewriteInboundLinks(oldPath: string, newPath: string): Promise<number> {
    const oldTitle = titleOf(oldPath)
    const inboundRows = await db.links.where('targetPath').equals(oldPath).toArray()
    const sources = [...new Set(inboundRows.map((l) => l.src))].filter((s) => s !== newPath)

    const nextNotes = await db.notes.toArray()
    const futureResolver = buildResolver(
      nextNotes.map((n) => (n.path === oldPath ? { ...n, path: newPath, title: titleOf(newPath) } : n)),
    )
    const newText = preferredLinkText(futureResolver, newPath)

    let touched = 0
    for (const src of sources) {
      const body = await opfs.readNote(src)
      if (body === null) continue
      const { text, changed } = rewriteWikilinks(body, {
        shouldRewrite: (target) => {
          const t = target.trim()
          return (
            t === oldPath ||
            stripMd(t) === stripMd(oldPath) ||
            t.toLowerCase() === oldTitle.toLowerCase()
          )
        },
        replacement: () => newText,
      })
      if (changed === 0 || text === body) continue
      await opfs.writeNote(src, text)
      const sha = await gitBlobSha(text)
      const meta = byPath.value.get(src)
      if (meta) {
        await db.notes.put({ ...meta, localSha: sha, size: text.length, mtime: Date.now(), dirty: 1 })
      }
      await reindexContent(src, text)
      touched++
    }
    return touched
  }

  async function deleteNote(path: string): Promise<void> {
    await opfs.deleteNote(path)
    const meta = byPath.value.get(path)
    if (meta && needsRemoteDelete(meta)) {
      // Known to the remote: keep a tombstone so the deletion gets pushed.
      await db.notes.put({ ...meta, cached: 0, removedLocal: 1, dirty: 0, localSha: null })
    } else {
      await db.notes.delete(path)
    }
    await db.transaction('rw', db.links, db.tags, async () => {
      await db.links.where('src').equals(path).delete()
      await db.tags.where('path').equals(path).delete()
    })
    if (activePath.value === path) activePath.value = null
    notes.value = await db.notes.toArray()
    await refreshDerived()
  }

  /** Where a brand-new note should live when created from an unresolved `[[link]]`. */
  function pathForNewNote(target: string): string {
    const t = target.trim().replace(/^\.\//, '')
    const base = activePath.value ? dirOf(activePath.value) : ''
    return normalizePath(t.includes('/') ? ensureMdExt(t) : joinPath(base, ensureMdExt(t)))
  }

  async function createFromLink(target: string): Promise<string> {
    if (isAttachmentTarget(target)) throw new Error('附件类型暂不支持创建')
    const resolved = resolveTarget(resolver.value, target)
    if (resolved) return resolved
    return createNote(pathForNewNote(target))
  }

  /** Link suggestions for the `[[` autocomplete popup. */
  function suggestLinks(query: string): { html: string; value: string }[] {
    const q = query.trim().toLowerCase()
    const pool = notes.value.filter((n) => !n.removedLocal)
    const scored = pool
      .map((n) => {
        const title = n.title.toLowerCase()
        const path = n.path.toLowerCase()
        let score = -1
        if (q === '') score = 0
        else if (title.startsWith(q)) score = 1
        else if (title.includes(q)) score = 2
        else if (path.includes(q)) score = 3
        return { n, score }
      })
      .filter((s) => s.score >= 0)
      .sort((a, b) => a.score - b.score || a.n.title.localeCompare(b.n.title, 'zh-Hans-CN'))
      .slice(0, 30)

    const items = scored.map(({ n }) => ({
      html: `<span class="hint-title">${escapeHtml(n.title)}</span><span class="hint-path">${escapeHtml(
        dirOf(n.path),
      )}</span>`,
      value: preferredLinkText(resolver.value, n.path),
    }))

    if (q !== '' && resolveTarget(resolver.value, query) === null && !isAttachmentTarget(query)) {
      items.unshift({
        html: `<span class="hint-title">创建 “${escapeHtml(query.trim())}”</span><span class="hint-path">新笔记</span>`,
        value: query.trim(),
      })
    }
    return items
  }

  return {
    notes,
    ready,
    fatal,
    activePath,
    activeNote,
    storageWasWiped,
    tree,
    inbound,
    outgoing,
    unresolvedTargets,
    allTags,
    pendingUpload,
    uncached,
    bodyRevision,
    resolver,
    byPath,
    init,
    reconcile,
    openNote,
    notifyBodyChanged,
    reloadNotes,
    readBody,
    saveBody,
    createNote,
    renameNote,
    deleteNote,
    createFromLink,
    pathForNewNote,
    suggestLinks,
    reindexContent,
    refreshDerived,
  }
})

function stripMd(p: string): string {
  return p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
