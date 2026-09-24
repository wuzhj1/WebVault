/**
 * 未落盘编辑的 localStorage 兜底快照。
 *
 * 为什么需要它：OPFS 写入是异步的，而 `beforeunload` 不会等待任何 Promise —— 防抖窗口内
 * 直接关标签页会让最后一次输入凭空消失。因此 `flushSave` 在 `await saveBody` **之前**先同步
 * 把待写内容快照进 localStorage：写成功就清掉，写失败或页面被直接干掉则留着，下次启动回灌
 * （见 App.vue 的 `recoverPendingSave`）。
 *
 * 硬约束：只用相对导入、只碰 localStorage —— 回灌发生在 `vault.init()` 之后、启动定位之前，
 * 那一刻 IndexedDB/OPFS 虽已就绪，但快照本身绝不能再依赖它们，否则兜底会和被兜底的东西
 * 一起丢。存储不可用（隐私模式、超额）时一律静默降级为「没有兜底」，不抛错打断落盘。
 */

/** 存储键；改名只会让上一次未落盘的内容变成没人读的孤儿。 */
const KEY = 'webvault:pending-save'

/** 一条快照：目标路径 + 完整文件内容（已含 frontmatter）+ 快照时刻。 */
export interface PendingSave {
  path: string
  value: string
  at: number
}

/** 同步写快照；必须在任何 `await` 之前调用，否则 `beforeunload` 可能来不及。 */
export function snapshotPendingSave(path: string, value: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ path, value, at: Date.now() } satisfies PendingSave))
  } catch {
    /* 存储不可用：退回到没有兜底的旧行为 */
  }
}

/** 读快照；缺字段、类型不符或坏 JSON 一律当没有，绝不把坏数据喂给 saveBody。 */
export function readPendingSave(): PendingSave | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<PendingSave>
    if (typeof parsed.path === 'string' && typeof parsed.value === 'string') {
      return {
        path: parsed.path,
        value: parsed.value,
        at: typeof parsed.at === 'number' ? parsed.at : 0,
      }
    }
  } catch {
    /* 坏 JSON：丢弃 */
  }
  return null
}

/**
 * 只有现存快照确实是 `path`+`value` 这一份时才清掉。
 * 两次 flushSave 可能并发（上一轮还没 await 完、下一轮定时器又到了），后写入的快照更晚、
 * 更新，不能被先完成的那一轮顺手清掉。
 */
export function clearPendingSave(path: string, value: string): void {
  const current = readPendingSave()
  if (!current || current.path !== path || current.value !== value) return
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 存储不可用：留着也无妨 */
  }
}

/** 无条件丢弃快照：启动回灌前、以及目标笔记已不存在时使用，避免每轮启动重复尝试同一条。 */
export function dropPendingSave(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 存储不可用：留着也无妨 */
  }
}
