<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { cardPath, dirOf, sanitizeTitle, titleOf } from '@/core/vault/paths.ts'
import FileTree from './FileTree.vue'
import Modal from './Modal.vue'
import { useUiStore } from '@/stores/ui.ts'
import { useVaultStore, type TreeNode } from '@/stores/vault.ts'

/**
 * 两条出口：
 * - `open(path)`：打开某篇笔记（文件树、书签行、待建行、新建/重命名后跳转）。
 * - `search(query)`：点标签行时把 `#标签` 交给 App 打开全库搜索面板——标签的「结果列表」
 *   本来就是搜索的强项，比在侧栏里另造一个列表更省事，也复用了现成的命中摘要。
 */
const emit = defineEmits<{ (e: 'open', path: string): void; (e: 'search', query: string): void }>()

const vault = useVaultStore()
/** 折叠目录与置顶/最近两组书签都落在 ui store（持久化 + 跨组件共享）。 */
const ui = useUiStore()

const menu = ref<{ path: string; x: number; y: number } | null>(null)
const renaming = ref<string | null>(null)
const renameValue = ref('')
const renameError = ref<string | null>(null)
const deleting = ref<string | null>(null)
const creating = ref(false)
const createTitle = ref('')
const createDir = ref('')
const createError = ref<string | null>(null)
const renameInput = ref<HTMLInputElement | null>(null)
const createInput = ref<HTMLInputElement | null>(null)

/**
 * 三个分区；数组顺序即活动栏图标顺序，也是指示条按下标平移的依据。
 */
const SECTIONS = ['files', 'unresolved', 'tags'] as const
type Section = (typeof SECTIONS)[number]

const SECTION_LABELS: Record<Section, string> = {
  files: '笔记',
  unresolved: '待建',
  tags: '标签',
}

/**
 * 笔记分区内的三个视图标签：目录树 / 置顶 / 最近打开，一次只渲染一个。
 *
 * 放分区内而不是活动栏：置顶和最近打开本就是「笔记」这件事的三种看法，混排会互相挤占
 * 视野（书签一多就把目录树挤出画面），单独占一个活动栏图标又太重——同级 tab 刚好：
 * 一个入口、三种视图、互不遮挡。
 */
type FileTab = 'tree' | 'pinned' | 'recent'

const section = ref<Section>('files')
/** 当前标签；组件本地状态，不落盘——每次切回笔记区都从目录开始，符合「笔记区 = 找文件」的默认预期。 */
const fileTab = ref<FileTab>('tree')

/**
 * 分区内过滤：一个输入框管全部分区与标签，只做「子串包含」匹配（文件名 / 书签标题 /
 * 目标 / 标签名）。放组件本地而不是 ui store：它是浏览时的临时线索，切分区就该清空，
 * 没有跨会话记住的价值。
 */
const filter = ref('')
/**
 * 防抖后的过滤串（已 trim + 小写），所有匹配逻辑挂在它上面而不是 `filter`：
 * 过滤文件树要整棵重排、再让 FileTree 整棵重渲染，逐字触发在大库上会卡住输入，
 * 停 150ms 后一次性生效。输入框本身仍即时回显（它绑的是 `filter`）。
 */
const query = ref('')
/** 防抖句柄；null 表示当前没有待生效的过滤改动。 */
let filterTimer: ReturnType<typeof setTimeout> | null = null

watch(filter, (value) => {
  const next = value.trim().toLowerCase()
  if (next === query.value) return
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    filterTimer = null
    query.value = next
  }, 150)
})

/**
 * 切分区即清空：上一分区的过滤词留在这一分区只会让人以为「东西丢了」。
 * 标签也一并回目录——回到笔记区时若停在置顶/最近标签，会让人以为目录树没了。
 */
watch(section, () => {
  filter.value = ''
  // 立即生效而不是等防抖：切分区后不该还让上一个分区的过滤词多留 150ms。
  query.value = ''
  if (filterTimer) {
    clearTimeout(filterTimer)
    filterTimer = null
  }
  fileTab.value = 'tree'
})

// 卸载前撤掉防抖：setTimeout 挂到已销毁组件的 ref 上没有意义。
onBeforeUnmount(() => {
  if (filterTimer) clearTimeout(filterTimer)
})

