<script setup lang="ts">
/**
 * 链接选择器：编辑器里输入 `[[` 唤起的浮层，在「打开已有 / 就地新建 / 只插入链接」三条路之间做选择。
 *
 * 交互契约：
 * - ↑/↓ 在候选间循环移动，Enter 打开当前候选（解析不到就新建一篇），Ctrl/⌘ + Enter 只把
 *   `[[目标]]` 文本交给编辑器 —— 两者的区别是动不动文件。
 * - Esc 或点遮罩关闭；键盘监听挂在 document 上，因为焦点常在输入框里，@keydown.self 收不到。
 * - 鼠标 hover 与键盘共用同一个 cursor，两者始终指向同一条高亮行。
 * emits：`open(path)` 打开（可能刚新建的）笔记；`insert(target)` 请求编辑器写入链接文本；`close()` 关闭。
 * 挂卸方式：App.vue 用 v-if 控制 overlay，组件自身不持久化任何状态。
 * 依赖：vault.suggestLinks（打分候选，空查询返回全部笔记）与 resolveTarget（判定「新建」徽标）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { resolveTarget } from '@/core/index/resolve.ts'
import { useFocusTrap } from '@/core/ui/focus-trap.ts'
import { useSyncStore } from '@/stores/sync.ts'
import { useVaultStore } from '@/stores/vault.ts'

/** 三条出口：open=切到该笔记并关闭；insert=把 target 交回编辑器插入（不打开文件）；close=纯关闭。 */
const emit = defineEmits<{
  (e: 'open', path: string): void
  (e: 'insert', target: string): void
  (e: 'close'): void
}>()

const vault = useVaultStore()
/** 打开失败时的唯一出口：浮层自身没有错误位，借全局通知报出来。 */
const sync = useSyncStore()

/** 挂载后立即聚焦：浮层一出现就能直接打字，无需再点一下输入框。 */
const input = ref<HTMLInputElement | null>(null)
/** 卡片元素：焦点陷阱的循环范围（见 useFocusTrap）。 */
const box = ref<HTMLElement | null>(null)
/** 当前输入，同时驱动候选过滤（见 rows）与光标复位（见 watch(query)）。 */
const query = ref('')
/** 高亮行下标，键盘移动与鼠标 hover 共同维护。 */
const cursor = ref(0)

/** 一行候选：target 是链接目标文本；exists 表示能解析到真实笔记，否则显示「新建」徽标。 */
interface Row {
  target: string
  exists: boolean
}

/**
 * 候选列表。空查询时 suggestLinks 返回全部笔记（分数 0），即「留空可浏览全部」。
 * exists 走 resolveTarget 的同一套解析规则，保证这里判定的「存在」与真正打开时的结果一致。
 */
const rows = computed<Row[]>(() =>
  vault.suggestLinks(query.value).map((item) => ({
    target: item.value,
    exists: resolveTarget(vault.resolver, item.value) !== null,
  })),
)

/** 上下移动高亮并做环形取模（首尾相接）；nextTick 后再滚动，等高亮 class 落到 DOM 上再算位置。 */
function move(delta: number): void {
  if (rows.value.length === 0) return
  cursor.value = (cursor.value + delta + rows.value.length) % rows.value.length
  void nextTick(() => document.querySelector('.pick--on')?.scrollIntoView({ block: 'nearest' }))
}

/**
 * 打开：未指定行时取当前高亮行。createFromLink 先按链接解析规则找已存在的笔记，
 * 找不到才新建 —— 回传的 path 因此一定是可打开的真实文件。
 * 失败时**不关浮层**：用户还停在选择上下文里，改一行目标再按一次即可，而不是被弹回编辑器。
 */
