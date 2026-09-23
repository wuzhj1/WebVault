/**
 * vault store（Pinia）：笔记元数据、派生索引（文件树/双链/标签/卡片）与 OPFS 正文读写的唯一入口。
 *
 * 职责边界：正文永远写 OPFS，索引永远写 Dexie，两者的最终一致由 reconcile 保证；
 * links/tags/cards 等派生数据随时可清空重建，不承载用户唯一内容。
 *
 * 硬约束/注意事项：
 * - NoteMeta 的 dirty/removedLocal 脏标记与墓碑语义直接被同步引擎（core/sync/engine.ts）消费，
 *   改动须与那边对齐；墓碑只在「远端曾有该文件」时才立（needsRemoteDelete）。
 * - 正文写入必须经过 saveBody 或 reindexContent 这条漏斗，否则链接/卡片索引会漂移。
 * - 重命名会改写全库入链并为旧路径留下远端删除墓碑，不能只动文件名。
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { db, putSetting, type CardRow, type LinkRow, type NoteMeta, type TagRow } from '@/core/db.ts'
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
import { cardFromBody, frontmatterTagRows, isZid } from '@/core/zettel/card.ts'
import { needsRemoteDelete } from '@/core/sync/remote-diff.ts'
import { useUiStore } from '@/stores/ui.ts'

/** 文件树的一层节点：目录或笔记。 */
export interface TreeNode {
  name: string
  path: string
  kind: 'dir' | 'note'
  children: TreeNode[]
}

/** 反链面板的一条：谁链到了当前笔记。 */
export interface BacklinkEntry {
  path: string
  title: string
  line: number
  context: string
  embed: boolean
}

/** 出链面板的一条：当前笔记链去了哪里。 */
export interface OutgoingEntry {
  target: string
  targetPath: string | null
  alias: string | null
  heading: string | null
  embed: boolean
  line: number
  attachment: boolean
}

/** 生成一条全零的初始 NoteMeta，代表「从未同步过的新笔记」。 */
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

/** 「上次打开路径」落盘的防抖定时器，避免频繁写设置。 */
let lastOpenTimer: ReturnType<typeof setTimeout> | null = null