/** 待建 / 标签分区的占位文案；笔记分区跟着当前标签走，见下方 FILE_TAB_PLACEHOLDERS。 */
const FILTER_PLACEHOLDERS: Record<Exclude<Section, 'files'>, string> = {
  unresolved: '过滤待建目标…',
  tags: '过滤标签…',
}

/** 笔记分区内每个标签自己的占位文案：过滤词的语义随标签变化（找树 / 找置顶 / 找最近）。 */
const FILE_TAB_PLACEHOLDERS: Record<FileTab, string> = {
  tree: '过滤文件名…',
  pinned: '过滤置顶…',
  recent: '过滤最近打开…',
}

/** 实际渲染的占位文案：笔记分区看标签，其余分区看分区。aria-label 同源，读屏听到的与看到的一致。 */
const filterPlaceholder = computed(() =>
  section.value === 'files'
    ? FILE_TAB_PLACEHOLDERS[fileTab.value]
    : FILTER_PLACEHOLDERS[section.value],
)

/** 还存在的笔记路径集合：置顶/最近存的是路径快照，笔记删了行就不能再渲染出来。 */
const notePathSet = computed(() => new Set(vault.notes.filter((n) => !n.removedLocal).map((n) => n.path)))

/** 置顶行：按用户置顶的顺序，剔除已删除的。 */
const pinnedRows = computed(() => ui.pinnedPaths.filter((p) => notePathSet.value.has(p)))

/** 最近打开行：队首最新，同样剔除已删除的。 */
const recentRows = computed(() => ui.recentPaths.filter((p) => notePathSet.value.has(p)))

/**
 * 置顶 / 最近两个标签内的过滤：各按「标题 / 路径子串」滤一遍。
 * 与目录标签那份过滤共用同一个输入框和 filter 值，但各标签各滤各的列表——
 * 切标签时 filter 会被清空（见上方 watch），不会把上一个标签的词带过来误伤。
 */
function filterBookmarks(rows: string[], q: string): string[] {
  if (q === '') return rows
  return rows.filter((p) => titleOf(p).toLowerCase().includes(q) || p.toLowerCase().includes(q))
}

/** 过滤后的两组书签行；各自的空态提示按「全量为空」与「过滤后为空」分开给。 */
const pinnedFiltered = computed(() => filterBookmarks(pinnedRows.value, query.value))
const recentFiltered = computed(() => filterBookmarks(recentRows.value, query.value))

/** 活动栏指示条的位置：分区在 SECTIONS 里的下标，× CSS 里的 37px 节距就是位移量。 */
const sectionIndex = computed(() => Math.max(0, SECTIONS.indexOf(section.value)))

/** 分区标题旁的计数徽标：与分区列表同源，点进去看到的数一定对得上。 */
const sectionCounts = computed<Record<Section, number>>(() => ({
  files: vault.notes.length,
  unresolved: vault.unresolvedTargets.length,
  tags: vault.allTags.length,
}))

/** 徽标数字：99 以上一律 99+，免得「1024」把 44px 宽的活动栏图标挤变形。 */
function railText(n: number): string {
  return n > 99 ? '99+' : String(n)
}

/** 待建分区的过滤结果。 */
const unresolvedRows = computed(() => {
  const q = query.value
  if (q === '') return vault.unresolvedTargets
  return vault.unresolvedTargets.filter((t) => t.toLowerCase().includes(q))
})

/** 标签分区的过滤结果。 */
const tagRows = computed(() => {
  const q = query.value
  if (q === '') return vault.allTags
  return vault.allTags.filter((t) => t.tag.toLowerCase().includes(q))
})

/**
 * 递归过滤文件树。目录名命中就整棵保留（用户搜的是这个目录），
 * 否则只保留「子树里还有命中」的目录，命中的笔记原样留下。
 */
function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  if (q === '') return nodes
  const out: TreeNode[] = []
  for (const n of nodes) {
    if (n.kind === 'note') {
      if (n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)) out.push(n)
      continue
    }
    if (n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)) {
      out.push(n)
      continue
    }
    const kids = filterTree(n.children, q)
    if (kids.length > 0) out.push({ ...n, children: kids })
  }
  return out
}

/** 过滤后的文件树；过滤非空时 FileTree 会无视折叠状态展开（expandAll），否则命中藏在收起的目录里。 */
const filteredTree = computed(() => filterTree(vault.tree, query.value))

