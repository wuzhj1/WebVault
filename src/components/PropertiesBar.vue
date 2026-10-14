<script setup lang="ts">
/**
 * 属性条：编辑器上方那条可折叠的元数据区，对标 Obsidian 的 Properties。
 *
 * **为什么它在编辑器外面**：frontmatter 从不进编辑器（见 NoteEditor 硬约束第 1 条），所以属性
 * 不能是正文的一部分。但它必须由 NoteEditor 持有 —— `loadedFm` 的所有权在那边，本组件只负责
 * 「渲染 + 请求改写」，一次都不自己碰文件。跨组件直接写文件正是本设计要避开的那个坑：
 * 缓存里的块一旦和磁盘脱钩，用户下一次防抖保存就会用旧块 + 新正文把刚写的属性静默冲掉。
 *
 * 三条分工：
 * - **文件改写** → `emit('patch', ...)` 交给 NoteEditor 的 `applyPropertyPatch`（它负责
 *   flushSave、磁盘一致性断言、缓存跟新、schedulePush，且把并发改写串成一条链）。
 * - **类型声明** → 本组件直接用 `stores/properties.ts`：那是设置，不是文件内容，
 *   改它不该把笔记标脏、也不该推一次同步。
 * - **折叠态** → `localStorage`。刻意不进 `.webvault/`：折叠与否是本机屏幕的事，
 *   不该跟着库同步到别的机器（Obsidian 把同类状态放 gitignore 的 workspace.json，同一个道理）。
 *
 * 本组件只读不写，所以它对 `fm` 的一切推断都必须容忍畸形：重复 key、认不出的类型、
 * 引号风格不一致的值，全都当成「照实显示」，绝不试图顺手修正。
 */
import { computed, ref } from 'vue'
import {
  OWNED_KEYS,
  isValidPropertyKey,
  parseFrontmatter,
  readList,
  readRaw,
  readScalar,
  type FrontmatterPatch,
} from '@/core/parse/frontmatter.ts'
import {
  PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS,
  resolveType,
  type PropertyType,
} from '@/core/parse/property-types.ts'
import { usePropertiesStore } from '@/stores/properties.ts'

const props = defineProps<{
  /** NoteEditor 缓存的那块 frontmatter；正常情况下始终与磁盘一致（见 applyPropertyPatch 的断言）。 */
  fm: string
  /** 与正文同一把锁：属性也是文件内容，锁着就不给改。 */
  editable: boolean
}>()

const emit = defineEmits<{
  /** 请求改写元数据块。真正写文件的时机与顺序由 NoteEditor 收口，本组件不等结果。 */
  (e: 'patch', patch: FrontmatterPatch): void
}>()

const properties = usePropertiesStore()

/**
 * 只读的两个 key：
 * - `id` 是笔记的永久地址，改它等于让全库 `[[id]]` 双链集体失联，而且失联是无声的；
 * - `date` 决定日历归属。换一天应当走「移动/重命名笔记」——`core/daily.ts` 模块头钉着
 *   「写只有两处」这条不变量，属性条不去破它。属性条只展示，让用户看得见日记是哪天。
 */
const READONLY_KEYS = new Set(['id', 'date'])

interface PropRow {
  key: string
  type: PropertyType
  /** 标量的显示值（已解码）；list 行为空，真正的条目在 `items` 里。 */
  value: string
  items: string[]
  /** 三方合并造出来的重复 key：`writeKeys` 一概不碰，只能提示，不能给编辑入口。 */
  duplicate: boolean
  readonly: boolean
}

/**
 * 把块解析成要渲染的行。这里是**唯一的取值来源**，组件里不存在第二份状态 ——
 * 一旦出现「本地草稿」和「文件里的真值」两套值，就必然有一个会赢，而赢错了就是静默丢数据。
 */
