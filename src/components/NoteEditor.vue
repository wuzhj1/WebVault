<script setup lang="ts">
/**
 * 主编辑器:承载一个 Vditor 实例(IR / live-preview 模式),编辑 `vault.activePath` 指向的那篇笔记。
 *
 * props.startupDone 只在空态占位页上用;emits `open-link`(点到的 wikilink 解析成了某个路径,交给
 * App 去打开)、`pick-link`(空态那个按钮要呼出链接选择器)与 `open-ai-settings`(选区 AI 浮层的
 * 「去设置」)。父组件通过 defineExpose 的三个方法反向操控本组件:`flushSave` 落盘、
 * `insertLink` 从选择器插链、`insertMarkdown` 插入带标记的 AI 内容(选区浮层与侧栏 AI 面板共用)。
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
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  chipFromEvent,
  decorateWikilinks,
  markActiveBlock,
  type WikilinkLookup,
} from '@/core/editor/wikilink-dom.ts'
import AiSelection from './AiSelection.vue'
import { slashHint } from '@/core/editor/slash-commands.ts'
import { clearPendingSave, snapshotPendingSave } from '@/core/editor/pending-save.ts'
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
  /** 选区浮层里的「去设置」:本组件碰不到 overlay,交 App 打开设置的 AI 页。 */
  (e: 'open-ai-settings'): void
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
/**
 * `[[` 补全层的候选项:把目标包成 `[[目标]]` 交回 Vditor。
 *
 * `query` 是 Vditor `getKey` 从「光标前最后一个 `[[` 之后」原样切下来的片段，它**不判断这处链接有没有闭合**:
 * 光标只要落在一个已经写完的 `[[双链]]` 上或它后面，片段里就带着 `]]`（连同用户随后敲的任何字）。
 * 而 `Hint.fillEmoji` 会从 `[[` 一路替换到光标，值里再包一层方括号就等于把已有的 `]]` 又写了一遍
 * —— 实测 `x [[abc]]zw` 按一次回车会变成 `x [[abc]]zw]]`。
 *
 * 片段里出现 `]` 就说明这处链接已经写完：wikilink 的目标不允许含 `]`（见 `core/parse/links.ts`
 * 的 `[[([^[\]]+)]]`），所以那半截不可能是目标名的一部分。此时交空列表，`genHTML` 会据此收起弹层，
 * 回车于是走正常换行；补全只在链接尚未闭合时才出手，也就不会再往闭合好的链接上重复补 `]]`。
 */
function hintLinks(query: string): { html: string; value: string }[] {
  if (query.includes(']')) return []
  return vault.suggestLinks(query).map((item) => ({
    html: item.html,
    value: `[[${item.value}]]`,
  }))
}

