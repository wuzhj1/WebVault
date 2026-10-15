/**
 * 左右栏宽度:桌面端可拖动调整,并记住上次的值。
 *
 * 存 localStorage 而不是 `.webvault/`(IndexedDB settings 表):宽度是**本机屏幕**的属性——
 * 34 寸上顺手的 420px 侧栏,到 13 寸笔记本上就是灾难,跟着仓库同步过去只会几台设备互相打架。
 * 被 Safari 的防跟踪策略清掉也无所谓:最坏情况是回到默认 300px,不涉及笔记数据。
 *
 * 硬约束:
 * 1. 只能跑在浏览器里(localStorage 在 Node 侧不存在),所以没有验证脚本直跑本文件。
 * 2. 落点是 `<html>` 上的 `--sidebar-w` / `--right-w` 两个变量(`styles/themes.css` 定义默认值)。
 *    **必须走变量而不是内联 width**:窄屏媒体查询要把两栏改成铺满 body 区的全屏覆盖层
 *    (`width: auto`),变量和它走的是同一条 cascade,媒体查询里的 auto 照样赢;
 *    内联样式则会盖过媒体查询,把窄屏布局压坏。
 */

/** 出厂宽度。两栏同宽不是巧合:左栏 = 44 活动栏 + 256 内容,右栏 300 也刚好放下属性条与反链行。 */
export const PANEL_DEFAULT_W = 300
/** 下限。左栏再窄,活动栏之外就只剩一百来像素,文件树缩进两层就折行。 */
export const PANEL_MIN_W = 220
/** 上限。再宽就该去改编辑区而不是拖栏了,而且宽栏在小屏上会把正文挤到没法读。 */
export const PANEL_MAX_W = 560

/** 一次布局调整后的两栏宽度。 */
export interface PanelWidths {
  side: number
  right: number
}

/** 与 `index.html` 无关:宽度不需要在首帧之前生效(vault.init() 完成前根本不渲染三栏)。 */
const KEY = 'webvault:panels'

/** 把值收进 [MIN,MAX] 并取整:拖动过程中的小数没有意义,存整数让快照稳定。 */
export function clampWidth(w: number): number {
  return Math.min(Math.max(Math.round(w), PANEL_MIN_W), PANEL_MAX_W)
}

/**
 * 读 localStorage 并逐栏校验;缺失、损坏、类型不对、越界一律回退默认,绝不抛错。
 * 每一档都独立回落——`{"side":400}` 这种只写了一半的快照,右栏照样能拿到默认值。
 */
export function readStoredWidths(): PanelWidths {
  const fallback: PanelWidths = { side: PANEL_DEFAULT_W, right: PANEL_DEFAULT_W }
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return fallback
  }
  if (raw === null) return fallback
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback
  const obj = parsed as Record<string, unknown>
  const pick = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? clampWidth(v) : PANEL_DEFAULT_W
  return { side: pick(obj.side), right: pick(obj.right) }
}

/** 整体快照写入;存储不可用(隐私模式、配额满)时静默放弃——宽度退回默认,不该打断拖动。 */
export function writeWidths(widths: PanelWidths): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(widths))
  } catch {
    /* 存储不可用:本次没有记住,下次还是默认值 */
  }
}