const rows = computed<PropRow[]>(() => {
  const fm = parseFrontmatter(props.fm)
  const dupes = new Set(fm.duplicates)
  return fm.entries.map((entry) => {
    const declared = resolveType(fm, entry.key, properties.types)
    // `id` 是一串形如 202609151423 的地址,按值推断会落到 number。它是**标识符不是数值**:
    // 数字控件会做千分位/科学计数法呈现,一个被重新格式化的地址就不再是那个地址了。
    // 没有 `id` 的旧笔记本来就会推断成文本,这条只是把「有 id」的情况掰正。
    const type = entry.key === 'id' ? 'text' : declared
    const list = type === 'list' ? readList(fm, entry.key) : null
    // readScalar 会把 `[a, b]` 判成「不是标量」返回 null；此时退回原样值，
    // 否则一个「标量值恰好长得像列表」的字段会显示成空，用户一改就把原值丢了。
    const value = list === null ? (readScalar(fm, entry.key) ?? readRaw(fm, entry.key) ?? '') : ''
    const duplicate = dupes.has(entry.key)
    return {
      key: entry.key,
      type,
      value,
      items: list ?? [],
      duplicate,
      readonly: duplicate || READONLY_KEYS.has(entry.key),
    }
  })
})

/** 一次只可能有一处改名在进行（输入框是逐个失焦的），所以用一个错误位就够。 */
const keyError = ref('')
/**
 * 改名被拒后强制重建键名输入框。Vue 只在重渲染时应用 `:value`，而改名失败恰恰意味着
 * `fm` 没变、不会重渲染 —— 不给它一个新的 DOM 身份，输入框就永远停在那个非法字串上。
 */
const keyRev = ref(0)

/** 新增属性的三个控件；类型默认文本，用户可在提交前改。 */
const newKey = ref('')
const newValue = ref('')
const newType = ref<PropertyType>('text')
const addError = ref('')

/** 折叠态：默认展开（否则这个功能等于不存在），显式切换后才记进本机。 */
const OPEN_KEY = 'wv-props-open'
const open = ref(readOpenPref())
const openSettled = ref(false)

