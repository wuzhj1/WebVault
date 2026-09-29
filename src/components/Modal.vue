<script setup lang="ts">
/**
 * 通用对话框壳:teleport 到 body 的遮罩 + 卡片,内容全部走默认插槽,底部按钮走 `footer` 插槽。
 *
 * props:`title` 是标题栏文本;`wide` 把卡片宽度从 520px 放宽到 880px(设置这类表单密集的对话框用)。
 * emits:只有 `close`,由三处触发 —— 点遮罩空白、点右上角 ×、按 ESC;父组件负责 `v-if` 挂载与卸载。
 * 不依赖任何 store,自身不持有状态,所以调用方切 v-if 即可,不需要传 visible。
 *
 * 无障碍行为：打开时焦点移入卡片（读屏先听标题、再按 DOM 顺序进第一个控件），Tab / Shift+Tab
 * 被限制在卡片内循环，关闭时焦点还原到打开前的元素 —— 这三件事在 core/ui/focus-trap.ts 里，
 * 搜索 / 链接选择器 / 关系图谱三个浮层与本组件共用；body 滚动锁则是本组件独有的。
 *
 * 已知约束（设计上的取巧）：ESC 监听挂在 document 上且只在 key === 'Escape' 时 stopPropagation，
 * 所以遮罩内再嵌一层监听 document 的浮层（如 LinkPicker）时，z-order 更高的那个也会一并收到 ESC。
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useFocusTrap } from '@/core/ui/focus-trap.ts'

/** title 必填;wide 可选,default false(模板里只做 class 开关)。 */
const props = defineProps<{ title: string; wide?: boolean }>()
/** 唯一的关闭信号,不区分是遮罩、× 还是 ESC —— 关闭语义由调用方决定。 */
const emit = defineEmits<{ (e: 'close'): void }>()

/** 卡片元素；Tab 陷阱的活动范围与初始焦点都落在它身上（模板里的 ref）。 */
const box = ref<HTMLElement | null>(null)

/**
 * 焦点陷阱、焦点还原与 Esc 关闭全部交给 useFocusTrap —— 搜索 / 链接选择器 / 关系图谱
 * 三个浮层共用同一份实现，这里是唯一的 Esc 拦截点（stopPropagation 挡同层监听，
 * 但挡不住更晚注册的 listener，也压不住嵌套浮层自己的 Esc：真正的互斥要靠调用方
 * 只挂一个 overlay）。Tab 循环的细节见 focus-trap.ts。
 */
useFocusTrap(box, {
  onEscape: (event) => {
    event.stopPropagation()
    emit('close')
  },
})

// 滚动锁是 Modal 独有的需求（遮罩全屏，不锁的话滚轮会穿到背后内容上）；
// 焦点陷阱与 Esc 由上面的 useFocusTrap 负责。
onMounted(() => {
  document.body.style.overflow = 'hidden'
})

onUnmounted(() => {
  // 此刻本组件的 DOM 已移除：还找得到 .modal 就说明另有对话框仍开着，滚动锁留给它释放。
  if (document.querySelector('.modal') === null) document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩：.self 只有点在遮罩本体上才关闭，点卡片内部（含表单操作）不算 -->
    <div class="modal" @mousedown.self="emit('close')">
      <div ref="box" class="modal__box" :class="{ 'modal__box--wide': props.wide }" role="dialog" aria-modal="true" tabindex="-1">
        <header class="modal__head">
          <h3>{{ props.title }}</h3>
          <button class="modal__close" aria-label="关闭" @click="emit('close')">×</button>
        </header>
        <div class="modal__body">
          <slot />
        </div>
        <!-- footer 插槽是可选的:没传内容就整块不渲染,否则底部会凭空多一条分隔线 -->
        <footer v-if="$slots.footer" class="modal__foot">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal {
  /* 全屏遮罩:fixed + inset: 0 覆盖视口;z-index 60 低于搜索/链接浮层的 70,保证浮层能盖在它上面 */
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 8vh 16px 16px;
  background: var(--scrim);
  backdrop-filter: blur(2px);
}

.modal__box {
  /* 卡片壳：默认 520px 宽、82vh 限高，滚动交给内部的 body */
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 520px;
  max-height: 82vh;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 18px 50px var(--shadow-color);
  overflow: hidden;
}

.modal__box--wide {
  /* wide 档：放宽到 880px，给设置这类表单密集的对话框用（与 props.wide 一一对应） */
  max-width: 880px;
}

.modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.modal__head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.modal__close {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  font-size: 19px;
  line-height: 1;
  color: var(--text-muted);
}

.modal__close:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.modal__body {
  /* min-height: 0 是必须的:否则 flex 子项不肯收缩,内容会撑破卡片的 max-height 而不是内部滚动 */
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
}

.modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

/* 窄屏不再居中留白:整个对话框铺满视口,省掉圆角/边框/内边距 */
@media (max-width: 640px) {
  .modal {
    padding: 0;
    align-items: stretch;
  }

  .modal__box,
  .modal__box--wide {
    max-width: none;
    max-height: none;
    border-radius: 0;
    border: none;
  }
}
</style>