/**
 * 某分区「过滤后一条不剩、但全量其实有」时的补充说明，避免被误读成数据没了。
 * 跟 `query`（防抖后的值）而非 `filter` 走：它同时驱动 expandAll 与行过滤，
 * 两者必须在同一时刻切换，否则会出现「目录全展开了、词却还没生效」的一帧。
 */
const filteredOut = computed(() => query.value !== '')

const uncachedCount = computed(() => vault.uncached.length)

function open(path: string): void {
  closeMenu()
  emit('open', path)
}

function openMenu(path: string, event: MouseEvent): void {
  const pad = 8
  const width = 148
  const height = 104
  menu.value = {
    path,
    x: Math.min(event.clientX, window.innerWidth - width - pad),
    y: Math.min(event.clientY, window.innerHeight - height - pad),
  }
  window.addEventListener('click', closeMenu, { once: true })
  window.addEventListener('resize', closeMenu, { once: true })
}

/** 右键菜单里的置顶开关：先取路径再收菜单（closeMenu 会把 menu 置空）。 */
function togglePinFromMenu(): void {
  const path = menu.value?.path
  closeMenu()
  if (path) ui.togglePin(path)
}

function closeMenu(): void {
  menu.value = null
}

async function startRename(path: string): Promise<void> {
  closeMenu()
  renaming.value = path
  renameValue.value = path
  renameError.value = null
  await nextTick()
  const input = renameInput.value
  if (!input) return
  input.focus()
  const end = path.lastIndexOf('/')
  const dot = path.toLowerCase().endsWith('.md') ? path.length - 3 : path.length
  input.setSelectionRange(end + 1, dot)
}

async function confirmRename(): Promise<void> {
  const from = renaming.value
  if (!from) return
  const target = renameValue.value.trim()
  if (target === '' || target === from) {
    renaming.value = null
    return
  }
  try {
    const to = await vault.renameNote(from, target)
    renaming.value = null
    emit('open', to)
  } catch (err) {
    renameError.value = err instanceof Error ? err.message : String(err)
  }
}

async function confirmDelete(): Promise<void> {
  const path = deleting.value
  if (!path) return
  await vault.deleteNote(path)
  deleting.value = null
}

async function startCreate(): Promise<void> {
  creating.value = true
  createError.value = null
  // Never the directory: the old field doubled as both, so pressing Enter in it created `notes.md`.
  createTitle.value = ''
  createDir.value = vault.activePath ? dirOf(vault.activePath) : ''
  await nextTick()
  createInput.value?.focus()
}

/** 将要写入的路径，提交前就把文件名（含目录清洗结果）亮出来，避免「建错了地方」的意外。 */
const createPreview = computed(() => {
  const title = createTitle.value.trim()
  if (title === '') return ''
  try {
    return cardPath(createDir.value, `${sanitizeTitle(title)}.md`)
  } catch {
    // 标题清洗不通过（全非法字符 / 空）时先显示为空，错误信息在提交时才给。
    return ''
  }
})

async function confirmCreate(): Promise<void> {
  const title = createTitle.value.trim()
  if (title === '') {
    createError.value = '请填写标题。'
    return
  }
  try {
    const path = await vault.createNote(cardPath(createDir.value, `${sanitizeTitle(title)}.md`))
    creating.value = false
    emit('open', path)
  } catch (err) {
    createError.value = err instanceof Error ? err.message : String(err)
  }
}

function openUnresolved(target: string): void {
  void vault.createFromLink(target).then((path) => emit('open', path))
}

onBeforeUnmount(closeMenu)
</script>