function readOpenPref(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

function toggle(): void {
  open.value = !open.value
  openSettled.value = true
  try {
    localStorage.setItem(OPEN_KEY, open.value ? '1' : '0')
  } catch {
    // 隐身模式等写入失败不值得报错：折叠偏好丢了就丢了。
  }
}

/**
 * 键名建议：本库持有的六个 key 与用户配过类型的 key，减去这篇已经有的。
 * 用 `<datalist>` 而不是自绘下拉 —— 原生补全在移动端与读屏器上都能用，自绘的多半不能。
 */
const suggestions = computed<string[]>(() => {
  const have = new Set(rows.value.map((r) => r.key))
  return [...new Set([...OWNED_KEYS, ...Object.keys(properties.types)])].filter((k) => !have.has(k))
})

/** 一行当前的值：list 还是列表，其余是标量字符串。改键名时靠它把值一起搬过去。 */
function valueOf(row: PropRow): string | string[] {
  return row.type === 'list' ? row.items : row.value
}

/** 取输入框的当前文本。类型断言只写在 script 里 —— 模板表达式不吃 `as`。 */
function text(e: Event): string {
  return (e.target as HTMLInputElement).value
}

function checked(e: Event): boolean {
  return (e.target as HTMLInputElement).checked
}

/**
 * 值改动 → 请求改写。这里**没有失败分支**：`writeKeys` 对合法值必然成功，
 * 唯一会失败的是 NoteEditor 那侧的磁盘一致性检查，那条路已经带 `sync.notify` 报出去了。
 * 输入框因此不做草稿回滚 —— 失败时它保留用户敲的字并伴随一条错误提示，
 * 比悄悄抹掉更诚实（用户能看见到底什么没存进去）。
 */
function commitValue(key: string, value: string): void {
  emit('patch', { [key]: value })
}

function onToggle(key: string, e: Event): void {
  commitValue(key, checked(e) ? 'true' : 'false')
}

function onTextChange(key: string, e: Event): void {
  commitValue(key, text(e))
}

function onDateChange(key: string, e: Event): void {
  commitValue(key, text(e))
}

function onNumberChange(key: string, e: Event): void {
  commitValue(key, text(e))
}

/** 列表追加：读完立刻清空输入框，否则同一条目会被再加一次。 */
function addItem(row: PropRow, e: Event): void {
  const input = e.target as HTMLInputElement
  const value = input.value.trim()
  if (value === '') return
  emit('patch', { [row.key]: [...row.items, value] })
  input.value = ''
}

function removeItem(row: PropRow, index: number): void {
  emit('patch', { [row.key]: row.items.filter((_, i) => i !== index) })
}

function removeRow(row: PropRow): void {
  emit('patch', { [row.key]: null })
}

/**
 * 改键名 = 一次改写里同时删旧键、写新键（`writeKeys` 的 `removals` 与 `inserts` 两个桶
 * 天然支持一次完成），因此值不会有一瞬间「哪儿都不在」。
 *
 * 两个前置拒绝都必须发生在 emit 之前：发出去再被拒绝，用户看到的就是「改名没生效」
 * 而不是一句能照着改的提示。
 */
function commitRename(row: PropRow, e: Event): void {
  const to = text(e).trim()
  if (to === row.key) return
  if (!isValidPropertyKey(to)) {
    keyError.value = `「${to}」不是合法的属性名：字母开头，可含字母、数字、下划线、点、连字符、斜杠`
    keyRev.value++
    return
  }
  if (rows.value.some((r) => r.key === to)) {
    keyError.value = `这篇笔记已经有「${to}」了`
    keyRev.value++
    return
  }
  keyError.value = ''
  emit('patch', { [row.key]: null, [to]: valueOf(row) })
}

/** 撤销未提交的改名提示：Esc 是「当没改过」，不该把它留到下次失焦再报一遍。 */
function cancelRename(): void {
  keyError.value = ''
  keyRev.value++
}

/** 类型只改注册表（设置），不动文件 —— 同一份值换一种读法而已，不该把笔记标脏。 */
function changeType(row: PropRow, e: Event): void {
  const value = text(e)
  if (!(PROPERTY_TYPES as readonly string[]).includes(value)) return
  void properties.setType(row.key, value as PropertyType)
}

/** 新增属性。列表值按逗号切（含中文顿号），其余类型整串照写，交给 `encodeScalar` 编码。 */
function addProperty(): void {
  const key = newKey.value.trim()
  addError.value = ''
  if (key === '') return
  if (!isValidPropertyKey(key)) {
    addError.value = `「${key}」不是合法的属性名：字母开头，可含字母、数字、下划线、点、连字符、斜杠`
    return
  }
  if (rows.value.some((r) => r.key === key)) {
    addError.value = `这篇笔记已经有「${key}」了`
    return
  }
  const raw = newValue.value.trim()
  const value =
    newType.value === 'list' ? raw.split(/[,，、]/).map((s) => s.trim()).filter((s) => s !== '') : raw
  emit('patch', { [key]: value })
  // 保留类型、清空键名与值：连着加几个同类属性时，重敲类型是最没必要的那一步。
  newKey.value = ''
  newValue.value = ''
}
</script>

<template>
  <div class="props">
    <button
      type="button"
      class="props__head"
      :aria-expanded="open"
      :title="open ? '收起属性' : '展开属性'"
      @click="toggle"
    >
      <span class="props__chevron" :class="{ 'props__chevron--on': open }">▾</span>
      <span class="props__label">属性</span>
      <span class="props__count">{{ rows.length }}</span>
      <span v-if="!open && rows.length > 0" class="props__peek">
        {{ rows.slice(0, 3).map((r) => `${r.key}: ${r.type === 'list' ? r.items.join(', ') : r.value || '—'}`).join(' · ') }}
      </span>
    </button>

    <div v-show="open" class="props__body">
      <p v-if="rows.length === 0" class="props__empty">
        这篇笔记还没有元数据块。属性（创建日期、标签、分类……）都存在正文上方的 <code>---</code> 块里，
        正文里看不到它们。
      </p>

      <div
        v-for="row in rows"
        :key="row.key"
        class="prop"
        :class="{ 'prop--locked': row.readonly }"
      >
        <input
          class="prop__key"
          type="text"
          :key="`${row.key}#${keyRev}`"
          :value="row.key"
          :list="row.key === 'id' || row.key === 'date' ? undefined : 'wv-prop-keys'"
          :disabled="!editable || row.readonly"
          :title="row.readonly ? (row.duplicate ? '元数据块里这个键出现了多次（同步合并所致），只提示、不自动改' : '这个字段由系统维护，不在此处修改') : '键名'"
          spellcheck="false"
          @change="commitRename(row, $event)"
          @keydown.esc="cancelRename"
        />

        <!-- 值编辑器按类型分流；共用同一条 emit('patch') 出口。 -->
        <input
          v-if="row.type === 'checkbox'"
          class="prop__check"
          type="checkbox"
          :checked="row.value === 'true'"
          :disabled="!editable || row.readonly"
          @change="onToggle(row.key, $event)"
        />
        <div v-else-if="row.type === 'list'" class="prop__chips">
          <span v-for="(item, i) in row.items" :key="i" class="chip">
            <span class="chip__text">{{ item }}</span>
            <button
              v-if="editable && !row.readonly"
              type="button"
              class="chip__x"
              :aria-label="`移除 ${item}`"
              @click="removeItem(row, i)"
            >
              ×
            </button>
          </span>
          <input
            v-if="editable && !row.readonly"
            class="prop__value prop__value--inline"
            type="text"
            placeholder="添加…"
            spellcheck="false"
            @change="addItem(row, $event)"
          />
          <span v-if="row.items.length === 0 && !(editable && !row.readonly)" class="prop__blank">—</span>
        </div>
        <input
          v-else-if="row.type === 'date'"
          class="prop__value"
          type="date"
          :value="row.value"
          :disabled="!editable || row.readonly"
          @change="onDateChange(row.key, $event)"
        />
        <input
          v-else-if="row.type === 'number'"
          class="prop__value"
          type="number"
          :value="row.value"
          :disabled="!editable || row.readonly"
          @change="onNumberChange(row.key, $event)"
        />
        <input
          v-else
          class="prop__value"
          type="text"
          :value="row.value"
          :placeholder="row.readonly ? '（由系统维护）' : ''"
          :disabled="!editable || row.readonly"
          spellcheck="false"
          @change="onTextChange(row.key, $event)"
        />

        <select
          class="prop__type"
          :value="row.type"
          :disabled="!editable || row.readonly"
          :title="`当前类型：${PROPERTY_TYPE_LABELS[row.type]}`"
          @change="changeType(row, $event)"
        >
          <option v-for="t in PROPERTY_TYPES" :key="t" :value="t">{{ PROPERTY_TYPE_LABELS[t] }}</option>
        </select>

        <button
          v-if="editable && !row.readonly"
          type="button"
          class="prop__del"
          :aria-label="`删除属性 ${row.key}`"
          title="删除这个属性"
          @click="removeRow(row)"
        >
          ×
        </button>
        <span v-else class="prop__del prop__del--void" aria-hidden="true"></span>
      </div>

      <p v-if="keyError" class="props__err" role="alert">{{ keyError }}</p>

      <div v-if="editable" class="prop prop--add">
        <input
          v-model="newKey"
          class="prop__key"
          type="text"
          list="wv-prop-keys"
          placeholder="新属性名"
          spellcheck="false"
          @keydown.enter="addProperty"
        />
        <input
          v-model="newValue"
          class="prop__value"
          type="text"
          :placeholder="newType === 'list' ? '值，逗号分隔' : '值'"
          spellcheck="false"
          @keydown.enter="addProperty"
        />
        <select v-model="newType" class="prop__type" aria-label="新属性的类型">
          <option v-for="t in PROPERTY_TYPES" :key="t" :value="t">{{ PROPERTY_TYPE_LABELS[t] }}</option>
        </select>
        <button type="button" class="prop__add" :disabled="newKey.trim() === ''" @click="addProperty">
          添加
        </button>
      </div>

      <p v-if="addError" class="props__err" role="alert">{{ addError }}</p>

      <datalist id="wv-prop-keys">
        <option v-for="k in suggestions" :key="k" :value="k" />
      </datalist>
    </div>
  </div>
</template>

<style scoped>
.props {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.props__head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 14px;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.props__head:hover {
  background: var(--bg-hover);
}

.props__chevron {
  display: inline-block;
  font-size: 10px;
  transition: transform 0.15s ease;
}

.props__chevron--on {
  transform: rotate(-90deg);
}

.props__label {
  color: var(--text);
  font-weight: 600;
}

.props__count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-muted);
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}

