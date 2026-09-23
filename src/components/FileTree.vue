<script setup lang="ts">
/**
 * 递归文件树:一列 TreeNode 渲染成「目录行 + 嵌套子树」或「笔记行」。
 *
 * props:`nodes` 是本层节点数组;`depth` 从 0 起,只用来算缩进(px 值随层数线性增长),不参与逻辑。
 * emits:`open(path)` 请求打开某篇笔记;`action(path, event)` 请求弹出该笔记的 ⋯ 操作菜单,
 *       把原始 MouseEvent 一起抛出去,是因为菜单位置要由调用方按点击点来定。
 * 依赖:useUiStore 的 `collapsedDirs`(哪些目录收起)、useVaultStore 的 `byPath`/`activePath`。
 *
 * 关键约束:
 * - 递归靠 SFC 文件名即组件名(FileTree.vue)自引用实现,没有 import 自己 —— 重命名文件会静默断掉整棵子树。
 * - 折叠状态绝不能存在本组件里:每层是一个独立实例,只有放在持久化的 ui store 中,深层目录才能在刷新后保持收起。
 * - 子层的 open/action 必须逐层 re-emit(见模板里的箭头函数转发),否则冒泡不到 SideBar。
 */
import type { TreeNode } from '@/stores/vault.ts'
import { useUiStore } from '@/stores/ui.ts'
import { useVaultStore } from '@/stores/vault.ts'

/** depth 有默认值所以走 withDefaults;nodes 必填,渲染以 path 为 key,因此同层内 path 必须唯一。 */
const props = withDefaults(
  defineProps<{
    nodes: TreeNode[]
    depth?: number
    /** 过滤态：true 时无视 ui.collapsedDirs 强制展开所有目录——命中藏在收起的目录里等于没找到。 */
    expandAll?: boolean
  }>(),
  { depth: 0, expandAll: false },
)
/** action 带出 MouseEvent:调用方需要事件对象才能把操作菜单定位到点击处。 */
const emit = defineEmits<{
  (e: 'open', path: string): void
  (e: 'action', path: string, event: MouseEvent): void
}>()

// 两个 store 都在 setup 取一次:模板里每行都要读,不能写成 ui.xxx() 形式的重复调用。
const ui = useUiStore()
const vault = useVaultStore()

/** 收起/展开某目录。状态在 ui store(持久化 + 跨层级共享),这里只是转发一下便于模板少写一层。 */
function toggle(path: string): void {
  ui.toggle(path)
}

/** 取某路径的元数据,用于打「未上传」「未缓存」角标;树里可能有远端存在但本地无内容的条目,故返回 undefined。 */
function meta(path: string) {
  return vault.byPath.get(path)
}
</script>