async function open(row?: Row): Promise<void> {
  const target = row ?? rows.value[cursor.value]
  if (!target) return
  try {
    emit('open', await vault.createFromLink(target.target))
    emit('close')
  } catch (err) {
    sync.notify('error', `无法打开「${target.target}」: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 只把目标文本交给编辑器（emit insert），不读写任何文件；同样缺省取高亮行。 */
function insert(row?: Row): void {
  const target = row ?? rows.value[cursor.value]
  if (!target) return
  emit('insert', target.target)
  emit('close')
}

/** document 级键盘处理：Esc 关闭、↑/↓ 移动高亮、Enter 打开，
 * Ctrl/⌘ + Enter 降级为「只插入链接」—— 把链接写进当前笔记而不是跳走。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    move(1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (event.ctrlKey || event.metaKey) insert()
    else open()
  }
}

/**
 * Tab 循环与关闭后的焦点还原走共用实现；Esc 仍由上面的 onKeydown 认领 ——
 * 它和 Enter 的分支挤在同一个函数里，拆出去只会让「按 Esc 到底谁响应」更难读。
 * （Modal 那边同时挂着监听时两边都会收到，与本次改动之前的行为一致。）
 */
useFocusTrap(box, { initialFocus: input })

/** 查询一变就把高亮拉回首行：候选顺序已变，旧下标指向的行没有意义。 */
watch(query, () => {
  cursor.value = 0
})

// document 监听必须成对解绑，否则浮层关掉后 Esc 仍会触发 close。
onMounted(() => {
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩：.self 保证只有点在遮罩本体上才关闭，点卡片内部（含拖动选中文本）不算 -->
    <div class="pick" @mousedown.self="emit('close')">
      <div ref="box" class="pick__box" role="dialog" aria-modal="true" aria-label="链接到笔记">
        <!-- 输入行：左侧 [[ 视觉标记表明当前是「链接目标」输入态 -->
        <div class="pick__bar">
          <span class="pick__mark">[[</span>
          <input
            ref="input"
            v-model="query"
            class="pick__input"
            placeholder="输入笔记名,回车打开,Ctrl/⌘ + 回车插入链接"
            autocapitalize="off"
            spellcheck="false"
          />
          <button class="pick__close" aria-label="关闭" @click="emit('close')">×</button>
        </div>

        <!-- 候选列表：空候选时给操作提示（库为空或查询无命中） -->
        <div class="pick__list">
          <p v-if="rows.length === 0" class="tip">
            输入名称后会创建一篇新笔记。留空可浏览全部笔记。
          </p>
          <!-- 候选行：click 打开、mouseenter 同步高亮（与键盘 cursor 保持同一行）；
               「插入」按钮 .stop 防止冒泡变成打开 -->
          <button
            v-for="(r, i) in rows"
            :key="r.target"
            class="pick__row"
            :class="{ 'pick--on': i === cursor }"
            @click="open(r)"
            @mouseenter="cursor = i"
          >
            <span class="pick__target">
              <!-- 解析不到的 target 标「新建」：回车会就地创建它 -->
              <span v-if="!r.exists" class="pick__badge">新建</span>
              {{ r.target }}
            </span>
            <span class="pick__insert" @click.stop="insert(r)">插入</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 遮罩与卡片：14vh 顶部留白让浮层悬在视口上部，类似命令面板的位置 */
.pick {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 14vh 16px 16px;
  background: var(--scrim);
  backdrop-filter: blur(2px);
}

.pick__box {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 520px;
  max-height: 60vh;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 18px 50px var(--shadow-color);
  overflow: hidden;
}

/* 输入行：卡片顶部固定，不随候选列表滚动 */
.pick__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 11px 14px;
  border-bottom: 1px solid var(--border);
}

.pick__mark {
  font-size: 15px;
  color: var(--accent);
}

.pick__input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  font-size: 15px;
  color: var(--text);
}

.pick__input::placeholder {
  color: var(--text-muted);
  font-size: 13px;
}

.pick__close {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  font-size: 19px;
  line-height: 1;
  color: var(--text-muted);
}

.pick__close:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* 候选列表：flex:1 + min-height:0 承担滚动，超出 60vh 在内部滚 */
.pick__list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px;
}

.tip {
  margin: 10px 8px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-muted);
}

.pick__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 7px;
  text-align: left;
}

.pick--on {
  /* 高亮底色：键盘与 hover 共用同一行，谁动 cursor 底色就跟谁 */
  background: var(--accent-soft);
}

.pick__target {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick--on .pick__target {
  color: var(--accent-text);
}

.pick__badge {
  margin-right: 5px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 10.5px;
}

.pick__insert {
  flex: none;
  padding: 2px 8px;
  border-radius: 5px;
  border: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-muted);
}

.pick__insert:hover {
  border-color: var(--accent);
  color: var(--accent);
}

/* 窄屏：去掉留白与圆角，整个卡片铺满视口 */
@media (max-width: 640px) {
  .pick {
    padding: 0;
    align-items: stretch;
  }

  .pick__box {
    max-width: none;
    max-height: none;
    border-radius: 0;
    border: none;
  }
}
</style>
