<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { dirOf, joinPath, titleOf } from '@/core/vault/paths.ts'
import FileTree from './FileTree.vue'
import Modal from './Modal.vue'
import { useVaultStore } from '@/stores/vault.ts'

const emit = defineEmits<{ (e: 'open', path: string): void }>()

const vault = useVaultStore()

const menu = ref<{ path: string; x: number; y: number } | null>(null)
const renaming = ref<string | null>(null)
const renameValue = ref('')
const renameError = ref<string | null>(null)
const deleting = ref<string | null>(null)
const creating = ref(false)
const createValue = ref('')
const createError = ref<string | null>(null)
const renameInput = ref<HTMLInputElement | null>(null)
const createInput = ref<HTMLInputElement | null>(null)

const section = ref<'files' | 'unresolved' | 'tags'>('files')

const uncachedCount = computed(() => vault.uncached.length)

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
  createValue.value = vault.activePath ? dirOf(vault.activePath) : ''
  await nextTick()
  createInput.value?.focus()
}

async function confirmCreate(): Promise<void> {
  const raw = createValue.value.trim()
  if (raw === '') return
  try {
    const name = raw.endsWith('.md') ? raw : `${raw}.md`
    const path = await vault.createNote(name.includes('/') ? name : joinPath('', name))
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
          v-for="t in (['files', 'unresolved', 'tags'] as const)"
          :key="t"
          class="tabs__btn"
          :class="{ 'tabs__btn--on': section === t }"
          @click="section = t"
        >
          {{ t === 'files' ? '笔记' : t === 'unresolved' ? '待建' : '标签' }}
        </button>
      </nav>
      <button class="icon-btn" title="新建笔记" aria-label="新建笔记" @click="startCreate">＋</button>
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

      <template v-else>
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

    <Modal v-if="creating" title="新建笔记" @close="creating = false">
      <input
        v-model="createValue"
        ref="createInput"
        class="field"
        placeholder="例如 Redis 面试要点,或 00-收集箱/AI/新笔记"
        @keydown.enter="confirmCreate"
      />
      <p class="field__tip">留空 <code>.md</code> 后缀会自动补上;带 <code>/</code> 会创建到对应目录。</p>
      <p v-if="createError" class="field__error">{{ createError }}</p>
      <template #footer>
        <button class="btn" @click="creating = false">取消</button>
        <button class="btn btn--primary" @click="confirmCreate">创建</button>
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
  color: var(--accent);
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
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
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
  background: rgba(243, 139, 168, 0.16);
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
  color: var(--accent);
}

.btn--danger {
  background: rgba(243, 139, 168, 0.14);
  border-color: var(--danger);
  color: var(--danger);
}
</style>
