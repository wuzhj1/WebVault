<script setup lang="ts">
import { reactive } from 'vue'
import type { TreeNode } from '@/stores/vault.ts'
import { useVaultStore } from '@/stores/vault.ts'

const props = withDefaults(defineProps<{ nodes: TreeNode[]; depth?: number }>(), { depth: 0 })
const emit = defineEmits<{
  (e: 'open', path: string): void
  (e: 'action', path: string, event: MouseEvent): void
}>()

const vault = useVaultStore()
const collapsed = reactive(new Set<string>())

function toggle(path: string): void {
  if (collapsed.has(path)) collapsed.delete(path)
  else collapsed.add(path)
}

function meta(path: string) {
  return vault.byPath.get(path)
}
</script>

<template>
  <ul class="tree" :style="{ paddingLeft: props.depth === 0 ? '0' : '10px' }">
    <li v-for="node in props.nodes" :key="node.path" class="tree__item">
      <template v-if="node.kind === 'dir'">
        <button
          class="row row--dir"
          :style="{ paddingLeft: `${6 + props.depth * 2}px` }"
          @click="toggle(node.path)"
        >
          <svg
            class="chevron"
            :class="{ 'chevron--open': !collapsed.has(node.path) }"
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
        <FileTree
          v-if="!collapsed.has(node.path)"
          :nodes="node.children"
          :depth="props.depth + 1"
          @open="(p) => emit('open', p)"
          @action="(p, ev) => emit('action', p, ev)"
        />
      </template>

      <template v-else>
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
  background: var(--accent-soft);
}

.chevron {
  flex: none;
  transition: transform 0.13s;
}

.chevron--open {
  transform: rotate(90deg);
}

.row__name {
  flex: 1;
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

@media (hover: none) {
  .row__more {
    opacity: 1;
  }
}
</style>
