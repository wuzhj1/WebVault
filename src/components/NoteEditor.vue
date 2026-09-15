<script setup lang="ts">
import Vditor from 'vditor'
import 'vditor/dist/index.css'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  chipFromEvent,
  decorateWikilinks,
  markActiveBlock,
  type WikilinkLookup,
} from '@/core/editor/wikilink-dom.ts'
import { isAttachmentTarget, resolveTarget } from '@/core/index/resolve.ts'
import { useSyncStore } from '@/stores/sync.ts'
import { useVaultStore } from '@/stores/vault.ts'

const emit = defineEmits<{
  (e: 'open-link', path: string): void
  (e: 'pick-link'): void
}>()

const SAVE_DEBOUNCE_MS = 700

/** Vditor resolves its own lazily loaded assets against `cdn`, so it must follow the build base. */
const VDITOR_CDN = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/vditor`

const host = ref<HTMLElement | null>(null)
const state = ref<'empty' | 'loading' | 'ready'>('empty')

let editor: Vditor | null = null
let editorReady = false
let suppressInput = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingValue: string | null = null
let loadedPath: string | null = null

const vault = useVaultStore()
const sync = useSyncStore()

/** Vditor deletes from the `[[` trigger itself, so the inserted value must carry brackets. */
function hintLinks(query: string): { html: string; value: string }[] {
  return vault.suggestLinks(query).map((item) => ({
    html: item.html,
    value: `[[${item.value}]]`,
  }))
}

async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (pendingValue === null || !loadedPath) return
  const path = loadedPath
  const value = pendingValue
  pendingValue = null
  await vault.saveBody(path, value)
  sync.schedulePush()
}

function onInput(value: string): void {
  if (suppressInput || !loadedPath) return
  pendingValue = value
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushSave()
  }, SAVE_DEBOUNCE_MS)
}

function setContent(body: string, enabled: boolean): void {
  suppressInput = true
  editor?.setValue(body, true)
  if (enabled) editor?.enable()
  else editor?.disabled()
  suppressInput = false
}

async function loadActive(): Promise<void> {
  if (!editorReady) return
  await flushSave()

  const path = vault.activePath
  if (!path) {
    loadedPath = null
    state.value = 'empty'
    setContent('', false)
    return
  }

  loadedPath = path
  const body = await vault.readBody(path)
  if (body === null) {
    // Index-only stub: the sync store is fetching it, bodyRevision will wake us up.
    state.value = 'loading'
    setContent('', false)
    if (sync.available) void sync.fetchBody(path)
    return
  }

  state.value = 'ready'
  setContent(body, true)
}

function lookupLink(target: string): WikilinkLookup {
  if (isAttachmentTarget(target)) return { kind: 'asset', path: null }
  const path = resolveTarget(vault.resolver, target)
  return path === null ? { kind: 'new', path: null } : { kind: 'note', path }
}

let irRoot: HTMLElement | null = null
let observer: MutationObserver | null = null
let decorateQueued = false
let activeBlock: HTMLElement | null = null

function queueDecorate(): void {
  if (decorateQueued) return
  decorateQueued = true
  setTimeout(() => {
    decorateQueued = false
    runDecorate()
  }, 0)
}

function runDecorate(): void {
  if (!irRoot) return
  activeBlock = markActiveBlock(irRoot)
  decorateWikilinks(irRoot, lookupLink)
  // Discard the records our own decoration produced, otherwise every pass re-triggers the next.
  observer?.takeRecords()
}

/**
 * The caret's block stays raw markdown, so only a move to a *different* block can leave
 * behind something worth decorating. Plain caret motion inside one block does no work.
 */
function onSelectionChange(): void {
  if (!irRoot) return
  if (markActiveBlock(irRoot) === activeBlock) return
  queueDecorate()
}

async function followLink(raw: string): Promise<void> {
  const target = raw.trim()
  if (target === '' || isAttachmentTarget(target)) return
  const resolved = resolveTarget(vault.resolver, target)
  if (resolved !== null) {
    emit('open-link', resolved)
    return
  }
  emit('open-link', await vault.createFromLink(target))
}

/** Without this the browser moves the caret into the chip, unfolding it before the click. */
function onEditorMouseDown(event: MouseEvent): void {
  if (chipFromEvent(event.target)) event.preventDefault()
}

function onEditorClick(event: MouseEvent): void {
  const chip = chipFromEvent(event.target)
  if (chip) {
    event.preventDefault()
    event.stopPropagation()
    void followLink(chip.dataset.target ?? '')
    return
  }

  // Inside the block being edited the link shows as raw text; Ctrl/⌘-click still follows it.
  if (!(event.ctrlKey || event.metaKey)) return
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return
  const node = selection.anchorNode
  if (!node || node.nodeType !== Node.TEXT_NODE) return

  const text = node.textContent ?? ''
  const offset = selection.anchorOffset
  const open = text.lastIndexOf('[[', offset)
  if (open === -1) return
  const close = text.indexOf(']]', open + 2)
  if (close === -1 || close < offset) return

  const raw = text
    .slice(open + 2, close)
    .split('|')[0]
    .split('#')[0]
    .split('^')[0]
    .trim()
  if (raw === '') return

  event.preventDefault()
  event.stopPropagation()
  void followLink(raw)
}

/** Uses Vditor's own insertion API: safe in IR mode, unlike touching the contenteditable DOM. */
function insertLink(target: string): void {
  editor?.insertValue(`[[${target}]]`, true)
  editor?.focus()
}

function startDecorating(): void {
  irRoot = host.value?.querySelector<HTMLElement>('.vditor-ir .vditor-reset') ?? null
  if (!irRoot) return
  observer = new MutationObserver(() => queueDecorate())
  observer.observe(irRoot, { childList: true, characterData: true, subtree: true })
  document.addEventListener('selectionchange', onSelectionChange)
  queueDecorate()
}

function stopDecorating(): void {
  observer?.disconnect()
  observer = null
  document.removeEventListener('selectionchange', onSelectionChange)
  irRoot = null
  activeBlock = null
}

onMounted(() => {
  if (!host.value) return
  editor = new Vditor(host.value, {
    mode: 'ir',
    theme: 'dark',
    icon: 'ant',
    lang: 'zh_CN',
    cdn: VDITOR_CDN,
    height: '100%',
    minHeight: 240,
    cache: { enable: false },
    placeholder: '开始记录… 输入 [[ 链接其它笔记,Ctrl/⌘+K 打开链接选择器',
    undoDelay: 0,
    toolbar: [
      'headings',
      'bold',
      'italic',
      'strike',
      '|',
      'quote',
      'list',
      'ordered-list',
      'check',
      '|',
      'code',
      'inline-code',
      'table',
      'link',
      '|',
      'undo',
      'redo',
      '|',
      'edit-mode',
      'outline',
      'fullscreen',
    ],
    toolbarConfig: { pin: true },
    counter: { enable: true, type: 'text' },
    hint: { delay: 100, parse: false, extend: [{ key: '[[', hint: hintLinks }] },
    preview: {
      hljs: { style: 'github', lineNumber: false },
      theme: { current: 'dark' },
    },
    after: () => {
      editorReady = true
      host.value?.addEventListener('mousedown', onEditorMouseDown, true)
      host.value?.addEventListener('click', onEditorClick, true)
      startDecorating()
      void loadActive()
    },
    input: onInput,
  })
})

onBeforeUnmount(async () => {
  stopDecorating()
  host.value?.removeEventListener('mousedown', onEditorMouseDown, true)
  host.value?.removeEventListener('click', onEditorClick, true)
  await flushSave()
  editor?.destroy()
  editor = null
  editorReady = false
})

watch(
  () => [vault.activePath, vault.bodyRevision] as const,
  () => {
    void loadActive()
  },
)

watch(
  () => sync.available,
  (ok) => {
    if (ok && state.value === 'loading' && loadedPath) void sync.fetchBody(loadedPath)
  },
)

defineExpose({ flushSave, insertLink })
</script>

<template>
  <div class="editor">
    <div v-if="state === 'empty'" class="editor__placeholder">
      <div class="editor__placeholder-inner">
        <h2>WebVault</h2>
        <p>从左侧选择一篇笔记,或新建一篇开始。</p>
        <p class="muted">
          输入 <code>[[</code> 触发链接补全 · <code>Ctrl/⌘ + K</code> 链接选择器 ·
          <code>Ctrl/⌘ + F</code> 全库搜索
        </p>
        <button class="btn btn--primary" @click="emit('pick-link')">打开链接选择器</button>
      </div>
    </div>
    <div v-show="state !== 'empty'" ref="host" class="editor__host"></div>
    <div v-if="state === 'loading'" class="editor__loading">
      <span class="spinner"></span>
      正在从 Gitee 下载这篇笔记…
    </div>
  </div>
</template>

<style scoped>
.editor {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg);
}

.editor__host {
  flex: 1;
  min-height: 0;
}

.editor__host :deep(.vditor) {
  height: 100%;
  border: none;
  border-radius: 0;
  background: var(--bg);
}

.editor__host :deep(.vditor-toolbar) {
  padding: 4px 14px !important;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
}

.editor__host :deep(.vditor-content) {
  background: var(--bg);
}

.editor__host :deep(.vditor-reset) {
  padding: 18px 26px 50vh;
  color: var(--text);
  font-size: 15px;
  line-height: 1.85;
  caret-color: var(--accent);
}

/* Brackets and the aliased path are hidden with CSS, never removed: IR mode serializes
   this DOM back to markdown, so the characters have to stay for the note to round-trip. */
.editor__host :deep(.wl) {
  padding: 1px 4px;
  margin: 0 -2px;
  border-radius: 5px;
  background: var(--accent-soft);
  color: var(--accent);
  cursor: pointer;
  box-decoration-break: clone;
}

.editor__host :deep(.wl:hover) {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.editor__host :deep(.wl--new) {
  background: transparent;
  color: var(--text-muted);
  text-decoration: underline dashed;
  text-underline-offset: 3px;
}

.editor__host :deep(.wl--new:hover) {
  color: var(--warn);
  text-decoration: underline dashed;
  text-underline-offset: 3px;
}

.editor__host :deep(.wl--asset) {
  background: transparent;
  color: var(--text-muted);
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  cursor: default;
}

.editor__host :deep(.wl--embed)::before {
  content: '嵌入 ';
  font-size: 11px;
  opacity: 0.75;
}

.editor__host :deep(.wl__bracket),
.editor__host :deep(.wl--alias .wl__path) {
  display: none;
}

.editor__host :deep(.wl__anchor) {
  opacity: 0.7;
}

/* The block holding the caret shows real markdown, so the link can still be edited. */
.editor__host :deep(.wl-active .wl) {
  padding: 0;
  margin: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  cursor: text;
  text-decoration: none;
}

.editor__host :deep(.wl-active .wl__bracket),
.editor__host :deep(.wl-active .wl--alias .wl__path) {
  display: inline;
  opacity: 0.5;
}

.editor__host :deep(.wl-active .wl--embed)::before {
  content: none;
}

.editor__host :deep(.vditor-counter) {
  color: var(--text-muted);
  background: transparent;
}

.editor__placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.editor__placeholder-inner {
  max-width: 470px;
  text-align: center;
}

.editor__placeholder-inner h2 {
  margin: 0 0 8px;
  font-size: 26px;
  letter-spacing: 0.5px;
}

.editor__placeholder-inner p {
  margin: 6px 0;
  color: var(--text-muted);
}

.editor__placeholder-inner code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

.editor__loading {
  position: absolute;
  inset: auto 0 0 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  background: var(--bg-elevated);
  border-top: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 13px;
}

.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.btn {
  margin-top: 14px;
  padding: 7px 16px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  transition: background 0.15s;
}

.btn:hover {
  background: var(--bg-hover);
}

.btn--primary {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.muted {
  font-size: 13px;
}
</style>
