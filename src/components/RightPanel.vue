<script setup lang="ts">
/**
 * 右侧面板：当前笔记的「链接」与「信息」两个分区。
 * - 链接：反向链接、出链、待创建（unresolved wikilink）、附件。
 * - 信息：路径 / 同步状态 / 字数 / 修改时间 / 标签。
 *
 * 数据源分工：链接结构来自 vault store；而标签、字数这类要从正文算的字段走本地
 * loadDetails() 异步查 Dexie + readBody，因为未下载的笔记（cached=false）根本没有正文可读。
 *
 * emits：
 * - 'open'(path)：跳转到某篇笔记（反链行、出链行、新建的待建笔记）。
 *
 * 依赖 store：vault（当前笔记与链接图）。卡片盒的类型/ID/别名/相关卡片与收集箱待整理
 * 条目已随卡片盒功能一并移除；元数据块只在信息分区做重复键告警，不再读取展示卡片字段。
 */
import { computed, ref, watch } from 'vue'
import { db } from '@/core/db.ts'
import { parseFrontmatter } from '@/core/parse/frontmatter.ts'
import { useSyncStore } from '@/stores/sync.ts'
import { useVaultStore } from '@/stores/vault.ts'

const emit = defineEmits<{
  /** 跳转到某篇笔记:反链行、出链行、新建的待建笔记都会发这个事件。 */
  (e: 'open', path: string): void
}>()

const vault = useVaultStore()
/** 「待创建」点击失败时的唯一出口：面板没有内联错误位，借全局通知报出来。 */
const sync = useSyncStore()

/** 当前笔记的标签列表，带 `#` 前缀，仅用于展示。 */
const tags = ref<string[]>([])
/** null = 正文还没下载到本机，字数无从统计；0 才是「真的没内容」。 */
const words = ref<number | null>(null)
/** 元数据块里重复出现的键（同步合并可能造成），只提示不自动改。 */
const duplicateKeys = ref<string[]>([])
/** 当前分区:链接 / 信息;切换只决定渲染哪一段,不影响各分区的计算属性。 */
const section = ref<'links' | 'info'>('links')

/** 当前笔记元信息；为空表示没打开任何笔记，整个面板退化为提示文案。 */
const meta = computed(() => vault.activeNote)
/** 出链里能解析到真实文件的；targetPath === null 即待创建，另归一组。 */
const resolved = computed(() => vault.outgoing.filter((l) => l.targetPath !== null))
/**
 * 每个缺失目标只出一行：`[[x]]` 与 `[[x|别名]]` 指向的是同一篇待建笔记，
 * 按 target 计数合并，否则用户会看到一串重复的「点击创建」。附件不算待创建。
 */
const unresolved = computed(() => {
  const counts = new Map<string, number>()
  for (const l of vault.outgoing) {
    if (l.targetPath !== null || l.attachment) continue
    counts.set(l.target, (counts.get(l.target) ?? 0) + 1)
  }
  return [...counts].map(([target, count]) => ({ target, count }))
})
/** 图片等非 .md 链接：不支持在线预览，只报个数。 */
const attachments = computed(() => vault.outgoing.filter((l) => l.attachment))

/** 同步状态文案,按优先级取第一个命中的:未下载 > 待上传 > 仅本地 > 已同步。 */
const syncState = computed(() => {
  const m = meta.value
  if (!m) return ''
  if (!m.cached) return '仅索引 · 未下载'
  if (m.dirty || m.removedLocal) return '待上传'
  if (m.remoteSha === null) return '仅本地'
  return '已同步'
})

/** 行标题:写了别名就显示别名,否则显示链接目标原文。 */
function labelOf(target: string, alias: string | null): string {
  return alias ?? target
}

/** 从 Dexie + OPFS 异步补齐标签、字数、元数据块重复键等展示字段;正文未下载时 words 置 null。 */
async function loadDetails(): Promise<void> {
  const path = vault.activePath
  if (!path) {
    tags.value = []
    words.value = null
    duplicateKeys.value = []
    return
  }
  tags.value = (await db.tags.where('path').equals(path).toArray()).map((t) => `#${t.tag}`)
  const body = await vault.readBody(path)
  words.value = body === null ? null : countWords(body)
  const frontmatter = body === null ? null : parseFrontmatter(body)
  duplicateKeys.value = frontmatter?.duplicates ?? []
}

/** 中日文按字计、西文按词计;先剔除 frontmatter 与代码块,免得语法符号和围栏被算成内容。 */
function countWords(body: string): number {
  const stripped = body.replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/```[\s\S]*?```/g, '')
  const cjk = (stripped.match(/[一-鿿぀-ヿ]/g) ?? []).length
  const latin = (stripped.match(/[A-Za-z0-9_$'-]+/g) ?? []).length
  return cjk + latin
}

/**
 * 点「待创建」行：按链接目标建出笔记，建成后直接打开。
 * 失败（例如目标是附件类型）必须落到全局通知 —— 裸 `void ...then()` 会让错误静默消失。
 */
async function createMissing(target: string): Promise<void> {
  try {
    emit('open', await vault.createFromLink(target))
  } catch (err) {
    sync.notify('error', `无法创建「${target}」: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 当前笔记换了、正文改了(mtime)或修订号变了(别处保存/同步拉取)都重算本地字段;immediate 保证首帧就有数据。 */
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
      <!-- 元数据块异常提示:置于两个分区之上,切换页签也始终可见 -->
      <p v-if="duplicateKeys.length > 0" class="warn">
        元数据块里有重复的键 <code>{{ duplicateKeys.join(', ') }}</code>(可能是同步合并造成的)。已保留第一处,请在编辑器里手动删掉多余的行。
      </p>

      <p v-if="!meta" class="hint">打开一篇笔记后,这里会显示它的反向链接与笔记信息。</p>

      <!-- 链接分区:反向链接 → 出链 → 待创建 → 附件,后三组无内容时整组隐藏 -->
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

      <!-- 信息分区:路径、同步状态与从正文算出来的字段(卡片元数据展示已随卡片盒移除) -->
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

/* —— 顶部「链接 / 信息」页签 —— */
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

/* 选中页签必须自己盖过 hover：否则 .tabs__btn:hover(0,2,0) 会用 --bg-hover
   压掉 --on(0,1,0) 的淡底，鼠标移上去像是高亮丢了（与 SideBar 同样的处理） */
.tabs__btn--on:hover {
  background: var(--accent-soft);
  color: var(--accent-text);
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

/* —— 链接行列表（反链、出链、待创建共用一套行样式） —— */
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

/* —— 信息分区的键值表 —— */
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