<template>
  <aside class="sidebar">
    <!-- 活动栏：44px 图标竖条（Obsidian / VS Code 模式）。三个图标切换分区，底部 ＋ 新建笔记 -->
    <nav class="rail" aria-label="侧栏分区">
      <!-- 共享指示条：整条在栏内平移，比每个按钮各自 ::before 亮灭多出「滑过去」的方向感 -->
      <span
        class="rail__ind"
        :style="{ transform: 'translateY(' + sectionIndex * 37 + 'px)' }"
        aria-hidden="true"
      ></span>
      <button
        class="rail__btn"
        :class="{ 'rail__btn--on': section === 'files' }"
        title="笔记树"
        aria-label="笔记树"
        @click="section = 'files'"
      >
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
          <path
            d="M4.5 2.5h4.6L12 5.4v8.1H4.5z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linejoin="round"
          />
          <path d="M9.1 2.5v2.9H12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          <path d="M6.3 8.6h3.6M6.3 10.9h2.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>

      <button
        class="rail__btn"
        :class="{ 'rail__btn--on': section === 'unresolved' }"
        title="待建链接"
        aria-label="待建链接"
        @click="section = 'unresolved'"
      >
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
          <path d="M6.4 9.6l3.2-3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          <path
            d="M7.4 4.9l1-1a2.6 2.6 0 013.7 3.7l-1 1"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
          <path
            d="M8.6 11.1l-1 1a2.6 2.6 0 01-3.7-3.7l1-1"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
        <span v-if="sectionCounts.unresolved > 0" class="rail__badge">
          {{ railText(sectionCounts.unresolved) }}
        </span>
      </button>

      <button
        class="rail__btn"
        :class="{ 'rail__btn--on': section === 'tags' }"
        title="标签"
        aria-label="标签"
        @click="section = 'tags'"
      >
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
          <path
            d="M8.6 2.5H13a.5.5 0 01.5.5v4.4a1 1 0 01-.3.7l-5.9 5.9a1 1 0 01-1.4 0l-4.4-4.4a1 1 0 010-1.4l5.9-5.9a1 1 0 01.7-.3z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linejoin="round"
          />
          <circle cx="10.7" cy="5.3" r="1" fill="currentColor" />
        </svg>
        <span v-if="sectionCounts.tags > 0" class="rail__badge">{{ railText(sectionCounts.tags) }}</span>
      </button>

      <div class="rail__gap"></div>

      <!-- 新建笔记：固定在活动栏底部，任何分区下都一键可达（文件树空态提示也指向它） -->
      <button class="rail__btn" title="新建笔记" aria-label="新建笔记" @click="startCreate">
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
          <path
            d="M8 3.6v8.8M3.6 8h8.8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </nav>

    <div class="sidebar__main">
      <!-- 面板头固定一行：分区名 + 计数 -->
      <div class="sidebar__head">
        <span class="head-title">{{ SECTION_LABELS[section] }}</span>
        <em v-if="sectionCounts[section] > 0" class="head-title__n">
          {{ railText(sectionCounts[section]) }}
        </em>
      </div>

      <!-- 笔记分区的视图标签：目录 / 置顶 / 最近，固定在过滤框上方不随列表滚动。
           三者同级互斥，书签不再和目录树混排 -->
      <div v-if="section === 'files'" class="sidebar__tabs">
        <button
          class="tabs__btn"
          :class="{ 'tabs__btn--on': fileTab === 'tree' }"
          @click="fileTab = 'tree'"
        >
          目录
        </button>
        <button
          class="tabs__btn"
          :class="{ 'tabs__btn--on': fileTab === 'pinned' }"
          @click="fileTab = 'pinned'"
        >
          置顶
          <em v-if="pinnedRows.length > 0" class="tabs__n">{{ pinnedRows.length }}</em>
        </button>
        <button
          class="tabs__btn"
          :class="{ 'tabs__btn--on': fileTab === 'recent' }"
          @click="fileTab = 'recent'"
        >
          最近
          <em v-if="recentRows.length > 0" class="tabs__n">{{ recentRows.length }}</em>
        </button>
      </div>

      <!-- 分区内过滤：一个输入框管当前分区/标签，× 一键清掉；空串时不参与任何匹配 -->
      <div class="sidebar__filter">
        <input
          v-model="filter"
          class="sidebar__filter-input"
          :placeholder="filterPlaceholder"
          :aria-label="filterPlaceholder"
          spellcheck="false"
        />
        <button
          v-if="filter !== ''"
          class="sidebar__filter-clear"
          aria-label="清空过滤"
          @click="filter = ''"
        >
          ×
        </button>
      </div>

      <div class="sidebar__scroll">
      <template v-if="section === 'files'">
        <p v-if="vault.notes.length === 0" class="hint">
          还没有笔记。点击左侧活动栏底部的 ＋ 新建一篇,或在设置里连接 Gitee 仓库拉取已有笔记。
        </p>

        <!-- 目录标签：纯文件树，不再有书签行混排 -->
        <template v-else-if="fileTab === 'tree'">
          <p v-if="filteredTree.length === 0 && filteredOut" class="hint">
            没有匹配「{{ filter.trim() }}」的文件。
          </p>
          <!-- 过滤非空时传 expandAll：命中藏在收起的目录里等于没找到 -->
          <FileTree
            :nodes="filteredTree"
            :expand-all="filteredOut"
            @open="open"
            @action="openMenu"
          />
          <p v-if="uncachedCount > 0 && !filteredOut" class="hint hint--foot">
            另有 {{ uncachedCount }} 篇笔记仅建立了索引,点开时会按需下载。
          </p>
        </template>

        <!-- 置顶标签：按用户置顶的顺序，右键行可取消置顶 -->
        <template v-else-if="fileTab === 'pinned'">
          <p v-if="pinnedRows.length === 0" class="hint">
            还没有置顶。右键文件树或这里的书签行 →「置顶」,常看的笔记就会钉住。
          </p>
          <p v-else-if="pinnedFiltered.length === 0" class="hint">
            没有匹配「{{ filter.trim() }}」的置顶。
          </p>
          <ul v-else class="list">
            <li v-for="p in pinnedFiltered" :key="p">
              <button
                class="list__row"
                :class="{ 'list__row--active': vault.activePath === p }"
                @click="open(p)"
                @contextmenu.prevent="openMenu(p, $event)"
              >
                <!-- 图钉标记：与「最近」标签里的普通行拉开，一眼看出这行是被你钉住的 -->
                <svg class="row-pin" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path
                    d="M6 2.2h4M8 2.2v4M4.8 6.2h6.4l.8 3H4zM8 9.2v4.6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
                <span class="list__name">{{ titleOf(p) }}</span>
                <!-- 所在目录：行脱离了树，不标路径就分不清同名笔记在哪个目录 -->
                <span v-if="dirOf(p)" class="list__meta">{{ dirOf(p) }}</span>
              </button>
            </li>
          </ul>
        </template>

        <!-- 最近标签：时间倒序，列表末尾一键清空（原组头的「清空」挪到这里） -->
        <template v-else>
          <p v-if="recentRows.length === 0" class="hint">
            还没有最近打开的笔记。打开过的会按时间倒序收在这里,最多 10 条。
          </p>
          <p v-else-if="recentFiltered.length === 0" class="hint">
            没有匹配「{{ filter.trim() }}」的最近打开。
          </p>
          <ul v-else class="list">
            <li v-for="p in recentFiltered" :key="p">
              <button
                class="list__row"
                :class="{ 'list__row--active': vault.activePath === p }"
                @click="open(p)"
                @contextmenu.prevent="openMenu(p, $event)"
              >
                <span class="list__name">{{ titleOf(p) }}</span>
                <span v-if="dirOf(p)" class="list__meta">{{ dirOf(p) }}</span>
              </button>
            </li>
          </ul>
          <button
            v-if="recentFiltered.length > 0"
            class="tabfoot"
            @click="ui.clearRecents()"
          >
            清空最近打开
          </button>
        </template>
      </template>

      <template v-else-if="section === 'unresolved'">
        <p v-if="vault.unresolvedTargets.length === 0" class="hint">
          没有待创建的链接。所有 <code>[[双链]]</code> 都能解析到已有笔记。
        </p>
        <p v-else-if="unresolvedRows.length === 0" class="hint">
          没有匹配「{{ filter.trim() }}」的待建目标。
        </p>
        <ul class="list">
          <li v-for="t in unresolvedRows" :key="t">
            <button class="list__row" @click="openUnresolved(t)">
              <span class="list__name">{{ t }}</span>
              <span class="list__meta">创建</span>
            </button>
          </li>
        </ul>
      </template>

      <template v-else>
        <p v-if="vault.allTags.length === 0" class="hint">
          还没有标签。在笔记里写 <code>#标签</code> 即可,支持 <code>#父/子</code> 嵌套。
        </p>
        <p v-else-if="tagRows.length === 0" class="hint">
          没有匹配「{{ filter.trim() }}」的标签。
        </p>
        <!-- 点标签 = 带 `#标签` 打开全库搜索：结果面板复用现成的命中摘要与键盘导航 -->
        <ul class="list">
          <li v-for="t in tagRows" :key="t.tag">
            <button class="list__row" @click="emit('search', '#' + t.tag)">
              <span class="list__name">#{{ t.tag }}</span>
              <span class="list__meta">{{ t.count }}</span>
            </button>
          </li>
        </ul>
      </template>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="menu"
        class="ctxmenu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        @click.stop
      >
        <button class="ctxmenu__item" @click="open(menu.path)">打开</button>
        <!-- 置顶是书签开关：同一条目按当前状态在「置顶/取消置顶」间翻转，不设两个入口 -->
        <button class="ctxmenu__item" @click="togglePinFromMenu">
          {{ ui.isPinned(menu.path) ? '取消置顶' : '置顶' }}
        </button>
        <button class="ctxmenu__item" @click="startRename(menu.path)">重命名 / 移动</button>
        <button class="ctxmenu__item ctxmenu__item--danger" @click="((deleting = menu.path), closeMenu())">
          删除
        </button>
      </div>
    </Teleport>

    <Modal v-if="renaming" title="重命名 / 移动笔记" @close="renaming = null">
      <p class="field__label">
        原路径 <code>{{ renaming }}</code>
      </p>
      <input v-model="renameValue" ref="renameInput" class="field" @keydown.enter="confirmRename" />
      <p class="field__tip">
        可写成 <code>目录/名称.md</code> 来移动。全库指向它的 <code>[[双链]]</code> 会自动改写。
      </p>
      <p v-if="renameError" class="field__error">{{ renameError }}</p>
      <template #footer>
        <button class="btn" @click="renaming = null">取消</button>
        <button class="btn btn--primary" @click="confirmRename">确定</button>
      </template>
    </Modal>

    <Modal v-if="deleting" title="删除笔记" @close="deleting = null">
      <p>
        确定删除 <strong>{{ titleOf(deleting) }}</strong> 吗?
      </p>
      <p class="field__tip">
        本地立即删除。若该笔记已同步过,下次同步会一并从 Gitee 仓库删除;历史版本仍可在 Gitee
        的提交记录里找回。指向它的反向链接会变成待创建状态。
      </p>
      <template #footer>
        <button class="btn" @click="deleting = null">取消</button>
        <button class="btn btn--danger" @click="confirmDelete">删除</button>
      </template>
    </Modal>

    <Modal v-if="creating" title="新建笔记" @close="creating = false">
      <p class="field__label">标题</p>
      <input
        v-model="createTitle"
        ref="createInput"
        class="field"
        placeholder="笔记标题,例如 卡片盒笔记法"
        @keydown.enter="confirmCreate"
      />

      <p class="field__label field__label--gap">目录</p>
      <input
        v-model="createDir"
        class="field"
        placeholder="留空为仓库根目录,例如 notes/想法"
        @keydown.enter="confirmCreate"
      />
      <p v-if="createPreview" class="field__tip">
        将创建 <code>{{ createPreview }}</code>
      </p>

      <p v-if="createError" class="field__error">{{ createError }}</p>
      <template #footer>
        <button class="btn" @click="creating = false">取消</button>
        <button class="btn btn--primary" @click="confirmCreate">创建</button>
      </template>
    </Modal>
  </aside>
