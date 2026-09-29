/**
 * 浮层焦点陷阱：Tab / Shift+Tab 在给定容器内循环，关闭时把焦点还给打开前的元素。
 *
 * 为什么单独抽出来：`Modal.vue` 早就实现了这套逻辑，而搜索 / 链接选择器 / 关系图谱三个
 * 浮层没有 —— 它们打开时抢焦点、Tab 却能走到遮罩背后的主界面，关闭后焦点掉回 body
 * （键盘用户得从头再 Tab 一遍）。四处各写一遍必然漂移，所以收敛到这里。
 *
 * 使用方式（组件内）：
 * ```ts
 * const box = ref<HTMLElement | null>(null)
 * useFocusTrap(box, { onEscape: () => emit('close'), initialFocus: input })
 * ```
 * - `initialFocus` 缺省时把焦点给容器本身（容器需要 `tabindex="-1"` 才吃得下 focus）。
 * - `onEscape` 收到原始事件：要不要 `stopPropagation` 由调用方定（Modal / GraphView 会挡
 *   全局快捷键，SearchPanel / LinkPicker 不挡）。多个浮层同时挂 document 监听时两边都会收到，
 *   真正的互斥要靠调用方只挂一个 overlay —— 这里拦截不了更晚注册的同层监听（Modal 的历史约束）。
 * - 同时开着两层时 Tab 不会打架：外层先把焦点搬回自己首项，内层的处理排在后面，
 *   又把它搬回内层首项，最终落点始终是最上面那一层。
 *
 * 硬约束：只用相对导入；不碰 db.ts。
 */
import { nextTick, onBeforeUnmount, onMounted, type Ref } from 'vue'

/** 容器内可被 Tab 到的元素；`getClientRects` 过滤掉隐藏项（display:none 的输入框）。 */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

export interface FocusTrapOptions {
  /** Esc 按下时调用（带原始事件，需要挡同层监听的调用方可自行 stopPropagation）；不传则 Esc 不做任何事。 */
  onEscape?: (event: KeyboardEvent) => void
  /** 初始焦点目标；缺省给容器本身。延迟挂载的输入框可传 ref，mount 后会自行聚焦。 */
  initialFocus?: Ref<HTMLElement | null>
}

/**
 * 在 `onMounted` 挂上 document 级 keydown、`onBeforeUnmount` 摘掉并还原焦点。
 *
 * document 级而不是 `@keydown.self`：焦点通常在输入框里，事件根本不会落在容器元素上。
 * body 滚动锁**不在**这里管 —— 那是 Modal 独有的需求（普通浮层底下还想露出一点内容）。
 */
export function useFocusTrap(box: Ref<HTMLElement | null>, opts: FocusTrapOptions = {}): void {
  /** 打开前持有焦点的元素，关闭时还原——否则键盘用户的焦点会掉回 body。 */
  let restoreFocus: HTMLElement | null = null

  function focusables(): HTMLElement[] {
    if (!box.value) return []
    return [...box.value.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.getClientRects().length > 0,
    )
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      opts.onEscape?.(event)
      return
    }
    if (event.key !== 'Tab') return
    const items = focusables()
    if (items.length === 0) return
    const active = document.activeElement
    const inside = active instanceof HTMLElement && box.value !== null && box.value.contains(active)
    const first = items[0]!
    const last = items[items.length - 1]!
    // 焦点在容器内且没贴边时交给浏览器按 DOM 顺序走；贴边（或跑到外面）才由这里接管。
    if (event.shiftKey) {
      if (!inside || active === box.value || active === first) {
        event.preventDefault()
        last.focus()
      }
    } else if (!inside || active === box.value || active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  onMounted(() => {
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.addEventListener('keydown', onKeydown)
    // 等一拍再聚焦：浮层的输入框往往是同一批次才渲染出来的，mount 那一刻它还是 null。
    void nextTick(() => {
      const target = opts.initialFocus?.value ?? box.value
      target?.focus()
    })
  })

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onKeydown)
    // 先还原焦点再拆 DOM：顺序反了，焦点会先被浏览器打回 body，还原就失去了落点。
    if (restoreFocus !== null && restoreFocus.isConnected) restoreFocus.focus()
    restoreFocus = null
  })
}
