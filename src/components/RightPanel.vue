<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { db } from '@/core/db.ts'
import { parseFrontmatter } from '@/core/parse/frontmatter.ts'
import { titleOf } from '@/core/vault/paths.ts'
import { CARD_TYPES, CARD_TYPE_LABELS, type CardType } from '@/core/zettel/card.ts'
import { useVaultStore } from '@/stores/vault.ts'
import { useZettelStore } from '@/stores/zettel.ts'

const emit = defineEmits<{
  (e: 'open', path: string): void
  /** Routed through App.vue: it owns the editor ref and must flush before the file is rewritten. */
  (e: 'set-type', path: string, type: CardType): void
  (e: 'add-meta', path: string, type: CardType): void
}>()

const vault = useVaultStore()
const zettel = useZettelStore()

const tags = ref<string[]>([])
const words = ref<number | null>(null)
/** Whether the open note's file actually starts with a `---` block. */
const hasMeta = ref(false)
const duplicateKeys = ref<string[]>([])
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

/**
 * Rendered only for the note it was actually ranked for. Ranking is debounced and asynchronous, so
 * without this the panel would show the previous note's relatives under the current one's title.
 */
const relatedRows = computed(() => (zettel.relatedFor === vault.activePath ? zettel.related : []))

const cardType = computed<CardType>(() => (meta.value ? zettel.typeOf(meta.value.path) : 'plain'))
const aliases = computed(() => (meta.value ? zettel.aliasesOf(meta.value.path) : []))

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

/** Empty for ordinary notes, so a row without a card shows no badge at all. */
function typeBadge(path: string): string {
  const type = zettel.typeOf(path)
  return type === 'plain' ? '' : CARD_TYPE_LABELS[type]
}

/**
 * One control, two outcomes. A note that already has a block gets its `type` line rewritten; a note
 * that has none is promoted to a card, which is what also gives it the id and creation stamp. The
 * second path matters: writing `type` on its own would create a card with no permanent address.
 */
function chooseType(type: CardType): void {
  if (!meta.value || !meta.value.cached) return
  if (hasMeta.value) emit('set-type', meta.value.path, type)
  else emit('add-meta', meta.value.path, type)
}

async function loadDetails(): Promise<void> {
  const path = vault.activePath
  if (!path) {
    tags.value = []
    words.value = null
    hasMeta.value = false
    duplicateKeys.value = []
    return
  }
  tags.value = (await db.tags.where('path').equals(path).toArray()).map((t) => `#${t.tag}`)
  const body = await vault.readBody(path)
  words.value = body === null ? null : countWords(body)
  const frontmatter = body === null ? null : parseFrontmatter(body)
  hasMeta.value = frontmatter?.exists ?? false
  duplicateKeys.value = frontmatter?.duplicates ?? []
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
      <p v-if="duplicateKeys.length > 0" class="warn">
        元数据块里有重复的键 <code>{{ duplicateKeys.join(', ') }}</code>(可能是同步合并造成的)。已保留第一处,请在编辑器里手动删掉多余的行。
      </p>

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
                  <span v-if="typeBadge(l.path)" class="links__badge">{{ typeBadge(l.path) }}</span>
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

        <section v-if="relatedRows.length > 0" class="group">
          <h4 class="group__title">
            相关卡片
            <span class="group__count">{{ relatedRows.length }}</span>
          </h4>
          <ul class="links">
            <li v-for="h in relatedRows" :key="h.path">
              <button class="links__row" @click="emit('open', h.path)">
                <span class="links__title">
                  <span v-if="typeBadge(h.path)" class="links__badge">{{ typeBadge(h.path) }}</span>
                  {{ titleOf(h.path) }}
                </span>
                <span class="links__ctx">{{ h.reasons.join(' · ') }}</span>
              </button>
            </li>
          </ul>
          <p class="hint">按共引、共同标签与文本相似度推测,不代表已有链接。</p>
        </section>
      </template>

      <template v-else>
        <dl class="info">
          <dt>类型</dt>
          <dd>
            <nav class="picker">
              <button
                v-for="t in CARD_TYPES"
                :key="t"
                class="tabs__btn"
                :class="{ 'tabs__btn--on': cardType === t }"
                :disabled="!meta.cached"
                @click="chooseType(t)"
              >
                {{ CARD_TYPE_LABELS[t] }}
              </button>
            </nav>
            <p v-if="!hasMeta" class="hint">
              这篇笔记还不是卡片。选一个类型会在文件头写入 <code>id</code> / <code>type</code> /
              <code>created</code>,正文一个字节都不改。
            </p>
            <p v-else-if="!meta.cached" class="hint">内容还没下载到本机,联网同步后再改类型。</p>
          </dd>

          <template v-if="hasMeta">
            <dt>ID</dt>
            <dd class="mono">{{ zettel.zidOf(meta.path) || '无' }}</dd>
            <dt>创建时间</dt>
            <dd>{{ zettel.createdOf(meta.path) || '无' }}</dd>
            <dt>别名</dt>
            <dd>
              <span v-if="aliases.length === 0" class="muted">无</span>
              <span v-for="a in aliases" v-else :key="a" class="tag">{{ a }}</span>
            </dd>
          </template>

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
          正文以 <code>.md</code> 明文保存在本机浏览器的 OPFS 中,并通过 Gitee 仓库在设备间同步。卡片信息写在文件头的
          <code>---</code> 块里,所以它跟着仓库走,换设备也不会丢。
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

.picker {
  display: flex;
  gap: 2px;
  margin-top: 2px;
}

.picker .tabs__btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.warn {
  margin: 0 2px 12px;
  padding: 7px 9px;
  border: 1px solid var(--warn-line);
  border-radius: 7px;
  background: var(--warn-soft);
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--warn);
}

.warn code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
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