/**
 * 强制落盘:先撤掉挂起的防抖 timer,再把编辑器当前正文与 `loadedFm` 拼回完整文件内容写入 OPFS,
 * 最后排队一次同步推送。换文、组件卸载前都必须 `await` 它,
 * 否则迟到的自动保存会把刚写进去的内容盖回去。
 * 两条自保:写 OPFS 之前先同步落一份 localStorage 快照(`beforeunload` 不等 Promise);
 * 写失败时把正文放回 pendingValue 留待下次重试 —— 两条都为了一件事:不丢用户最后的输入。
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
  const value = loadedFm + body
  // 自检:`loadedFm` 必须是拼好结果的严格前缀,否则说明这块前言已经和编辑器脱钩了,
  // 与其写坏文件不如回滚到上次渲染的正文并报警(这次待写内容随 pendingValue 一起丢弃)。
  if (loadedFm !== '' && !value.startsWith(loadedFm)) {
    pendingValue = null
    vault.saveState = 'idle'
    sync.notify('warn', '元数据块偏移计算异常，已拒绝保存以防止正文损坏')
    setContent(renderedBody ?? '', true)
    return
  }
  pendingValue = null
  // 快照必须写在 await 之前:beforeunload 不等任何 Promise,这是唯一能留住这次编辑的时机。
  // 写成功后由 clearPendingSave 按内容比对清掉(见 core/editor/pending-save.ts)。
  snapshotPendingSave(path, value)
  vault.saveState = 'saving'
  try {
    await vault.saveBody(path, value)
  } catch (err) {
    // 落盘失败:把正文放回 pendingValue,下一次输入/换文/页面隐藏都会重试;
    // 快照也留着,即便这一轮再没机会重试,下次启动仍能回灌。
    pendingValue = body
    vault.saveState = 'error'
    sync.notify('error', `保存失败: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  vault.saveState = 'saved'
  vault.savedAt = Date.now()
  clearPendingSave(path, value)
  sync.schedulePush()
}

/** 编辑器每次内容变化的入口:记下最新正文并重置防抖 timer(滑动式,永远只留最后一次输入)。 */
function onInput(value: string): void {
  if (suppressInput || !loadedPath) return
  pendingValue = value
  // 防抖窗口内这一格是用户唯一能感知"还没存"的地方;已在 saving/error 中时不动,
  // 免得刚失败就被一次新的输入抹成"改了"。
  if (vault.saveState !== 'saving' && vault.saveState !== 'error') vault.saveState = 'dirty'
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
 * 把锁态落到 Vditor 上(只翻 contenteditable,不动正文):锁与解锁都由它收口,
 * 换文、正文外部改写则走 `setContent` 一并带上当前锁态。
 * 空态/加载态没有可编辑的东西,交给随后的 `loadActive` 补一次即可。
 */
function applyEditable(): void {
  if (!editorReady || state.value !== 'ready') return
  suppressInput = true
  if (vault.editable) editor?.enable()
  else editor?.disabled()
  suppressInput = false
}

/**
 * 把 `vault.activePath` 那篇笔记读进编辑器:换文、外部改正文(bodyRevision 变了)、sync 拉到远端正文
 * 都会走这里。开头先 flushSave,否则上一份未落盘的防抖内容会写进新激活的文件里。
 */
async function loadActive(): Promise<void> {
  if (!editorReady) return
  await flushSave()
  const prevPath = loadedPath
  // flushSave 落完就没有任何待写内容了；若它因为 pendingValue 为空而直接返回
  // （例如外部替我们保存过），状态还停在 dirty，这里统一收口。
  // 换文时还多一件事：上一篇的「已保存 14:03」不能挂到这一篇头上 —— 它描述的是另一篇。
  if (pendingValue === null && (vault.saveState === 'dirty' || vault.saveState === 'saving')) {
    vault.saveState = 'idle'
  }

  const path = vault.activePath
  if (!path) {
    loadedPath = null
    loadedFm = ''
    state.value = 'empty'
    setContent('', false)
    vault.saveState = 'idle'
    return
  }
  if (path !== prevPath && vault.saveState === 'saved') vault.saveState = 'idle'

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
  // 但正文没变不等于锁态没变(比如 loading 期间用户点了解锁),这里补一次落锁。
  if (path === prevPath && body === renderedBody) {
    applyEditable()
    return
  }
  setContent(body, vault.editable)
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
/**
 * 本轮攒下的装饰种子:observer 记下的新增/改写节点 + 上一轮的活动块。
 * 空集意味着「这轮没有值得装饰的地方」(比如只删不增的重渲染),不等于全量。
 */
let seedNodes = new Set<Node>()
/** 置真时下一轮退回全量扫(挂管后的首轮兜底)。 */
let fullSweep = false
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

/**
 * 真正跑一轮装饰:重算活动块,再只对**种子**跑 lookupLink 与胶囊重绘。
 * 上一轮的活动块每次都入种:它在光标下待过、一直是裸 markdown,离开光标才轮到它被装饰。
 */
function runDecorate(): void {
  if (!irRoot) return
  const prevActive = activeBlock
  activeBlock = markActiveBlock(irRoot)
  if (prevActive) seedNodes.add(prevActive)
  const seeds = fullSweep ? undefined : seedNodes
  fullSweep = false
  seedNodes = new Set()
  decorateWikilinks(irRoot, lookupLink, seeds)
  // 把自己刚改出来的记录丢掉,否则每一轮装饰都会把下一轮触发起来。
  observer?.takeRecords()
}

/**
 * 光标所在的块保持裸 markdown,所以只有移到*另一个*块才可能留下值得装饰的东西。
 * 同一个块内部的普通移动什么都不用做。
 *
 * 顺带记下编辑器内的最后一次选区(`lastRange`):点 AI 面板按钮后浏览器会把选区挪出编辑器,
 * `insertMarkdown` 全靠这份副本把插入点还原到「用户刚才选/点的地方」。
 * 只在选区仍落在 irRoot 内时覆盖——选区移到按钮上之类的外部变动必须放过,否则副本会被洗掉。
 */
let lastRange: Range | null = null

/**
 * 选区 AI 浮层的锚点:选区矩形(左、底)+ 选中原文;null = 不显示 🤖 按钮。
 * `aiRange` 是打开浮层那一刻**钉住**的选区副本——`lastRange` 会随后续编辑漂移,
 * 而「替换」必须精确删掉用户当初选中的那段,两者职责不同、不能合并。
 */
const aiAnchor = ref<{ x: number; y: number; text: string } | null>(null)
let aiRange: Range | null = null

/** 换笔记即收浮层并作废旧选区:浮层跟的是「这篇里这段文字」,跨笔记毫无意义。 */
watch(
  () => vault.activePath,
  () => {
    aiAnchor.value = null
    aiRange = null
  },
)

function onSelectionChange(): void {
  if (!irRoot) return
  const selection = window.getSelection()
  if (selection && selection.rangeCount > 0) {
    const current = selection.getRangeAt(0)
    if (irRoot.contains(current.commonAncestorContainer)) lastRange = current.cloneRange()
  }
  if (markActiveBlock(irRoot) === activeBlock) return
  queueDecorate()
}

/**
 * 跟随链接:能解析就交出去,解析不出就直接建一篇再打开。
 * 新建可能失败(路径不合法、目录被外部改名),失败必须报出来 —— 调用方是
 * `void followLink(...)`,不 catch 就只剩一条 unhandled rejection,界面毫无反应。
 */
async function followLink(raw: string): Promise<void> {
  const target = raw.trim()
  if (target === '' || isAttachmentTarget(target)) return
  const resolved = resolveTarget(vault.resolver, target)
  if (resolved !== null) {
    emit('open-link', resolved)
    return
  }
  try {
    emit('open-link', await vault.createFromLink(target))
  } catch (err) {
    sync.notify('error', `无法创建「${target}」: ${err instanceof Error ? err.message : String(err)}`)
  }
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
  // 在编辑器里重新落鼠标 = 选区要变了,旧浮层(连同它钉住的 aiRange)立刻作废;
  // 浮层本体 Teleport 在 body 上,点它不会走到这里,关不掉自己。
  aiAnchor.value = null
  aiRange = null
}

/**
 * 选区完成(mouseup 是拖选的天然收尾时机)后浮出 🤖 按钮。三条门槛:
 * - 只读/空态不弹(只读下插入会替用户解锁,那是「按钮点下去才解锁」,不是选中就弹);
 * - 选区必须落在 IR 根内且不折叠,单字符以内的选区不值得占屏——AI 处理它没有意义;
 * - 位置取 `getBoundingClientRect`,fixed 定位直接用视口坐标,不用换算父系。
 * 键盘完成的选区(shift+方向键)不经过 mouseup,因此不弹入口——这是已知取舍,
 * 键盘用户走侧栏 AI 面板那条路(浮层只是鼠标流的快捷入口)。
 */
function onEditorMouseUp(): void {
  if (state.value !== 'ready' || !irRoot || !editorReady) return
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  if (!irRoot.contains(range.commonAncestorContainer)) return
  const text = selection.toString()
  if (text.trim().length < 2) return
  const rect = range.getBoundingClientRect()
  aiRange = range.cloneRange()
  aiAnchor.value = { x: rect.left, y: rect.bottom, text }
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
    // 只读下不许勾选:勾一下就是一次正文改动,会绕过顶栏的锁直接进防抖落盘。
    if (!vault.editable) {
      event.preventDefault()
      return
    }
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

/** 一次待处理的斜杠命令回车:回车前光标所在块的下标、它的原文、以及整篇当时的块数。 */
let slashFill: { index: number; text: string; count: number } | null = null

/**
 * 提示层当前展示的是 `/` 命令菜单。`[[` 链接与 `:` 表情两条提示的 HTML 里都没有 `.slash-hint__alias`,
 * 拿它当判据就不会把链接补全的回车也当成斜杠命令处理。
 */
function slashMenuOpen(): boolean {
  const hint = document.querySelector<HTMLElement>('.vditor-hint')
  return !!hint && hint.style.display === 'block' && !!hint.querySelector('.slash-hint__alias')
}

/** 光标所在块在 IR 根下的下标;光标不在编辑器里时返回 -1。 */
function caretBlockIndex(): number {
  if (!irRoot) return -1
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return -1
  const node = selection.getRangeAt(0).startContainer
  let block: Element | null = node instanceof Element ? node : node.parentElement
  while (block && block.parentElement !== irRoot) block = block.parentElement
  if (!block) return -1
  return Array.from(irRoot.children).indexOf(block)
}

/** 回车落进 `/` 提示层时记下现场,排一个微任务在校正——它排在整轮事件派发之后,届时块已经插完。 */
function onEditorKeydownCapture(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.isComposing) return
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
  if (!irRoot || !irRoot.contains(event.target as Node)) return
  if (!slashMenuOpen()) return
  const index = caretBlockIndex()
  if (index < 0) return
  slashFill = {
    index,
    text: irRoot.children[index].textContent ?? '',
    count: irRoot.children.length,
  }
  queueMicrotask(applySlashCaret)
}

/**
 * 把光标放到 `node` 内容的首/末,并一路深入到最后一个可写字节点:
 * 元素级落点(`<ul>` 的子节点下标之类)会被浏览器重新解释,只有落到文本节点上才是确定的。
 */
function setRangeAt(node: Node, atStart: boolean): void {
  let target: Node = node
  for (;;) {
    const next = atStart ? target.firstChild : target.lastChild
    if (!next) break
    target = next
  }
  const range = document.createRange()
  if (target.nodeType === Node.TEXT_NODE) {
    range.setStart(target, atStart ? 0 : (target.nodeValue?.length ?? 0))
  } else {
    range.selectNodeContents(target)
  }
  range.collapse(atStart)
  const selection = window.getSelection()
  if (!selection) return
  selection.removeAllRanges()
  selection.addRange(range)
}

/** 表格/分割线块内没有可续写的落点:块后复用一段,没有就新起一段,光标放到它的开头。 */
function setCaretAfterBlock(block: HTMLElement): void {
  let tail = block.nextElementSibling as HTMLElement | null
  if (!tail || tail.tagName !== 'P') {
    tail = document.createElement('p')
    tail.setAttribute('data-block', '0')
    block.after(tail)
  }
  setRangeAt(tail, true)
}

/**
 * 斜杠命令回车后的光标接管:按块类型把光标摆到确定位置,并回收被删空的 `/xxx` 原段落。
 *
 * Vditor 的 `Hint.fillEmoji` 先把 `/xxx` 从原段落里删掉,再让 `insertHTML` 走「块内容插到当前块之后」
 * 的分支(`util/selection.ts`),最后靠塞在插入内容末尾的 `<wbr>` 把光标找回来。这条路径有三个毛病:
 * 1. `<table>`/`<hr>` 这类不能有子节点的元素会把那个 `<wbr>` 丢给解析器,`setRangeByWbr` 找不到就回落到
 *    旧位置 —— 光标停在新块**前面**的空段落里,接着打字写到块上方去了;
 * 2. 标题/列表/引用拿到的是元素级光标(比如 `<ul>` 的子节点下标),语义含糊,第一次输入要靠浏览器自己归位;
 * 3. `/xxx` 被删空的原段落不会被回收,新块上面永远顶着一个空行。
 *
 * 所以能续写的块 → 块内最后一个可写字节点的末尾;表格/分割线这类块内没有落点的 → 块后新起一段;
 * 代码块不动(Vditor 已经把光标放进代码体了)。原段落删空了就一并回收 —— 有文字(如 `前文 /xx`)则原样留着。
 *
 * 硬约束:只增删块位置与光标,绝不改写任何原文字符。
 */
function applySlashCaret(): void {
  const pending = slashFill
  slashFill = null
  if (!pending || !irRoot) return
  const source = irRoot.children[pending.index] as HTMLElement | undefined
  //回车没被提示层吃掉(正常换行)时原段落一个字没动;块数对不上说明结构不是「插了一个块」。
  //两种情况都交给 Vditor 自己,宁可不动也不要把光标摆错地方。
  if (!source || irRoot.children.length !== pending.count + 1) return
  if (source.textContent === pending.text) return
  const block = source.nextElementSibling as HTMLElement | null
  if (!block || !irRoot.contains(block)) return

  const type = block.dataset.type
  if (type === 'code-block') {
    // 代码块:Vditor 已经把光标放进代码体了,这里不碰。
  } else if (block.tagName === 'TABLE' || block.tagName === 'HR' || type === 'yaml-front-matter') {
    setCaretAfterBlock(block)
  } else {
    setRangeAt(block, false)
  }

  if (source.textContent?.trim() === '') source.remove()
  queueDecorate()
}

/** 走 Vditor 自己的插入 API:IR 模式下安全,直接改 contenteditable 的 DOM 则不行。 */
function insertLink(target: string): void {
  // 从选择器插入是条明确的编辑指令,只读时替用户解锁(顶栏徽标同步翻成「编辑中」),
  // 否则链接会被 contenteditable 悄悄挡掉、界面上看不出任何反应。
  if (!vault.editable) vault.editable = true
  editor?.insertValue(`[[${target}]]`, true)
  editor?.focus()
}

/**
 * 按 IR 语义插入一段 markdown(AI 面板的「插入到笔记」、选区浮层的插入等外部来源)。
 *
 * 与 insertLink 的三点差别,都是被 Vditor 的 `insertMD`/`insertHTML` 实现逼出来的:
 * - 用 `insertMD` 而非 `insertValue`:前者经 Lute 把 markdown 转成 IR DOM 再插,
 *   引用块这类**块级**结构才能正确落位;`insertValue` 收的是 HTML 字面量,会把 `>` 当正文。
 * - 插入点必须先收敛:`insertHTML` 见到非空选区会先 `execCommand('delete')` 再插——
 *   这个行为 mode 两种取值各用一半:
 *   - `after`(默认):收敛到「编辑器内最后一次光标的末尾」(选区内 → 坍缩到选区尾,
 *     选区已丢 → 回放 lastRange),选区为空故原文分毫不动,块级内容落在光标所在块**之后**;
 *   - `replace`:回放浮层打开时钉住的 aiRange(**不**坍缩),让 delete 先吃掉选中原文,
 *     带标记的 AI 块随后落位——「替换会删原文」正是靠这个显式按钮才被允许;
 *     钉住的选区已失效(正文被改、重排)则退化为 `after`,宁可多留原文也不误删。
 *   选区丢了又没有可回放的副本时兜底到末块之后,好过 insertHTML 自己兜底的文档开头。
 * - 收敛后选区落在哪个块,`insertHTML` 就把块级内容插到那个块的**之后** ——
 *   这正是「插入到下方」的落点:引用块永远排在原段落下侧,不并行、不覆盖。
 */
function insertMarkdown(md: string, mode: 'after' | 'replace' = 'after'): void {
  if (!vault.editable) vault.editable = true
  const selection = window.getSelection()
  if (selection && irRoot) {
    const usable = (r: Range | null): r is Range =>
      !!r && irRoot!.contains(r.commonAncestorContainer)
    if (mode === 'replace') {
      // 焦点先还给编辑器(execCommand 需要),回放选区必须是最后一步才不被 focus 挪走。
      editor?.focus()
      if (usable(aiRange)) {
        selection.removeAllRanges()
        selection.addRange(aiRange.cloneRange())
      } else if (
        usable(lastRange) &&
        selection.rangeCount > 0 &&
        selection.getRangeAt(0).toString() !== ''
      ) {
        // 钉住的选区没了,但当前恰好真有一个非空选区(用户重新选了一段):就替换它。
        selection.removeAllRanges()
        selection.addRange(lastRange.cloneRange())
      } else {
        // 两头都没有可用选区:退化为插入,宁可多留原文也不误删。
        insertMarkdown(md, 'after')
        return
      }
    } else {
      const inside =
        selection.rangeCount > 0 &&
        irRoot.contains(selection.getRangeAt(0).commonAncestorContainer)
      if (inside && selection.rangeCount > 0 && !selection.isCollapsed) {
        const collapse = selection.getRangeAt(0).cloneRange()
        collapse.collapse(false)
        selection.removeAllRanges()
        selection.addRange(collapse)
      } else if (!inside) {
        if (lastRange && irRoot.contains(lastRange.commonAncestorContainer)) {
          const restore = lastRange.cloneRange()
          restore.collapse(false)
          selection.removeAllRanges()
          selection.addRange(restore)
        } else {
          // 一个光标都没留过(刚打开就点插入):放到末块之后,好过 insertHTML 兜底的文档开头。
          setRangeAt(irRoot, false)
        }
      }
    }
  }
  editor?.insertMD(md)
  editor?.focus()
}

/** 只读提示条的解锁入口;与顶栏那把锁写的是同一个 vault.editable。 */
function unlock(): void {
  vault.editable = true
  // 提示条随 editable 翻真而卸载,焦点会掉回 body —— 键盘用户点完就没处可打了,
  // 还得重新 Tab 一遍才能找回编辑区。等渲染落定接管到编辑器:上面那个 editable 的
  // watcher 走的是 pre 刷新,此刻早已 applyEditable 把 contenteditable 打开了。
  void nextTick(() => editor?.focus())
}

/** 挂上装饰管线:定位 IR 根、起 MutationObserver、监听 selectionchange,并先跑一轮兜底装饰。 */
function startDecorating(): void {
  irRoot = host.value?.querySelector<HTMLElement>('.vditor-ir .vditor-reset') ?? null
  if (!irRoot) return
  observer = new MutationObserver((records) => {
    // 只有「新增的子树」和「被改写的文本」需要重新看;被删掉的自己不需要装饰。
    for (const record of records) {
      if (record.type === 'characterData') seedNodes.add(record.target)
      else for (const node of record.addedNodes) seedNodes.add(node)
    }
    queueDecorate()
  })
  observer.observe(irRoot, { childList: true, characterData: true, subtree: true })
  document.addEventListener('selectionchange', onSelectionChange)
  // 挂管后的首轮兜底:此前发生过的变动不在 observer 记录里,先全量走一遍。
  fullSweep = true
  queueDecorate()
}

/** 拆掉装饰管线(组件卸载前调用),同时清空块标记等引用,避免 observer 之后再触发。 */
function stopDecorating(): void {
  observer?.disconnect()
  observer = null
  document.removeEventListener('selectionchange', onSelectionChange)
  irRoot = null
  activeBlock = null
  seedNodes = new Set()
  fullSweep = false
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
      host.value?.addEventListener('mouseup', onEditorMouseUp, true)
      host.value?.addEventListener('click', onEditorClick, true)
      host.value?.addEventListener('keydown', onEditorKeydownCapture, true)
      startDecorating()
      void loadActive()
    },
    input: onInput,
  })
})

