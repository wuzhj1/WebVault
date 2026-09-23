<script setup lang="ts">
/**
 * 通用对话框壳:teleport 到 body 的遮罩 + 卡片,内容全部走默认插槽,底部按钮走 `footer` 插槽。
 *
 * props:`title` 是标题栏文本;`wide` 把卡片宽度从 520px 放宽到 880px(设置这类表单密集的对话框用)。
 * emits:只有 `close`,由三处触发 —— 点遮罩空白、点右上角 ×、按 ESC;父组件负责 `v-if` 挂载与卸载。
 * 不依赖任何 store,自身不持有状态,所以调用方切 v-if 即可,不需要传 visible。
 *
 * 已知约束(不是 bug 修不了,是设计上的取巧):
 * - 没有焦点陷阱,Tab 可以走到遮罩外的主界面;也不还原打开前的焦点。
 * - 不锁 body 滚动,长列表页面下滚轮会穿到背后。
 * - ESC 监听挂在 document 上且只在 key === 'Escape' 时 stopPropagation,所以遮罩内再嵌一层
 *   监听 document 的浮层(如 LinkPicker)时,z-order 更高的那个也会一并收到 ESC。
 */
import { onBeforeUnmount, onMounted } from 'vue'

/** title 必填;wide 可选,default false(模板里只做 class 开关)。 */
const props = defineProps<{ title: string; wide?: boolean }>()
/** 唯一的关闭信号,不区分是遮罩、× 还是 ESC —— 关闭语义由调用方决定。 */
const emit = defineEmits<{ (e: 'close'): void }>()

/**
 * ESC 即关。stopPropagation 是想挡住同层其它 document 级监听,但挡不住更晚注册的 listener,
 * 也压不住嵌套浮层自己的 ESC —— 真正的互斥要靠调用方只挂一个 overlay。
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}

// document 级监听而不是 @keydown.self:焦点常在输入框里,事件不会落在遮罩元素上。
onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩：.self 只有点在遮罩本体上才关闭，点卡片内部（含表单操作）不算 -->
    <div class="modal" @mousedown.self="emit('close')">
      <div class="modal__box" :class="{ 'modal__box--wide': props.wide }" role="dialog">
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