/* 收起时的一行摘要：三个键值对足以让人判断「我是不是在看同一篇」。 */
.props__peek {
  overflow: hidden;
  flex: 1;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.props__body {
  padding: 2px 14px 10px;
}

.props__empty {
  margin: 6px 0 4px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.props__empty code {
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--code-bg);
  font-size: 11px;
}

.props__err {
  margin: 6px 0 0;
  color: var(--danger);
  font-size: 11px;
  line-height: 1.5;
}

.prop {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
}

.prop__key {
  width: 130px;
  flex: 0 0 auto;
}

.prop__value {
  flex: 1 1 auto;
  min-width: 0;
}

.prop__value--inline {
  flex: 0 1 auto;
  width: 96px;
}

.prop__key,
.prop__value,
.prop__type {
  height: 26px;
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
}

/* 平时不画边框，hover 才显形：一屏十几个字段全带框会读起来像表格而不是笔记。 */
.prop__key:hover,
.prop__value:hover,
.prop__type:hover {
  border-color: var(--border);
  background: var(--bg-hover);
}

.prop__key:focus,
.prop__value:focus,
.prop__type:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--bg-elevated);
}

.prop__key:disabled,
.prop__value:disabled,
.prop__type:disabled,
.prop__check:disabled {
  color: var(--text-muted);
  cursor: not-allowed;
  opacity: 0.7;
}

