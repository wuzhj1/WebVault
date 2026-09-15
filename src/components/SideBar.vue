<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { dirOf, titleOf } from '@/core/vault/paths.ts'
import {
  CARD_TYPES,
  CARD_TYPE_LABELS,
  cardFilename,
  cardPath,
  parseTagList,
  zidStamp,
  type CardType,
} from '@/core/zettel/card.ts'
import FileTree from './FileTree.vue'
import Modal from './Modal.vue'
import { useVaultStore } from '@/stores/vault.ts'
import { useZettelStore } from '@/stores/zettel.ts'

const emit = defineEmits<{ (e: 'open', path: string): void }>()

const vault = useVaultStore()
const zettel = useZettelStore()

const menu = ref<{ path: string; x: number; y: number } | null>(null)
const renaming = ref<string | null>(null)
const renameValue = ref('')
const renameError = ref<string | null>(null)
const deleting = ref<string | null>(null)
const creating = ref(false)
const createTitle = ref('')
const createDir = ref('')
const createType = ref<CardType>('fleeting')
const createTags = ref('')
const createError = ref<string | null>(null)
const renameInput = ref<HTMLInputElement | null>(null)
const createInput = ref<HTMLInputElement | null>(null)

const SECTIONS = ['files', 'unresolved', 'tags', 'cards'] as const
type Section = (typeof SECTIONS)[number]

const SECTION_LABELS: Record<Section, string> = {
  files: '笔记',
  unresolved: '待建',
  tags: '标签',
  cards: '卡片',
}

const section = ref<Section>('files')

const CARD_FILTERS = ['inbox', 'orphans', 'all'] as const
type CardFilter = (typeof CARD_FILTERS)[number]

const CARD_FILTER_LABELS: Record<CardFilter, string> = {
  inbox: '收件箱',
  orphans: '孤儿',
  all: '全部',
}

const CARD_FILTER_HINTS: Record<CardFilter, string> = {
  inbox: '收件箱是空的。新建卡片时选「闪念」,想清楚之后再改成「文献」或「永久」,它就会离开这里。',
  orphans: '没有孤儿卡片。每一篇都至少有一条能解析的 [[双链]]——在卡片盒里,没有链接的卡片等于不存在。',
  all: '还没有笔记。点击右上角 ＋ 新建一张卡片。',
}

const cardFilter = ref<CardFilter>('inbox')

const cardCounts = computed<Record<CardFilter, number>>(() => ({
  inbox: zettel.inbox.length,
  orphans: zettel.orphans.length,
  all: zettel.allCards.length,
}))

const cardRows = computed<{ path: string; meta: string }[]>(() => {
  if (cardFilter.value === 'orphans') {
    return zettel.orphans.map((p) => ({ path: p, meta: orphanMeta(p) }))
  }
  if (cardFilter.value === 'all') {
    return zettel.allCards.map((p) => ({ path: p, meta: typeLabel(p) }))
  }
  return zettel.inbox.map((p) => ({ path: p, meta: stampOf(p) }))
})

const uncachedCount = computed(() => vault.uncached.length)

function typeLabel(path: string): string {
  const type = zettel.typeOf(path)
  return type === 'plain' ? '' : CARD_TYPE_LABELS[type]
}

/** An orphan has no degree left to report, so the only useful subtitle is what it reached for. */
function orphanMeta(path: string): string {
  const pending = zettel.degrees.unresolved.get(path) ?? 0
  return pending > 0 ? `${pending} 个待建链接` : typeLabel(path)
}