onBeforeUnmount(async () => {
  stopDecorating()
  slashFill = null
  aiAnchor.value = null
  aiRange = null
  host.value?.removeEventListener('mousedown', onEditorMouseDown, true)
  host.value?.removeEventListener('mouseup', onEditorMouseUp, true)
  host.value?.removeEventListener('click', onEditorClick, true)
  host.value?.removeEventListener('keydown', onEditorKeydownCapture, true)
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

/** 顶栏锁/解锁:只翻 contenteditable,不重排正文,否则每次解锁都把光标弹回开头。 */
watch(
  () => vault.editable,
  () => {
    applyEditable()
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

/** 暴露给父组件的三个反向操控入口:强制落盘、从选择器插链、插入成块 markdown(AI)。 */
defineExpose({ flushSave, insertLink, insertMarkdown })
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
    <!-- 选区 AI 浮层:Teleport 到 body,fixed 跟着选区矩形;插入走 insertMarkdown,打开设置上抛 App -->
    <AiSelection
      v-if="aiAnchor"
      :anchor="aiAnchor"
      @close="aiAnchor = null"
      @insert="(payload) => insertMarkdown(payload.markdown, payload.mode)"
      @open-settings="emit('open-ai-settings')"
    />
    <!-- 云端正文未就绪时的下载提示,盖在编辑区底部而不是替换它 -->
    <div v-if="state === 'loading'" class="editor__loading">
      <span class="spinner"></span>
      正在从 Gitee 下载这篇笔记…
    </div>
    <!-- 只读提示:正文打不进去时唯一能解释「为什么没反应」的地方,顺手当解锁入口 -->
    <button
      v-if="state === 'ready' && !vault.editable"
      class="editor__lockhint"
      type="button"
      title="本篇处于只读,点击解锁后可编辑"
      @click="unlock"
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <rect x="3.5" y="7" width="9" height="6.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path
          d="M5.7 7V5.1a2.3 2.3 0 014.6 0"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
      只读 · 点击解锁编辑
    </button>
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

/* Vditor 给 contenteditable=false 的正文画 opacity:.3 + not-allowed —— 它只把这当成
   「表单控件被禁用」。但本库默认只读是**产品常态**而不是故障态:整篇正文掉到 30% 不透明,
   底色再准也像凭空蒙了层灰膜,字重与抗锯齿一起糊掉,根本读不下去。
   「当前不可编辑」由顶栏那把锁和右下角提示条表达,正文本身必须和可编辑时完全一致。
   选择器带上 [contenteditable] 是为了和 Vditor 那条规则一一对应 —— 本条 (0,5,1) 稳赢它的
   (0,3,1),不带也能赢,带上则一眼看出是冲着谁来的。 */
.editor__host :deep(.vditor-ir pre.vditor-reset[contenteditable='false']) {
  opacity: 1;
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

/* 只读提示条:浮在正文右下角、不随内容滚动。正文打不进去时它是唯一的解释,
   顺手兼任解锁入口 —— 与顶栏那把锁改的是同一个 vault.editable。 */
.editor__lockhint {
  position: absolute;
  right: 16px;
  bottom: 14px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-elevated);
  box-shadow: 0 2px 10px var(--shadow-color);
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s;
}

.editor__lockhint:hover {
  border-color: var(--accent);
  color: var(--text);
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
