<script setup lang="ts">
/**
 * 主编辑器:承载一个 Vditor 实例(IR / live-preview 模式),编辑 `vault.activePath` 指向的那篇笔记。
 *
 * props.startupDone 只在空态占位页上用;emits `open-link`(点到的 wikilink 解析成了某个路径,交给
 * App 去打开)与 `pick-link`(空态那个按钮要呼出链接选择器)。父组件通过 defineExpose 的两个方法
 * 反向操控本组件:`flushSave` 落盘、`insertLink` 从选择器插链。
 *
 * 读 vault(正文与 resolver)、appearance(明暗翻转)、sync(notify 与 schedulePush / fetchBody)。
 *
 * 编辑器之外本组件还管两件事:IR DOM 装饰(把 `[[双链]]` 包成可点的胶囊、标记光标所在的块)
 * 与斜杠命令 / `[[` 链接补全。装饰只用 span 包裹、不增删字符,否则 IR 模式回序列化 markdown 时会丢内容。
 *
 * 两条硬约束:
 * 1. frontmatter 从不进编辑器(`splitFrontmatter` 切掉,保存时原样拼回):本组件对它只读,
 *    没有任何改写入口(元数据条随卡片盒一并移除)。
 * 2. 任何要落盘的时机都必须 `await` `flushSave()` 并取消挂起的防抖 timer,否则迟到的自动保存会把
 *    刚写进文件的内容覆盖掉。另外换文/重渲染都不能弄丢光标位置,所以有 renderedBody 这层跳过。
 */
// vditor 连同它的样式表是编辑器专属的大块头:类型照旧从包里取(编译期擦除),
// 运行时改成组件挂载时动态引入,首屏要解析的 JS 少一大截。
import type Vditor from 'vditor'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  chipFromEvent,
  decorateWikilinks,
  markActiveBlock,
  type WikilinkLookup,
} from '@/core/editor/wikilink-dom.ts'
import { slashHint } from '@/core/editor/slash-commands.ts'
import { splitFrontmatter } from '@/core/parse/frontmatter.ts'
import { isAttachmentTarget, resolveTarget } from '@/core/index/resolve.ts'
import { codeThemeFor, type ThemeMode } from '@/core/theme/themes.ts'
import { useAppearanceStore } from '@/stores/appearance.ts'
import { useSyncStore } from '@/stores/sync.ts'
import { useVaultStore } from '@/stores/vault.ts'

const emit = defineEmits<{
  /** 点到 wikilink(或 Ctrl/⌘+点击裸文本链接),交出的都是已解析或刚创建的笔记路径。 */
  (e: 'open-link', path: string): void
  /** 空态页上的按钮,请求 App 呼出链接选择器。 */
  (e: 'pick-link'): void
}>()

const props = withDefaults(defineProps<{
  /** 启动流程是否走完;没走完时空态占位页不渲染,免得首帧闪一句"去左侧选一篇"。 */
  startupDone: boolean
}>(), {
  startupDone: false,
})

/** 停顿这么久才落盘:够写完一个词,又短到让 sync 推送赶得上。 */
const SAVE_DEBOUNCE_MS = 700