/** `2026-09-15 14:23` -> today's clock time, this year's month and day, otherwise the full date. */
function stampOf(path: string): string {
  const m = /^(\d{4})-(\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(zettel.createdOf(path).trim())
  if (!m) return ''
  const now = new Date()
  const year = String(now.getFullYear())
  const today = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  if (m[1] !== year) return `${m[1]}-${m[2]}`
  return m[2] === today ? (m[3] ?? m[2]) : m[2]
}

function open(path: string): void {
  closeMenu()
  emit('open', path)
}

function openMenu(path: string, event: MouseEvent): void {
  const pad = 8
  const width = 148
  const height = 78
  menu.value = {
    path,
    x: Math.min(event.clientX, window.innerWidth - width - pad),
    y: Math.min(event.clientY, window.innerHeight - height - pad),
  }
  window.addEventListener('click', closeMenu, { once: true })
  window.addEventListener('resize', closeMenu, { once: true })
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
  createType.value = zettel.settings.defaultType
  createTags.value = ''
  await nextTick()
  createInput.value?.focus()
}

/** The path that will actually be written, so the id prefix is never a surprise at submit time. */
const createPreview = computed(() => {
  const title = createTitle.value.trim()
  if (title === '') return ''
  try {
    return cardPath(
      createDir.value.trim(),
      cardFilename(zidStamp(), title, { idPrefix: zettel.settings.idPrefix }),
    )
  } catch {
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
    const path = await zettel.createCard({
      title,
      dir: createDir.value,
      type: createType.value,
      tags: parseTagList(createTags.value),
    })
    creating.value = false
    emit('open', path)
  } catch (err) {
    createError.value = err instanceof Error ? err.message : String(err)
  }
}

async function createPlain(): Promise<void> {
  const title = createTitle.value.trim()
  if (title === '') {
    createError.value = '请填写标题。'
    return
  }
  try {
    const path = await zettel.createPlainNote(title, createDir.value)
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
    <div class="sidebar__head">
      <nav class="tabs">
        <button
          v-for="t in SECTIONS"
          :key="t"
          class="tabs__btn"
          :class="{ 'tabs__btn--on': section === t }"
          @click="section = t"
        >
          {{ SECTION_LABELS[t] }}
        </button>
      </nav>
      <button class="icon-btn" title="新建卡片" aria-label="新建卡片" @click="startCreate">＋</button>
    </div>

    <div class="sidebar__scroll">
      <template v-if="section === 'files'">
        <p v-if="vault.notes.length === 0" class="hint">
          还没有笔记。点击右上角 ＋ 新建一篇,或在设置里连接 Gitee 仓库拉取已有笔记。
        </p>
        <FileTree :nodes="vault.tree" @open="open" @action="openMenu" />
        <p v-if="uncachedCount > 0" class="hint hint--foot">
          另有 {{ uncachedCount }} 篇笔记仅建立了索引,点开时会按需下载。
        </p>
      </template>

      <template v-else-if="section === 'unresolved'">
        <p v-if="vault.unresolvedTargets.length === 0" class="hint">
          没有待创建的链接。所有 <code>[[双链]]</code> 都能解析到已有笔记。
        </p>
        <ul class="list">
          <li v-for="t in vault.unresolvedTargets" :key="t">
            <button class="list__row" @click="openUnresolved(t)">
              <span class="list__name">{{ t }}</span>
              <span class="list__meta">创建</span>
            </button>
          </li>
        </ul>
      </template>

      <template v-else-if="section === 'tags'">
        <p v-if="vault.allTags.length === 0" class="hint">
          还没有标签。在笔记里写 <code>#标签</code> 即可,支持 <code>#父/子</code> 嵌套。
        </p>
        <ul class="list">
          <li v-for="t in vault.allTags" :key="t.tag">
            <button class="list__row" @click="section = 'files'">
              <span class="list__name">#{{ t.tag }}</span>
              <span class="list__meta">{{ t.count }}</span>
            </button>
          </li>
        </ul>
      </template>

      <template v-else>
        <nav class="tabs cards__filters">
          <button
            v-for="f in CARD_FILTERS"
            :key="f"
            class="tabs__btn"
            :class="{ 'tabs__btn--on': cardFilter === f }"
            @click="cardFilter = f"
          >
            {{ CARD_FILTER_LABELS[f]
            }}<template v-if="cardCounts[f] > 0"> {{ cardCounts[f] }}</template>
          </button>
        </nav>

        <p v-if="zettel.backfill" class="hint">
          正在建立卡片索引 {{ zettel.backfill.done }}/{{ zettel.backfill.total }}
        </p>

        <p v-if="cardRows.length === 0" class="hint">
          {{ vault.notes.length === 0 ? CARD_FILTER_HINTS.all : CARD_FILTER_HINTS[cardFilter] }}
        </p>
        <ul v-else class="list">
          <li v-for="row in cardRows" :key="row.path">
            <button class="list__row" @click="open(row.path)">
              <span class="list__name">{{ titleOf(row.path) }}</span>
              <span v-if="row.meta" class="list__meta">{{ row.meta }}</span>
            </button>
          </li>
        </ul>
      </template>
    </div>

    <Teleport to="body">
      <div
        v-if="menu"
        class="ctxmenu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        @click.stop
      >
        <button class="ctxmenu__item" @click="open(menu.path)">打开</button>
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

    <Modal v-if="creating" title="新建卡片" @close="creating = false">
      <p class="field__label">标题</p>
      <input
        v-model="createTitle"
        ref="createInput"
        class="field"
        placeholder="一句话能说清的一个想法"
        @keydown.enter="confirmCreate"
      />

      <p class="field__label field__label--gap">目录</p>
      <input
        v-model="createDir"
        class="field"
        placeholder="留空为仓库根目录,例如 00-收集箱/AI"
        @keydown.enter="confirmCreate"
      />
      <p v-if="createPreview" class="field__tip">
        将创建 <code>{{ createPreview }}</code>
      </p>

      <p class="field__label field__label--gap">类型</p>
      <nav class="tabs picker">
        <button
          v-for="t in CARD_TYPES"
          :key="t"
          class="tabs__btn"
          :class="{ 'tabs__btn--on': createType === t }"
          @click="createType = t"
        >
          {{ CARD_TYPE_LABELS[t] }}
        </button>
      </nav>
      <p class="field__tip">
        闪念是还没想清楚的草稿,会留在收件箱里;文献记下别人的说法;永久是想清楚了的原子卡片;索引是
        一组卡片的目录。之后随时能在右侧「信息」里改。
      </p>

      <p class="field__label field__label--gap">标签(可选)</p>
      <input
        v-model="createTags"
        class="field"
        placeholder="卡片盒, 笔记法"
        @keydown.enter="confirmCreate"
      />

      <p v-if="createError" class="field__error">{{ createError }}</p>
      <template #footer>
        <button class="btn btn--ghost" @click="createPlain">只建普通 .md</button>
        <span class="foot__gap"></span>
        <button class="btn" @click="creating = false">取消</button>
        <button class="btn btn--primary" @click="confirmCreate">创建卡片</button>
      </template>
    </Modal>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg-elevated);
  border-right: 1px solid var(--border);
}

.sidebar__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.tabs {
  display: flex;
  flex: 1;
  gap: 2px;
  min-width: 0;
}

.tabs__btn {
  flex: 1;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--text-muted);
  white-space: nowrap;
}

.tabs__btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.tabs__btn--on {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.cards__filters {
  margin-bottom: 8px;
}

.icon-btn {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  font-size: 16px;
  line-height: 1;
  color: var(--text-muted);
}

.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--accent);
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
}

.list__row:hover {
  background: var(--bg-hover);
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

.picker {
  flex: none;
  gap: 6px;
}

.picker .tabs__btn {
  flex: none;
  padding: 4px 12px;
  border: 1px solid var(--border);
}

.picker .tabs__btn--on {
  border-color: var(--accent);
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

.btn--ghost {
  border-color: transparent;
  background: none;
  color: var(--text-muted);
}

.btn--ghost:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.foot__gap {
  flex: 1;
}
</style>