.prop__type {
  width: 74px;
  flex: 0 0 auto;
  padding-right: 2px;
  color: var(--text-muted);
  font-size: 11px;
}

.prop__check {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
  accent-color: var(--accent);
}

.prop__chips {
  display: flex;
  flex: 1 1 auto;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
  align-items: center;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  padding: 1px 4px 1px 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 11px;
}

.chip__text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip__x {
  width: 14px;
  height: 14px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.chip__x:hover {
  background: color-mix(in srgb, var(--danger) 30%, transparent);
}

.prop__blank {
  color: var(--text-muted);
  font-size: 12px;
}

.prop__del,
.prop__add {
  flex: 0 0 auto;
}

.prop__del {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  visibility: hidden;
}

/* 没有删除按钮的行仍要占位，否则 hover 时整行会横跳。 */
.prop__del--void {
  visibility: hidden;
}

.prop:hover .prop__del:not(.prop__del--void) {
  visibility: visible;
}

.prop__del:hover {
  background: var(--bg-hover);
  color: var(--danger);
}

.prop--add {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}

.prop--add .prop__key {
  width: 130px;
}

.prop--add .prop__value {
  border-color: var(--border);
}

.prop__add {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-elevated);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}

.prop__add:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-text);
}

.prop__add:disabled {
  color: var(--text-muted);
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