</template>

<style scoped>
/* 整栏横排：左 44px 活动栏 + 右侧内容面板（sidebar__main）。
   分区导航压成图标竖条,把宽度还给列表。 */
.sidebar {
  display: flex;
  flex-direction: row;
  height: 100%;
  min-width: 0;
  background: var(--bg-elevated);
  border-right: 1px solid var(--border);
}

/* —— 活动栏（Obsidian / VS Code 式图标竖条）:
   底色用比面板更沉的 --bg 做出层次,右缘一条分隔线与内容区断开 —— */
.rail {
  width: 44px;
  flex: none;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 8px 0;
  background: var(--bg);
  border-right: 1px solid var(--border);
}

.rail__btn {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  transition: background-color 0.12s ease, color 0.12s ease;
}

.rail__btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* 选中态:accent 淡底 + 指示条。hover 不再变色,免得选中项悬停时闪一下。 */
.rail__btn--on {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.rail__btn--on:hover {
  background: var(--accent-soft);
  color: var(--accent-text);
}

/* 共享指示条：top 17 = 栏顶距 8 +（按钮 34 − 条 16）/ 2；位移量由模板按下标 × 37 计算，
   整条滑过去而不是每个按钮各自亮灭，方向感就是这么来的。reduced-motion 下位移瞬时完成。 */
.rail__ind {
  position: absolute;
  left: 0;
  top: 17px;
  width: 3px;
  height: 16px;
  border-radius: 0 2px 2px 0;
  background: var(--accent);
  transition: transform 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}

/* 计数徽标挂图标右上角;99 以上在脚本里已折成 99+,这里只管装下 3 个字符。 */
.rail__badge {
  position: absolute;
  top: 0;
  right: 0;
  min-width: 15px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--bg-elevated);
  color: var(--text-muted);
  font-size: 9px;
  font-style: normal;
  line-height: 14px;
  text-align: center;
}

