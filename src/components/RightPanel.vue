<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { db } from '@/core/db.ts'
import { useVaultStore } from '@/stores/vault.ts'

const emit = defineEmits<{ (e: 'open', path: string): void }>()

const vault = useVaultStore()

const tags = ref<string[]>([])
const words = ref<number | null>(null)
const section = ref<'links' | 'info'>('links')

const meta = computed(() => vault.activeNote)
const resolved = computed(() => vault.outgoing.filter((l) => l.targetPath !== null))
/** One row per missing target: `[[x]]` and `[[x|别名]]` are the same note to create. */
const unresolved = computed(() => {
  const counts = new Map<string, number>()
  for (const l of vault.outgoing) {
    if (l.targetPath !== null || l.attachment) continue
    counts.set(l.target, (counts.get(l.target) ?? 0) + 1)
  }
  return [...counts].map(([target, count]) => ({ target, count }))
})
const attachments = computed(() => vault.outgoing.filter((l) => l.attachment))

const syncState = computed(() => {
  const m = meta.value
  if (!m) return ''
  if (!m.cached) return '仅索引 · 未下载'
  if (m.dirty || m.removedLocal) return '待上传'
  if (m.remoteSha === null) return '仅本地'
  return '已同步'
})

function labelOf(target: string, alias: string | null): string {
  return alias ?? target
}

async function loadDetails(): Promise<void> {
  const path = vault.activePath
  if (!path) {
    tags.value = []
    words.value = null
    return
  }
  tags.value = (await db.tags.where('path').equals(path).toArray()).map((t) => `#${t.tag}`)
  const body = await vault.readBody(path)
  words.value = body === null ? null : countWords(body)
}