<template>
  <!-- 每层一个列表：根层不加左缩进，子层整体左移 10px，再与行内 depth 步长叠加出最终缩进 -->
  <ul class="tree" :style="{ paddingLeft: props.depth === 0 ? '0' : '10px' }">
    <li v-for="node in props.nodes" :key="node.path" class="tree__item">
      <template v-if="node.kind === 'dir'">
        <!-- 目录行：整行点击切换折叠，右侧数字是直接子项数；
             缩进 = 6 + 2×depth —— 小步长是因为大头已由子 ul 的 10px 承担，两套叠加避免双重放大 -->
        <button
          class="row row--dir"
          :style="{ paddingLeft: `${6 + props.depth * 2}px` }"
          @click="toggle(node.path)"
        >
          <svg
            class="chevron"
            :class="{ 'chevron--open': props.expandAll || !ui.collapsedDirs.has(node.path) }"
            viewBox="0 0 16 16"
            width="12"
            height="12"
            aria-hidden="true"
          >
            <path d="M6 3.5 L10.5 8 L6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" />
          </svg>
          <span class="row__name">{{ node.name }}</span>
          <span class="row__count">{{ node.children.length }}</span>
        </button>
        <!-- 自引用递归:收起时整棵子树 v-if 卸载(不留 DOM);子层事件必须箭头函数逐层 re-emit 才冒泡到 SideBar。
             expandAll 同步下传:过滤时整棵树都得展开,否则命中会藏在某个收起的目录里 -->
        <FileTree
          v-if="props.expandAll || !ui.collapsedDirs.has(node.path)"
          :nodes="node.children"
          :depth="props.depth + 1"
          :expand-all="props.expandAll"
          @open="(p) => emit('open', p)"
          @action="(p, ev) => emit('action', p, ev)"
        />
      </template>

      <template v-else>
        <!-- 缩进 = 20 + 12×depth：笔记行没有 chevron，用更大的固定步长直接画出层级 -->
        <!-- 用 div + role="button" + tabindex 而不是 <button>:行内还要嵌 ⋯ 操作按钮,button 不能套 button -->
        <div
          class="row row--note"
          :class="{ 'row--active': vault.activePath === node.path }"
          :style="{ paddingLeft: `${20 + props.depth * 12}px` }"
          role="button"
          tabindex="0"
          @click="emit('open', node.path)"
          @keydown.enter.prevent="emit('open', node.path)"
          @keydown.space.prevent="emit('open', node.path)"
        >
          <span class="row__name">{{ node.name }}</span>
          <!-- 角标：实心点 = 有未上传的本地修改；云朵 = 正文尚未下载到本地 -->
          <span class="row__badges">
            <span
              v-if="meta(node.path)?.dirty"
              class="badge badge--dirty"
              title="有未上传的本地修改"
            ></span>
            <svg
              v-if="meta(node.path) && !meta(node.path)!.cached"
              class="badge badge--cloud"
              viewBox="0 0 16 16"
              width="12"
              height="12"
              aria-label="尚未下载到本地"
            >
              <path
                d="M4.5 12a3 3 0 0 1-.3-6A4 4 0 0 1 12 6.6a2.7 2.7 0 0 1-.4 5.4z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
              />
            </svg>
          </span>
          <!-- .stop 是必需的:否则点击会同时冒泡到外层 div,既弹菜单又打开笔记 -->
          <button
            class="row__more"
            aria-label="笔记操作"
            @click.stop="emit('action', node.path, $event)"
          >
            ⋯
          </button>
        </div>
      </template>
    </li>
  </ul>
</template>

<style scoped>
.tree {
  margin: 0;
  padding: 0;
  list-style: none;
}

.tree__item {
  margin: 0;
}

/* 行样式：目录行与笔记行共用 .row，靠 --dir / --note / --active 修饰区分 */
.row {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding-top: 3px;
  padding-bottom: 3px;
  padding-right: 6px;
  border-radius: 6px;
  text-align: left;
  font-size: 13.5px;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}

.row:hover {
  background: var(--bg-hover);
}

.row--dir {
  color: var(--text-muted);
  font-weight: 500;
}

.row--active {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.row--active:hover {
  /* 悬停也保持高亮：不能让 hover 底色盖掉「正在看这篇」的标记 */
  background: var(--accent-soft);
}

.chevron {
  flex: none;
  transition: transform 0.13s;
}

.chevron--open {
  /* 展开态右转 90°，配合 transition 做出折叠动画；class 由「不在 collapsedDirs 里」驱动 */
  transform: rotate(90deg);
}

.row__name {
  flex: 1;
  /* min-width: 0 覆盖 flex 子项默认的 auto,否则长文件名会撑宽整行而非走省略号 */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row__count {
  flex: none;
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.75;
}

.row__badges {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.badge--dirty {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
}

.badge--cloud {
  color: var(--text-muted);
}

/* ⋯ 操作按钮：默认隐藏，行悬停或行处于选中态时露出（触屏无 hover，见文件末尾的媒体查询） */
.row__more {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  font-size: 13px;
  line-height: 1;
  color: var(--text-muted);
  opacity: 0;
}

.row:hover .row__more,
.row--active .row__more {
  opacity: 1;
}

.row__more:hover {
  background: var(--border);
  color: var(--text);
}

/* 触屏无 hover:⋯ 改为常显。只动 opacity,位置仍占着,行宽不会跳 */
@media (hover: none) {
  .row__more {
    opacity: 1;
  }
}
</style>