.rail__gap {
  flex: 1;
}

/* —— 活动栏右侧的面板主体:头 + 过滤 + 列表的纵向三段 —— */
.sidebar__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.sidebar__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

/* 分区名:一行固定高度,计数做成小胶囊跟在名字后面。 */
.head-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.head-title__n {
  font-size: 10.5px;
  font-style: normal;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--bg-hover);
  color: var(--text-muted);
}

/* —— 分区内过滤输入：贴在分区标题下方，× 只在有内容时出现 —— */
.sidebar__filter {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px 0;
}

.sidebar__filter-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-size: 12.5px;
  outline: none;
}

.sidebar__filter-input:focus {
  border-color: var(--accent);
}

.sidebar__filter-input::placeholder {
  color: var(--text-muted);
}

.sidebar__filter-clear {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  font-size: 14px;
  line-height: 1;
  color: var(--text-muted);
}

.sidebar__filter-clear:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.sidebar__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 8px 24px;
}

.hint {
  margin: 6px 4px 12px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-muted);
}

.hint code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

.hint--foot {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
}

.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.list__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 13.5px;
  text-align: left;
  transition: background-color 0.12s ease;
}

.list__row:hover {
  background: var(--bg-hover);
}

/* 正在看的这篇：与文件树的 row--active 同一套底色，两处高亮永远指向同一篇 */
.list__row--active {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.list__row--active:hover {
  background: var(--accent-soft);
}

/* —— 笔记分区的视图标签：目录 / 置顶 / 最近。与右栏「链接 / 信息」共用同一套页签样式 —— */
.sidebar__tabs {
  display: flex;
  gap: 2px;
  padding: 6px 8px 0;
}

.tabs__btn {
  flex: 1;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--text-muted);
  transition: background-color 0.12s ease, color 0.12s ease;
}