function countWords(body: string): number {
  const stripped = body.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/```[\s\S]*?```/g, '')
  const cjk = (stripped.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length
  const latin = (stripped.match(/[A-Za-z0-9_$'-]+/g) ?? []).length
  return cjk + latin
}

function createMissing(target: string): void {
  void vault.createFromLink(target).then((path) => emit('open', path))
}

watch(
  () => [vault.activePath, meta.value?.mtime, vault.bodyRevision] as const,
  () => {
    void loadDetails()
  },
  { immediate: true },
)
</script>

<template>
  <aside class="panel">
    <div class="panel__head">
      <nav class="tabs">
        <button
          class="tabs__btn"
          :class="{ 'tabs__btn--on': section === 'links' }"
          @click="section = 'links'"
        >
          链接
        </button>
        <button
          class="tabs__btn"
          :class="{ 'tabs__btn--on': section === 'info' }"
          @click="section = 'info'"
        >
          信息
        </button>
      </nav>
    </div>

    <div class="panel__scroll">
      <p v-if="!meta" class="hint">打开一篇笔记后,这里会显示它的反向链接与笔记信息。</p>

      <template v-else-if="section === 'links'">
        <section class="group">
          <h4 class="group__title">
            反向链接
            <span class="group__count">{{ vault.inbound.length }}</span>
          </h4>
          <p v-if="vault.inbound.length === 0" class="hint">
            还没有笔记链接到 <code>[[{{ meta.title }}]]</code>。
          </p>
          <ul v-else class="links">
            <li v-for="(l, i) in vault.inbound" :key="`${l.path}:${l.line}:${i}`">
              <button class="links__row" @click="emit('open', l.path)">
                <span class="links__title">
                  <span v-if="l.embed" class="links__badge">嵌入</span>
                  {{ l.title }}
                </span>
                <span class="links__ctx">{{ l.context }}</span>
              </button>
            </li>
          </ul>
        </section>

        <section class="group">
          <h4 class="group__title">
            出链
            <span class="group__count">{{ resolved.length }}</span>
          </h4>
          <p v-if="resolved.length === 0" class="hint">这篇笔记没有链接到其它笔记。</p>
          <ul v-else class="links">
            <li v-for="(l, i) in resolved" :key="`${l.target}:${i}`">
              <button class="links__row" @click="emit('open', l.targetPath!)">
                <span class="links__title">
                  <span v-if="l.embed" class="links__badge">嵌入</span>
                  {{ labelOf(l.target, l.alias) }}
                </span>
                <span class="links__ctx">{{ l.targetPath }}<template v-if="l.heading"> → {{ l.heading }}</template></span>
              </button>
            </li>
          </ul>
        </section>

        <section v-if="unresolved.length > 0" class="group">
          <h4 class="group__title">
            待创建
            <span class="group__count">{{ unresolved.length }}</span>
          </h4>
          <ul class="links">
            <li v-for="u in unresolved" :key="u.target">
              <button class="links__row links__row--new" @click="createMissing(u.target)">
                <span class="links__title">{{ u.target }}</span>
                <span class="links__ctx">
                  {{ u.count > 1 ? `被引用 ${u.count} 次 · ` : '' }}点击创建这篇笔记
                </span>
              </button>
            </li>
          </ul>
        </section>

        <section v-if="attachments.length > 0" class="group">
          <h4 class="group__title">
            附件
            <span class="group__count">{{ attachments.length }}</span>
          </h4>
          <p class="hint">附件暂不支持在线预览,可在 Gitee 仓库中查看。</p>
        </section>
      </template>

      <template v-else>
        <dl class="info">
          <dt>路径</dt>
          <dd class="mono">{{ meta.path }}</dd>
          <dt>同步状态</dt>
          <dd>
            <span class="state" :class="{ 'state--warn': meta.dirty || !meta.cached }">{{ syncState }}</span>
          </dd>
          <dt>字数</dt>
          <dd>{{ words === null ? '未下载' : words }}</dd>
          <dt>修改时间</dt>
          <dd>{{ new Date(meta.mtime).toLocaleString('zh-CN', { hour12: false }) }}</dd>
          <dt>标签</dt>
          <dd>
            <span v-if="tags.length === 0" class="muted">无</span>
            <span v-for="t in tags" v-else :key="t" class="tag">{{ t }}</span>
          </dd>
        </dl>
        <p class="hint">
          正文以 <code>.md</code> 明文保存在本机浏览器的 OPFS 中,并通过 Gitee 仓库在设备间同步。
        </p>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg-elevated);
  border-left: 1px solid var(--border);
}

.panel__head {
  flex: none;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}

.tabs {
  display: flex;
  gap: 2px;
}

.tabs__btn {
  flex: 1;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--text-muted);
}

.tabs__btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.tabs__btn--on {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.panel__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 10px 28px;
}

.group + .group {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}

.group__title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-muted);
}

.group__count {
  padding: 0 5px;
  border-radius: 8px;
  background: var(--bg-hover);
  font-size: 10.5px;
  line-height: 15px;
  letter-spacing: 0;
}

.links {
  margin: 0;
  padding: 0;
  list-style: none;
}

.links__row {
  display: block;
  width: 100%;
  padding: 5px 8px;
  border-radius: 6px;
  border-left: 2px solid transparent;
  text-align: left;
}

.links__row:hover {
  background: var(--bg-hover);
  border-left-color: var(--accent);
}

.links__title {
  display: block;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.links__ctx {
  display: block;
  margin-top: 1px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.links__badge {
  margin-right: 4px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 10px;
}

.links__row--new .links__title {
  color: var(--warn);
}

.hint {
  margin: 4px 2px 8px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-muted);
}

.hint code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

.info {
  margin: 0;
  font-size: 12.5px;
}

.info dt {
  margin-top: 10px;
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--text-muted);
}

.info dd {
  margin: 2px 0 0;
  word-break: break-all;
}

.mono {
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.muted {
  color: var(--text-muted);
}

.tag {
  display: inline-block;
  margin: 0 4px 4px 0;
  padding: 1px 7px;
  border-radius: 9px;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 11.5px;
}

.state {
  color: var(--ok);
}

.state--warn {
  color: var(--warn);
}
</style>