/** vault 主 store：元数据索引、派生状态与正文读写的集中入口。 */
export const useVaultStore = defineStore('vault', () => {
  /** 「最近打开」的记账人：ui store 只存本机书签，不反向依赖 vault，无循环引用。 */
  const ui = useUiStore()
  /** 元数据索引的内存镜像（Dexie notes 表全量）；shallowRef：整表替换而非逐项响应。 */
  const notes = shallowRef<NoteMeta[]>([])
  /** 初始化（OPFS 探测 + reconcile）完成后置真。 */
  const ready = ref(false)
  /** 当前打开笔记的路径；null = 没有打开。 */
  const activePath = ref<string | null>(null)
  /** 致命错误（如浏览器不支持 OPFS）；非 null 时应用应展示全屏错误并不再初始化。 */
  const fatal = ref<string | null>(null)
  /** OPFS 被清空、而元数据索引里仍有笔记时置位；sync store 据此触发从远端恢复正文。 */
  const storageWasWiped = ref(false)
  /** 指向当前笔记的反链列表。 */
  const inbound = shallowRef<BacklinkEntry[]>([])
  /** 当前笔记发出的出链列表。 */
  const outgoing = shallowRef<OutgoingEntry[]>([])
  /** 尚无对应笔记的链接目标，按出现次数倒序（附件目标除外）。 */
  const unresolvedTargets = shallowRef<string[]>([])
  /** 全库标签及计数，按次数倒序，供标签面板使用。 */
  const allTags = shallowRef<{ tag: string; count: number }[]>([])
  /** 从 frontmatter 镜像出的卡片索引；纯派生数据，随时可从 OPFS 重建。 */
  const cards = shallowRef<CardRow[]>([])
  /** 同步引擎改写当前打开笔记的正文时自增，编辑器据此重新加载内容。 */
  const bodyRevision = ref(0)

  /** path/标题/zid → 笔记的解析器，随 notes/cards 变化重建。 */
  const resolver = computed<Resolver>(() => buildResolver(notes.value, cards.value))
  /** path → NoteMeta 查表。 */
  const byPath = computed(() => new Map(notes.value.map((n) => [n.path, n])))
  /** path → CardRow 查表。 */
  const cardByPath = computed(() => new Map(cards.value.map((c) => [c.path, c])))

  /**
   * 内容版本号的廉价替代：任何一次保存都会改笔记的 mtime，进而改变这个累加和。
   * 搜索索引与相关卡片排序共用它——若各自算一份，会互相把模块级 MiniSearch 缓存打失效。
   */
  const revision = computed(() => {
    let r = 0
    for (const n of notes.value) r = (r * 31 + n.mtime + n.path.length) % 2147483647
    return r
  })

  /**
   * 侧边栏文件树：按路径推导，目录在前、同级按中文自然排序；已删（removedLocal）笔记不出现。
   * 目录节点按需逐级创建，父目录缺失时向上递归补齐。
   */
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

  /** 当前打开笔记的元数据；没有打开或路径已失效时为 null。 */
  const activeNote = computed(() =>
    activePath.value ? byPath.value.get(activePath.value) ?? null : null,
  )
  /** 待上传条数（脏笔记 + 删除墓碑），驱动同步角标。 */
  const pendingUpload = computed(() => notes.value.filter((n) => n.dirty || n.removedLocal).length)
  /** 已知存在于远端、但本地还没有正文（未缓存）的笔记，预取与按需下载都从这里取活。 */
  const uncached = computed(() => notes.value.filter((n) => !n.cached && !n.removedLocal))

  /** 启动入口：探测 OPFS → 申请持久化存储 → reconcile；任何一步失败都写入 fatal。 */
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
   * 让 OPFS 与元数据索引重新对齐。覆盖三种真实场景：应用之外新建的文件、
   * 应用之外删除的笔记，以及 Safari ITP 清空 OPFS 而 IndexedDB 幸存下来的情况。
   */
  async function reconcile(): Promise<void> {
    const onDisk = new Set(await opfs.listNotePaths())
    const stored = await db.notes.toArray()

    // 远端从未有过的文件的墓碑永远推不出去；不清理的话它会一直挂在待上传计数里。
    const stale = new Set(
      stored.filter((n) => n.removedLocal && n.remoteSha === null).map((n) => n.path),
    )
    if (stale.size > 0) await db.notes.bulkDelete([...stale])
    const known = stored.filter((n) => !stale.has(n.path))

    if (known.length > 0 && onDisk.size === 0) {
      storageWasWiped.value = true
      // 保留索引：sync store 会用 remoteSha 从 Gitee 把正文重新拉回来。
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
      // 从未推送过，因此要随第一次同步一起上传。
      meta.dirty = 1
      adopted.push(meta)
      await reindexContent(path, content)
    }
    if (adopted.length > 0) await db.notes.bulkPut(adopted)

    // 索引说已缓存、磁盘上却不见了的笔记：把 cached 打回 0，等按需重新下载；
    // 已是墓碑的不动（它本来就不该有正文）。
    const lost: NoteMeta[] = []
    for (const n of known) {
      if (n.removedLocal || onDisk.has(n.path)) continue
      lost.push(n.cached ? { ...n, cached: 0 } : n)
    }
    if (lost.length > 0) await db.notes.bulkPut(lost)

    if ((await db.notes.count()) === 0 && onDisk.size === 0) {
      await db.links.clear()
      await db.tags.clear()
      await db.cards.clear()
    }

    notes.value = await db.notes.toArray()
    await refreshDerived()
  }

  /**
   * 刷新全部派生状态，顺序有讲究：先清理卡片表并重载 cards——下面的 resolver 要重新解析所有链接，
   * 而 `[[id]]` 形式的链接只有在 id 索引到位后才能解析；随后修正链接 targetPath 漂移、
   * 汇总未解析目标、统计标签计数，最后刷新当前笔记的双链面板。
   */
  async function refreshDerived(): Promise<void> {
    // 必须先刷 cards：resolver 随后要重新解析所有链接，`[[id]]` 链接只有拿到 id 索引才解析得出。
    const cardRows = await db.cards.toArray()
    const live = new Set(notes.value.filter((n) => !n.removedLocal).map((n) => n.path))
    const staleCards = cardRows.filter((c) => !live.has(c.path))
    if (staleCards.length > 0) await db.cards.bulkDelete(staleCards.map((c) => c.path))
    cards.value = cardRows.filter((c) => live.has(c.path))

    const r = buildResolver(notes.value, cards.value)

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

  /** 重算当前笔记的入链/出链两个面板数据；没有激活笔记时清空两者。 */
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

  /**
   * 所有正文写入都要经过的漏斗，因此卡片索引的维护也只需放在这一处：
   * 事务内删旧建新地重建该笔记的链接/标签行，并写入卡片。
   *
   * @returns 该笔记的永久 id 出现、变化或消失时为 true——其他笔记的 `[[id]]` 链接可能因此改指，
   * 只有全量漂移扫描（refreshDerived）能发现这种情况。
   */
  async function reindexContent(path: string, content: string): Promise<boolean> {
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
    const tagRows: TagRow[] = [
      ...tags.map((t) => ({ tag: t.tag, path, line: t.line })),
      ...frontmatterTagRows(path, content, tags),
    ]
    const card = cardFromBody(path, content)
    const zidChanged = (cardByPath.value.get(path)?.zid ?? '') !== card.zid

    await db.transaction('rw', db.links, db.tags, db.cards, async () => {
      await db.links.where('src').equals(path).delete()
      await db.tags.where('path').equals(path).delete()
      if (linkRows.length) await db.links.bulkAdd(linkRows)
      if (tagRows.length) await db.tags.bulkAdd(tagRows)
      await db.cards.put(card)
    })
    cards.value = [...cards.value.filter((c) => c.path !== path), card]
    return zidChanged
  }

  /** 读正文；stub（cached 为 0）直接返回 null，由调用方触发按需下载。 */
  async function readBody(path: string): Promise<string | null> {
    const meta = byPath.value.get(path)
    if (meta && !meta.cached) return null
    return opfs.readNote(path)
  }

  /** 打开笔记：切换 activePath、刷新双链，并防抖 400ms 落盘「上次打开路径」。 */
  async function openNote(path: string): Promise<void> {
    activePath.value = path
    // 所有打开入口（侧栏/搜索/图谱/右栏/启动定位）都汇到这里，「最近打开」只在此记一次账。
    ui.addRecent(path)
    await refreshActiveLinks()
    if (lastOpenTimer) clearTimeout(lastOpenTimer)
    lastOpenTimer = setTimeout(() => {
      lastOpenTimer = null
      void putSetting('last-open-path', path)
    }, 400)
  }

  /** 同步引擎在我们背后改了元数据索引后，重新读取并刷新派生状态。 */
  async function reloadNotes(): Promise<void> {
    notes.value = await db.notes.toArray()
    await refreshDerived()
  }

  /**
   * 只把卡片索引拉回内存，不重新解析任何链接。回填任务是分块直写 Dexie 的，
   * 若每块都跑一遍 refreshDerived，等于每次都全量扫描链接表，代价不可接受。
   */
  async function reloadCards(): Promise<void> {
    const live = new Set(notes.value.filter((n) => !n.removedLocal).map((n) => n.path))
    cards.value = (await db.cards.toArray()).filter((c) => live.has(c.path))
  }

  /** 同步引擎从网络写入一篇正文后调用：重读索引，若改的正是当前打开的笔记则让编辑器重载。 */
  async function notifyBodyChanged(path: string): Promise<void> {
    await reloadNotes()
    if (activePath.value === path) bodyRevision.value++
  }

  /** 把正文写入 OPFS 并刷新所有由它派生的状态（元数据、链接、标签、卡片）。 */
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
    const zidChanged = await reindexContent(path, content)
    notes.value = await db.notes.toArray()
    // 刚出现的 id 会让其他笔记里的 `[[id]]` 链接首次解析成功，
    // 而只有全量漂移扫描才会重写它们的 targetPath，故此时必须整套刷新。
    if (activePath.value === path && !zidChanged) await refreshActiveLinks()
    else await refreshDerived()
    return meta
  }

  /** 新建笔记：路径归一化并补 .md 后缀；路径非 .md 抛错，已存在则原样返回该路径（幂等）。 */
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
   * 重命名/移动笔记：搬正文、迁元数据与派生索引，并改写全库所有入链 `[[link]]`，
   * 避免静默变成悬空引用。目标已存在时抛错。
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

    // git 记录移动就是「旧路径删除 + 新路径新增」，所以旧路径必须留一条墓碑排队推删除——
    // 但前提是它曾经上过远端（needsRemoteDelete），否则墓碑永远推不出去。
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

    await db.transaction('rw', db.links, db.tags, db.cards, async () => {
      const ownLinks = await db.links.where('src').equals(from).toArray()
      const ownTags = await db.tags.where('path').equals(from).toArray()
      const ownCard = await db.cards.get(from)
      await db.links.where('src').equals(from).delete()
      await db.tags.where('path').equals(from).delete()
      await db.cards.delete(from)
      if (ownLinks.length) await db.links.bulkAdd(ownLinks.map((l) => ({ ...l, src: to })))
      if (ownTags.length) await db.tags.bulkAdd(ownTags.map((t) => ({ ...t, path: to })))
      // id 存在文件里而非文件名里，因此随卡片原样迁移，zid 不变。
      if (ownCard) await db.cards.put({ ...ownCard, path: to })
    })

    await rewriteInboundLinks(from, to)
    notes.value = await db.notes.toArray()
    if (activePath.value === from) activePath.value = to
    await refreshDerived()
    return to
  }

  /** 把每篇其他笔记里的 `[[旧]]` 改写为 `[[新]]`，保留别名/标题锚点；返回改动篇数。 */
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

  /** 删除笔记：正文从 OPFS 移除，派生索引清理；远端知道的才留墓碑等推送。 */
  async function deleteNote(path: string): Promise<void> {
    await opfs.deleteNote(path)
    const meta = byPath.value.get(path)
    if (meta && needsRemoteDelete(meta)) {
      // 远端有这篇：留墓碑，让删除动作随后推送出去。
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

  /** 从未解析的 `[[link]]` 创建新笔记时，新文件该落在哪里：带路径用其本身，否则放在当前笔记同目录。 */
  function pathForNewNote(target: string): string {
    const t = target.trim().replace(/^\.\//, '')
    const base = activePath.value ? dirOf(activePath.value) : ''
    return normalizePath(t.includes('/') ? ensureMdExt(t) : joinPath(base, ensureMdExt(t)))
  }

  /** 点击未解析的链接时调用：已能解析就跳过去，附件类型抛错，否则按链接目标新建笔记。 */
  async function createFromLink(target: string): Promise<string> {
    if (isAttachmentTarget(target)) throw new Error('附件类型暂不支持创建')
    const resolved = resolveTarget(resolver.value, target)
    if (resolved) return resolved
    return createNote(pathForNewNote(target))
  }

  /**
   * `[[` 自动补全弹层的链接建议：按 标题/id 前缀 > 标题/id 包含 > 路径包含 的打分排序，
   * 取前 30 条；查询本身无法解析时额外插一条「创建」项。
   */
  function suggestLinks(query: string): { html: string; value: string }[] {
    const q = query.trim().toLowerCase()
    const typed = query.trim()
    const pool = notes.value.filter((n) => !n.removedLocal)
    const scored = pool
      .map((n) => {
        const title = n.title.toLowerCase()
        const path = n.path.toLowerCase()
        const card = cardByPath.value.get(n.path)
        let score = -1
        if (q === '') score = 0
        else if (title.startsWith(q) || (card?.zid ?? '').startsWith(q)) score = 1
        else if (title.includes(q) || card?.aliases.some((a) => a.toLowerCase().includes(q))) score = 2
        else if (path.includes(q)) score = 3
        return { n, score }
      })
      .filter((s) => s.score >= 0)
      .sort((a, b) => a.score - b.score || a.n.title.localeCompare(b.n.title, 'zh-Hans-CN'))
      .slice(0, 30)

    // 用户完整敲出的 id 就是他想写的链接；这里若替换标题，等于悄悄改写用户意图。
    const idHit = isZid(typed) ? resolveTarget(resolver.value, typed) : null
    const items = scored.map(({ n }) => ({
      html: `<span class="hint-title">${escapeHtml(n.title)}</span><span class="hint-path">${escapeHtml(
        dirOf(n.path),
      )}</span>`,
      value: idHit !== null && idHit === n.path ? typed : preferredLinkText(resolver.value, n.path),
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
    cards,
    cardByPath,
    revision,
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
    reloadCards,
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

/** 去掉 `.md` 后缀（比较链接目标时用，大小写不敏感）。 */
function stripMd(p: string): string {
  return p.toLowerCase().endsWith('.md') ? p.slice(0, -3) : p
}

/** HTML 转义，供链接建议弹层拼 html 片段时防止标题里的标签被当真。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