.tabs__btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* 选中态：accent 淡底 + accent 文字。hover 必须单独覆盖——否则悬停规则会用 --bg-hover
   盖掉选中页签的淡底，切到「置顶」再移上去就像高亮丢了（与活动栏 rail__btn 同样的处理） */
.tabs__btn--on {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.tabs__btn--on:hover {
  background: var(--accent-soft);
  color: var(--accent-text);
}

/* 页签计数：置顶/最近各显各的条数；0 时模板里 v-if 不渲染，空页签不挂个 0 噪音 */
.tabs__n {
  margin-left: 2px;
  font-size: 10.5px;
  font-style: normal;
  opacity: 0.75;
}

/* 「最近」列表末尾的清空入口：原组头按钮挪到列表尾，不占一行组头 */
.tabfoot {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: left;
  transition: background-color 0.12s ease, color 0.12s ease;
}

.tabfoot:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* 置顶行的图钉标记：用 accent 与普通行拉开，行内其余文字仍是常规色 */
.row-pin {
  flex: none;
  color: var(--accent);
}

.list__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list__meta {
  flex: none;
  font-size: 11px;
  color: var(--text-muted);
}

.ctxmenu {
  position: fixed;
  z-index: 90;
  min-width: 148px;
  padding: 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 10px 30px var(--shadow-color);
}

.ctxmenu__item {
  display: block;
  width: 100%;
  padding: 6px 9px;
  border-radius: 5px;
  font-size: 13px;
  text-align: left;
}

.ctxmenu__item:hover {
  background: var(--bg-hover);
}

.ctxmenu__item--danger:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

.field {
  width: 100%;
  padding: 8px 10px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  outline: none;
}

.field:focus {
  border-color: var(--accent);
}

.field__label {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--text-muted);
}

.field__label--gap {
  margin-top: 14px;
}

.field__label code {
  color: var(--text);
}

.field__tip {
  margin: 8px 0 0;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-muted);
}

.field__tip code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

.field__error {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--danger);
}

.btn {
  padding: 6px 14px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  font-size: 13px;
}

.btn:hover {
  background: var(--bg-hover);
}

.btn--primary {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-text);
}

.btn--danger {
  background: var(--danger-soft);
  border-color: var(--danger);
  color: var(--danger);
}
</style>