/** Vditor 自己懒加载的资源(图标、主题、hljs 样式表)都按 `cdn` 拼路径,所以它必须跟着构建 base 走。 */
const VDITOR_CDN = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/vditor`

/** Vditor 挂载点;`v-show` 而非 `v-if`,因为这块 DOM 一旦销毁就得整个重建实例。 */
const host = ref<HTMLElement | null>(null)
/** empty:没有选中文档;loading:本地没有正文,正在等 Gitee;ready:正常可编辑。 */
const state = ref<'empty' | 'loading' | 'ready'>('empty')

/** Vditor 实例;`after` 回调触发前为 null。 */
let editor: Vditor | null = null
/** after 回调之前 Vditor 的 API 一律不可用,所有操作都要等这个标志位。 */
let editorReady = false
/** 程序性 setValue 的护栏:IR 模式也会回调 input,不挡住就会把刚读进来的正文再"保存"一遍。 */
let suppressInput = false
/** 防抖计时器句柄;每次输入都重置它,任一时刻至多一个挂起。 */
let saveTimer: ReturnType<typeof setTimeout> | null = null
/** 防抖窗口内最后一次用户输入的正文;null 表示已经没有待落盘的东西了。 */
let pendingValue: string | null = null
/** 当前真正在编辑器里的那篇路径,和 vault.activePath 比较才能判断"是换文还是重载同一篇"。 */
let loadedPath: string | null = null
/** 编辑器永远看不见的 `---` 块,每次保存前原样拼回正文前面。 */
let loadedFm = ''
/** 此刻编辑器里的正文原文,重新加载时逐字比对,值没变就不必重排一次、丢一次光标。 */
let renderedBody: string | null = null

const vault = useVaultStore()
const sync = useSyncStore()
const appearance = useAppearanceStore()

/** Vditor 删除时把 `[[` 触发符一起吃掉,所以候选项的 value 必须自带方括号。 */
function hintLinks(query: string): { html: string; value: string }[] {
  return vault.suggestLinks(query).map((item) => ({
    html: item.html,
    value: `[[${item.value}]]`,
  }))
}

/**
 * 强制落盘:先撤掉挂起的防抖 timer,再把编辑器当前正文与 `loadedFm` 拼回完整文件内容写入 OPFS,
 * 最后排队一次同步推送。换文、组件卸载前都必须 `await` 它,
 * 否则迟到的自动保存会把刚写进去的内容盖回去。
 */
async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (pendingValue === null || !loadedPath) return
  // 先把 path/body 取成局部值再 await:期间可能已经换文,不能等回来后再读一次全局状态。
  const path = loadedPath
  const body = editor?.getValue() ?? pendingValue
  pendingValue = null
  const value = loadedFm + body
  // 自检:`loadedFm` 必须是拼好结果的严格前缀,否则说明这块前言已经和编辑器脱钩了,
  // 与其写坏文件不如回滚到上次渲染的正文并报警。
  if (loadedFm !== '' && !value.startsWith(loadedFm)) {
    sync.notify('warn', '元数据块偏移计算异常，已拒绝保存以防止正文损坏')
    setContent(renderedBody ?? '', true)
    return
  }
  await vault.saveBody(path, value)
  sync.schedulePush()
}

/** 编辑器每次内容变化的入口:记下最新正文并重置防抖 timer(滑动式,永远只留最后一次输入)。 */
function onInput(value: string): void {
  if (suppressInput || !loadedPath) return
  pendingValue = value
  // 每次输入都重置同一个 timer:滑动式防抖,而不是排一串落盘任务。
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushSave()
  }, SAVE_DEBOUNCE_MS)
}

/** 程序性写入正文:`suppressInput` 罩住 setValue 与 enable/disable 各自触发的 input 回调。 */
function setContent(body: string, enabled: boolean): void {
  suppressInput = true
  editor?.setValue(body, true)
  if (enabled) editor?.enable()
  else editor?.disabled()
  suppressInput = false
  renderedBody = body
}

/**
 * 把 `vault.activePath` 那篇笔记读进编辑器:换文、外部改正文(bodyRevision 变了)、sync 拉到远端正文
 * 都会走这里。开头先 flushSave,否则上一份未落盘的防抖内容会写进新激活的文件里。
 */
async function loadActive(): Promise<void> {
  if (!editorReady) return
  await flushSave()
  const prevPath = loadedPath

  const path = vault.activePath
  if (!path) {
    loadedPath = null
    loadedFm = ''
    state.value = 'empty'
    setContent('', false)
    return
  }

  loadedPath = path
  const raw = await vault.readBody(path)
  // null = 本机没有这篇的正文(只有云端 stub):禁用编辑防止凭空覆盖,顺手去 Gitee 拉一次。
  if (raw === null) {
    loadedFm = ''
    state.value = 'loading'
    setContent('', false)
    if (sync.available) void sync.fetchBody(path)
    return
  }

  const { fm: block, body } = splitFrontmatter(raw)
  loadedFm = block
  state.value = 'ready'
  // 同一篇且正文一字未改就别 setValue:重建 IR DOM 会把光标弹回开头。
  if (path === prevPath && body === renderedBody) return
  setContent(body, true)
}

/** wikilink 高亮要的判断:附件不解析、命中是 note、没命中是待建的 new。 */
function lookupLink(target: string): WikilinkLookup {
  if (isAttachmentTarget(target)) return { kind: 'asset', path: null }
  const path = resolveTarget(vault.resolver, target)
  return path === null ? { kind: 'new', path: null } : { kind: 'note', path }
}

/** IR 渲染根节点(`.vditor-reset`),胶囊装饰与当前块标记都在它底下做。 */
let irRoot: HTMLElement | null = null
/** 盯着 IR DOM 的增删改并排入装饰;观察范围含自己写出的节点,故每轮末尾要 takeRecords 清自触发。 */
let observer: MutationObserver | null = null
/** 合并标志:同一时刻只排一个微任务,连续输入不会逐字重排 DOM。 */
let decorateQueued = false
/** 当前带光标的块;它保持裸 markdown 可编辑,不参与胶囊装饰。 */
let activeBlock: HTMLElement | null = null

/** 把一轮装饰推迟到下一个微任务执行,期间的多次触发合并成一次。 */
function queueDecorate(): void {
  if (decorateQueued) return
  decorateQueued = true
  // 用 microtask 而不是 setTimeout:macrotask 可能排到一次绘制之后,块一折叠就会露出
  // 一帧未渲染的裸 markdown。
  queueMicrotask(() => {
    decorateQueued = false
    runDecorate()
  })
}

/** 真正跑一轮装饰:重算活动块,再按 lookupLink 的结果把所有非活动块的双链重绘成胶囊。 */
function runDecorate(): void {
  if (!irRoot) return
  activeBlock = markActiveBlock(irRoot)
  decorateWikilinks(irRoot, lookupLink)
  // 把自己刚改出来的记录丢掉,否则每一轮装饰都会把下一轮触发起来。
  observer?.takeRecords()
}

/**
 * 光标所在的块保持裸 markdown,所以只有移到*另一个*块才可能留下值得装饰的东西。
 * 同一个块内部的普通移动什么都不用做。
 */
function onSelectionChange(): void {
  if (!irRoot) return
  if (markActiveBlock(irRoot) === activeBlock) return
  queueDecorate()
}

/** 跟随链接:能解析就交出去,解析不出就直接建一篇再打开。 */
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

/** 用来区分任务复选框和其它 input(Vditor 的搜索框之类也是 input)。 */
function isTaskCheckbox(target: EventTarget | null): target is HTMLInputElement {
  return target instanceof HTMLInputElement && target.type === 'checkbox'
}

/**
 * 不做这件事的话,浏览器会把光标移进 chip,于是它在 click 之前就展开了。
 * 任务复选框同理:让它获得焦点,Chrome 的焦点环就会画在那个小方框上并把 `<input>` 选中,
 * 只要编辑器还持有焦点,看上去就是一层灰膜。取消默认行为后焦点和光标都留在文字里,
 * 而 click 依旧会正常切换勾选状态。
 */
function onEditorMouseDown(event: MouseEvent): void {
  if (chipFromEvent(event.target) || isTaskCheckbox(event.target)) event.preventDefault()
}

/** 点击分派:胶囊→跟链;任务复选框→把焦点与选区还给文字;Ctrl/⌘+点击正在编辑的裸链接→同样跟过去。 */
function onEditorClick(event: MouseEvent): void {
  const chip = chipFromEvent(event.target)
  if (chip) {
    event.preventDefault()
    event.stopPropagation()
    void followLink(chip.dataset.target ?? '')
    return
  }

  if (isTaskCheckbox(event.target)) {
    // detail > 0 说明是真用鼠标点的;Tab 键聚焦进来的复选框要保留它自己的焦点环。
    if (event.detail > 0) event.target.blur()
    releaseCheckboxSelection(event.target)
    return
  }

  // 正在编辑的那个块里链接是以裸文本显示的,这种情况靠 Ctrl/⌘+点击照样跟过去。
  if (!(event.ctrlKey || event.metaKey)) return
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return
  const node = selection.anchorNode
  if (!node || node.nodeType !== Node.TEXT_NODE) return

  // 从光标位置向两边找 `[[`…`]]`,再剥掉别名、锚块、标题部分。
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

/**
 * 在 contenteditable 里点复选框,Chrome 会把 `<input>` 本身选中,选区背景留在方框上像一层灰膜。
 * 把 range 折叠到它前一个偏移即可清掉高亮;落点选在复选框这个子节点上还能保住块的折叠状态,
 * 因为 `blockWithCaret` 会把这个偏移读成「光标不在本块内」。
 */
function releaseCheckboxSelection(box: HTMLInputElement): void {
  const selection = document.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
  const parent = box.parentNode
  if (!parent) return
  const caret = document.createRange()
  caret.setStart(parent, [...parent.childNodes].indexOf(box))
  selection.removeAllRanges()
  selection.addRange(caret)
}

/** 走 Vditor 自己的插入 API:IR 模式下安全,直接改 contenteditable 的 DOM 则不行。 */
function insertLink(target: string): void {
  editor?.insertValue(`[[${target}]]`, true)
  editor?.focus()
}

/** 挂上装饰管线:定位 IR 根、起 MutationObserver、监听 selectionchange,并先跑一轮兜底装饰。 */
function startDecorating(): void {
  irRoot = host.value?.querySelector<HTMLElement>('.vditor-ir .vditor-reset') ?? null
  if (!irRoot) return
  observer = new MutationObserver(() => queueDecorate())
  observer.observe(irRoot, { childList: true, characterData: true, subtree: true })
  document.addEventListener('selectionchange', onSelectionChange)
  queueDecorate()
}

/** 拆掉装饰管线(组件卸载前调用),同时清空块标记等引用,避免 observer 之后再触发。 */
function stopDecorating(): void {
  observer?.disconnect()
  observer = null
  document.removeEventListener('selectionchange', onSelectionChange)
  irRoot = null
  activeBlock = null
}

onMounted(async () => {
  if (!host.value) return
  await import('vditor/dist/index.css')
  const { default: VditorCtor } = await import('vditor')
  // 动态引入期间组件可能已被卸载(启动后立刻关标签的极端情况),挂载点没了就放弃建实例
  if (!host.value) return
  editor = new VditorCtor(host.value, {
    mode: 'ir',
    theme: appearance.mode === 'dark' ? 'dark' : 'classic',
    icon: 'ant',
    lang: 'zh_CN',
    cdn: VDITOR_CDN,
    height: '100%',
    minHeight: 240,
    cache: { enable: false },
    placeholder: '开始记录… 行首 / 呼出命令菜单,输入 [[ 链接其它笔记,Ctrl/⌘+K 打开链接选择器',
    undoDelay: 0,
    toolbar: [],
    counter: { enable: true, type: 'text' },
    hint: {
      delay: 100,
      parse: true,
      extend: [{ key: '[[', hint: hintLinks }, { key: '/', hint: slashHint }],
    },
    preview: {
      hljs: { style: codeThemeFor(appearance.mode), lineNumber: false },
      theme: { current: appearance.mode === 'dark' ? 'dark' : 'light' },
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

/** 换文或正文被外部改动(其它面板保存、sync 拉到远端)都汇到 loadActive;它开头先 flush 上一份防抖内容。 */
watch(
  () => [vault.activePath, vault.bodyRevision] as const,
  () => {
    void loadActive()
  },
)

/** 网络/凭据就绪后,把还停在 loading 的那篇正文补拉下来。 */
watch(
  () => sync.available,
  (ok) => {
    if (ok && state.value === 'loading' && loadedPath) void sync.fetchBody(loadedPath)
  },
)

/**
 * Vditor 自带 dark/classic 两套皮肤和独立的代码高亮样式表,只有明暗翻转需要通知它;
 * 同一种模式内换主题或换强调色,CSS 变量已经全部接管了。
 */
watch(
  () => appearance.mode,
  (mode: ThemeMode) => {
    const dark = mode === 'dark'
    editor?.setTheme(dark ? 'dark' : 'classic', dark ? 'dark' : 'light', codeThemeFor(mode))
  },
)

/** 暴露给父组件的两个反向操控入口:强制落盘、从选择器插链。 */
defineExpose({ flushSave, insertLink })
</script>

<template>
  <div class="editor">
    <!-- 空态引导页:启动流程走完但当前没有选中文档 -->
    <div v-if="state === 'empty' && startupDone" class="editor__placeholder">
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
    <!-- Vditor 挂载点用 v-show:DOM 一旦销毁就得整个重建编辑器实例 -->
    <div v-show="state !== 'empty'" ref="host" class="editor__host"></div>
    <!-- 云端正文未就绪时的下载提示,盖在编辑区底部而不是替换它 -->
    <div v-if="state === 'loading'" class="editor__loading">
      <span class="spinner"></span>
      正在从 Gitee 下载这篇笔记…
    </div>
  </div>
</template>

<style scoped>
/* —— 布局骨架:编辑区占满高度,内部滚动交给 Vditor —— */
.editor {
  position: relative;
  display: flex;
  flex-direction: column;
  /* .app__main 是 flex column;height:100% 会让编辑器按父高度算满、把父级撑破,
     所以改用 flex:1 + min-height:0 —— 只吃剩余空间 */
  flex: 1 1 auto;
  min-height: 0;
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
  display: none;
}

.editor__host :deep(.slash-hint__alias) {
  display: inline-block;
  min-width: 44px;
  margin-right: 8px;
  color: var(--text-muted);
  font-size: 11px;
  text-transform: uppercase;
}

.editor__host :deep(.vditor-content) {
  background: var(--bg);
}

/* Vditor 把编辑根节点画成灰色(--panel-background-color),:focus 时又换成更浅的灰
   (--textarea-background-color),于是焦点在正文与任务复选框之间挪动时整块背景会闪一下。
   两种状态都必须钉成应用底色。主题变量故意不动:--panel-background-color 还管着提示弹层的底色。 */
.editor__host :deep(.vditor-ir pre.vditor-reset),
.editor__host :deep(.vditor-ir pre.vditor-reset:focus) {
  background-color: var(--bg);
}

/* 原生复选框由 UA 上色:Chrome 按下时填近黑色、聚焦时描一圈,在本主题里看会闪。
   所有状态改为这里自绘。Vditor 自带的 margin/font-size/vertical-align 保持不动,免得列表布局位移。 */
.editor__host :deep(.vditor-task input[type='checkbox']) {
  appearance: none;
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--border);
  border-radius: 4px;
  background-color: var(--bg-elevated);
  cursor: pointer;
}

.editor__host :deep(.vditor-task input[type='checkbox']:hover),
.editor__host :deep(.vditor-task input[type='checkbox']:active) {
  border-color: var(--accent);
}

.editor__host :deep(.vditor-task input[type='checkbox']:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.editor__host :deep(.vditor-task input[type='checkbox']:checked) {
  border-color: var(--accent);
  background-color: var(--accent);
  background-image: var(--check-mark);
  background-repeat: no-repeat;
  background-position: center;
  background-size: 12px;
}

.editor__host :deep(.vditor-reset) {
  padding: 18px 26px 50vh;
  color: var(--text);
  font-size: 15px;
  line-height: 1.85;
  caret-color: var(--accent);
}

/* 方括号与别名路径只用 CSS 隐藏,绝不删除:IR 模式会把这块 DOM 序列化回 markdown,
   字符必须原地保留,笔记才能原样往返。 */
.editor__host :deep(.wl) {
  padding: 1px 4px;
  margin: 0 -2px;
  border-radius: 5px;
  background: var(--accent-soft);
  color: var(--accent-text);
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

/* 光标所在的块展示真实 markdown,链接在这一块里仍可直接编辑。 */
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

/* —— 空态占位页与云端下载提示条 —— */
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
  color: var(--accent-text);
}

.muted {
  font-size: 13px;
}
</style>
