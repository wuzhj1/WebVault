<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import * as opfs from '@/core/vault/opfs.ts'
import { useSettingsStore, type SyncSettings } from '@/stores/settings.ts'
import { useSyncStore } from '@/stores/sync.ts'
import { useVaultStore } from '@/stores/vault.ts'
import Modal from './Modal.vue'

const emit = defineEmits<{ (e: 'close'): void }>()

const settings = useSettingsStore()
const sync = useSyncStore()
const vault = useVaultStore()

const tab = ref<'sync' | 'data' | 'about'>('sync')
const draft = ref<SyncSettings>({ ...settings.settings })
const showToken = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)
const usage = ref<string>('')
const persisted = ref<boolean | null>(null)
const reindexing = ref(false)
const reindexed = ref<number | null>(null)
const wipeBusy = ref(false)

const DELAYS: { ms: number; label: string }[] = [
  { ms: 5_000, label: '5 秒' },
  { ms: 15_000, label: '15 秒' },
  { ms: 60_000, label: '1 分钟' },
  { ms: 300_000, label: '5 分钟' },
  { ms: 1_800_000, label: '30 分钟' },
]

const stats = computed(() => {
  const all = vault.notes.filter((n) => !n.removedLocal)
  return {
    total: all.length,
    cached: all.filter((n) => n.cached).length,
    pending: vault.pendingUpload,
  }
})

const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(settings.settings))

async function refreshUsage(): Promise<void> {
  if (typeof navigator.storage?.estimate !== 'function') {
    usage.value = '当前浏览器不提供存储用量信息。'
    return
  }
  const est = await navigator.storage.estimate()
  const used = est.usage ?? 0
  const quota = est.quota ?? 0
  usage.value = quota
    ? `已用 ${(used / 1048576).toFixed(1)} MB,浏览器配额约 ${(quota / 1073741824).toFixed(1)} GB`
    : `已用 ${(used / 1048576).toFixed(1)} MB`
  persisted.value = await opfs.persistedStorageGranted()
}

async function save(): Promise<void> {
  error.value = null
  saved.value = false
  const wasConfigured = settings.configured
  try {
    await settings.save({ ...draft.value })
    saved.value = true
    setTimeout(() => {
      saved.value = false
    }, 2000)
    if (!wasConfigured && settings.configured && sync.online) {
      await sync.syncNow()
      void sync.startPreheat()
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function test(): Promise<void> {
  await settings.save({ ...draft.value })
  await sync.checkConnection()
}

async function reindex(): Promise<void> {
  reindexing.value = true
  reindexed.value = null
  try {
    let count = 0
    for (const n of vault.notes) {
      if (n.removedLocal || !n.cached) continue
      const body = await opfs.readNote(n.path)
      if (body === null) continue
      await vault.reindexContent(n.path, body)
      count++
    }
    await vault.refreshDerived()
    reindexed.value = count
  } finally {
    reindexing.value = false
  }
}

/**
 * Deleting the bodies and reloading reuses the startup wipe-recovery path: `reconcile()`
 * notices OPFS came back empty while the index still knows the notes, and the sync store
 * re-pulls every body with progress reporting.
 */
async function wipeAndReload(): Promise<void> {
  wipeBusy.value = true
  error.value = null
  try {
    await opfs.clearAllNotes()
    location.reload()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    wipeBusy.value = false
  }
}

watch(
  () => settings.settings,
  (next) => {
    if (!dirty.value) draft.value = { ...next }
  },
  { deep: true },
)

onMounted(() => {
  draft.value = { ...settings.settings }
  void refreshUsage()
  void sync.refreshLog()
})
</script>

<template>
  <Modal title="设置" wide @close="emit('close')">
    <nav class="tabs">
      <button
        v-for="t in (['sync', 'data', 'about'] as const)"
        :key="t"
        class="tabs__btn"
        :class="{ 'tabs__btn--on': tab === t }"
        @click="tab = t"
      >
        {{ t === 'sync' ? 'Gitee 同步' : t === 'data' ? '数据与日志' : '关于与快捷键' }}
      </button>
    </nav>

    <template v-if="tab === 'sync'">
      <div class="callout callout--warn">
        <strong>先看清楚:</strong> 私人令牌会明文保存在这台设备的浏览器数据库(IndexedDB)里,只会被发往
        <code>gitee.com</code>。公用电脑或共享设备请不要填。建议在 Gitee
        单独建一个仓库专门放笔记,并只给令牌勾选 <code>projects</code> 权限,这样即使泄露也影响有限。
      </div>

      <div class="steps">
        <p class="steps__title">第一次使用的准备步骤</p>
        <ol>
          <li>在 Gitee 新建一个<strong>私有</strong>仓库(例如 <code>my-vault</code>),里面至少提交一个文件,否则没有分支可推。</li>
          <li>打开 <code>gitee.com/profile/personal_access_tokens</code>,生成新令牌,勾选 <code>projects</code>。</li>
          <li>把令牌、用户名(空间地址)、仓库名、分支名填到下面,点「测试连接」。</li>
          <li>连接成功后点「立即同步」把远端笔记拉到本机。</li>
        </ol>
      </div>

      <div class="grid">
        <label class="field__wrap">
          <span class="field__label">私人令牌 access token</span>
          <span class="field__row">
            <input
              v-model="draft.token"
              class="field"
              :type="showToken ? 'text' : 'password'"
              placeholder="粘贴 Gitee 私人令牌"
              autocomplete="off"
              spellcheck="false"
            />
            <button class="btn btn--ghost" type="button" @click="showToken = !showToken">
              {{ showToken ? '隐藏' : '显示' }}
            </button>
          </span>
        </label>

        <label class="field__wrap">
          <span class="field__label">空间地址 owner(用户名或组织)</span>
          <input v-model="draft.owner" class="field" placeholder="例如 zhangsan" autocomplete="off" spellcheck="false" />
        </label>

        <label class="field__wrap">
          <span class="field__label">仓库名 repo</span>
          <input v-model="draft.repo" class="field" placeholder="例如 my-vault" autocomplete="off" spellcheck="false" />
        </label>

        <label class="field__wrap">
          <span class="field__label">分支 branch</span>
          <input v-model="draft.branch" class="field" placeholder="master" autocomplete="off" spellcheck="false" />
        </label>
      </div>

      <div class="row">
        <label class="check">
          <input v-model="draft.autoSync" type="checkbox" />
          <span>编辑后自动同步</span>
        </label>
        <label class="check">
          <span class="check__label">推送延迟</span>
          <select v-model.number="draft.pushDelayMs" class="field field--select">
            <option v-for="d in DELAYS" :key="d.ms" :value="d.ms">{{ d.label }}</option>
          </select>
        </label>
      </div>
      <p class="field__tip">
        推送延迟是「停止输入多久后尝试上传」。设长一些能减少提交次数,避免把仓库塞满碎片提交。
      </p>

      <p v-if="sync.connectionInfo" class="field__tip" :class="{ 'field__error': sync.connectionInfo.startsWith('连接失败') }">
        {{ sync.connectionInfo }}
      </p>
      <p v-if="error" class="field__error">{{ error }}</p>
      <p v-if="saved" class="field__ok">已保存。</p>

      <div class="row row--end">
        <button class="btn" type="button" :disabled="!dirty" @click="save">保存</button>
        <button class="btn" type="button" @click="test">测试连接</button>
        <button
          class="btn btn--primary"
          type="button"
          :disabled="!settings.configured || sync.syncing"
          @click="sync.syncNow()"
        >
          {{ sync.syncing ? '同步中…' : '立即同步' }}
        </button>
      </div>
      <p class="field__tip">同步中会显示进度;失败时具体原因会写在「数据与日志」标签页。</p>
    </template>

    <template v-else-if="tab === 'data'">
      <dl class="info">
        <dt>笔记总数</dt>
        <dd>{{ stats.total }}</dd>
        <dt>正文已下载到本机</dt>
        <dd>{{ stats.cached }} 篇(其余为仅索引,打开时按需下载)</dd>
        <dt>待上传</dt>
        <dd>{{ stats.pending }} 篇</dd>
        <dt>本机存储占用</dt>
        <dd>{{ usage }}</dd>
        <dt>持久化存储授权</dt>
        <dd>
          <span :class="persisted ? 'field__ok' : 'field__error'">
            {{ persisted === null ? '检测中…' : persisted ? '已授权(不易被浏览器自动清理)' : '未授权' }}
          </span>
        </dd>
      </dl>

      <div class="callout">
        <strong>数据存在哪里?</strong> 正文以明文 <code>.md</code> 保存在浏览器的 OPFS
        (源私有文件系统),链接索引、标签、设置、同步日志保存在 IndexedDB。两者都只在这台设备上,不会上传到本应用之外的任何服务器。
      </div>

      <div class="row">
        <button class="btn" type="button" :disabled="reindexing" @click="reindex">
          {{ reindexing ? '重建中…' : '重建链接与标签索引' }}
        </button>
        <span v-if="reindexed !== null" class="field__tip">已重新解析 {{ reindexed }} 篇笔记。</span>
      </div>
      <p class="field__tip">
        当反链、待创建列表或标签明显不对时,可以用这个按钮从正文重新解析一遍,不会改动任何笔记内容。
      </p>

      <div class="logs">
        <div class="logs__head">
          <span>同步日志(最近 120 条)</span>
          <div class="logs__actions">
            <button class="btn btn--ghost" type="button" @click="sync.refreshLog()">刷新</button>
            <button class="btn btn--ghost" type="button" :disabled="sync.log.length === 0" @click="sync.clearLog()">
              清空
            </button>
          </div>
        </div>
        <ul v-if="sync.log.length > 0" class="logs__list">
          <li v-for="row in sync.log" :key="row.id">
            <span class="logs__level" :data-level="row.level">{{ row.level }}</span>
            <span class="logs__at">{{ new Date(row.at).toLocaleString('zh-CN', { hour12: false }) }}</span>
            <span class="logs__msg">{{ row.message }}</span>
          </li>
        </ul>
        <p v-else class="field__tip">还没有同步记录。</p>
      </div>

      <div class="danger">
        <p class="danger__title">清空本机正文并重新下载</p>
        <p class="field__tip">
          用于修复本机文件损坏,或把 Safari 清空的缓存补回来。会先删除本机所有笔记正文,再从 Gitee
          仓库完整拉取。<strong>未上传的本地修改会丢失</strong>,请先确认「待上传」为 0。
        </p>
        <button
          class="btn btn--danger"
          type="button"
          :disabled="!settings.configured || stats.pending > 0 || wipeBusy"
          @click="wipeAndReload"
        >
          {{ wipeBusy ? '处理中…' : '清空并重新下载' }}
        </button>
        <p v-if="stats.pending > 0" class="field__tip">当前有 {{ stats.pending }} 篇待上传,请先同步。</p>
      </div>
    </template>

    <template v-else>
      <p class="about">
        WebVault 是一个纯静态的单页应用:笔记是你的普通 <code>.md</code>
        文件,存在本机浏览器里,通过你自己的 Gitee 仓库在设备之间同步。没有账号系统,没有服务器,没有人能看到你的笔记。
      </p>

      <h4 class="sub">装到桌面 / 手机</h4>
      <ul class="plain">
        <li><strong>桌面 Chrome / Edge:</strong>地址栏右侧会出现安装图标,点一下即可作为独立窗口应用运行。</li>
        <li><strong>Android Chrome:</strong>菜单 →「安装应用」或「添加到主屏幕」。</li>
        <li>
          <strong>iOS Safari:</strong>分享按钮 →「添加到主屏幕」。<em>必须这样做</em>,否则 Safari
          的防跟踪策略会在约 7 天不用之后清空本机笔记缓存。装到主屏幕后仍可能被清,应用会在启动时检测并自动从 Gitee 恢复。
        </li>
      </ul>

      <h4 class="sub">快捷键</h4>
      <ul class="plain">
        <li><code>Ctrl / ⌘ + K</code> — 链接选择器,跳转或在光标处插入 <code>[[双链]]</code></li>
        <li><code>Ctrl / ⌘ + F</code> — 全库搜索</li>
        <li><code>Ctrl / ⌘ + ,</code> — 打开设置</li>
        <li><code>Ctrl / ⌘ + 单击</code> 编辑器里的 <code>[[链接]]</code> — 跳转(不存在则创建)</li>
        <li>在正文里输入 <code>[[</code> — 触发链接补全</li>
        <li><code>Esc</code> — 关闭弹窗</li>
      </ul>

      <h4 class="sub">已知限制</h4>
      <ul class="plain">
        <li>附件(图片等)只会被索引为链接,暂不支持在编辑器里预览或上传。</li>
        <li>即时渲染模式会在首次编辑时规范化部分 Markdown 语法(列表符号、空行等),这是编辑器内核的行为。</li>
        <li>与 Obsidian 桌面版可以共用同一个 git 仓库,但 iOS 版 Obsidian 没有 git 同步,无法直接互通。</li>
        <li>本地与远端同时改了同一篇笔记时:能自动合并的部分会合并,合不了的会保留本地版本,并把远端版本另存为
          <code>标题.conflict-时间戳.md</code>,两个文件都会上传。<strong>不会</strong>在正文里插入冲突标记。</li>
      </ul>
    </template>

    <template #footer>
      <span class="spacer"></span>
      <button class="btn" type="button" @click="emit('close')">关闭</button>
    </template>
  </Modal>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 4px;
  margin: -4px 0 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}

.tabs__btn {
  padding: 5px 11px;
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--text-muted);
}

.tabs__btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.tabs__btn--on {
  background: var(--accent-soft);
  color: var(--accent);
}

.callout {
  margin: 0 0 14px;
  padding: 10px 12px;
  border-radius: 8px;
  border-left: 3px solid var(--accent);
  background: var(--bg);
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--text-muted);
}

.callout strong {
  color: var(--text);
}

.callout code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

.callout--warn {
  border-left-color: var(--warn);
}

.steps {
  margin: 0 0 16px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg);
}

.steps__title {
  margin: 0 0 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.steps ol {
  margin: 0;
  padding-left: 20px;
  font-size: 12.5px;
  line-height: 1.85;
  color: var(--text-muted);
}

.steps code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}

.field__wrap {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.field__label {
  font-size: 12px;
  color: var(--text-muted);
}

.field__row {
  display: flex;
  gap: 6px;
}

.field {
  width: 100%;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  outline: none;
  font-size: 13px;
  color: var(--text);
}

.field:focus {
  border-color: var(--accent);
}

.field--select {
  width: auto;
}

.row {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.row--end {
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

.check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}

.check__label {
  font-size: 12.5px;
  color: var(--text-muted);
}

.field__tip {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
}

.field__error {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--danger);
}

.field__ok {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--ok);
}

.btn {
  padding: 6px 14px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg);
  font-size: 13px;
  color: var(--text);
}

.btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.btn--primary {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.btn--danger {
  background: rgba(243, 139, 168, 0.14);
  border-color: var(--danger);
  color: var(--danger);
}

.btn--ghost {
  flex: none;
  width: auto;
  padding: 6px 10px;
  font-size: 12.5px;
  color: var(--text-muted);
}

.info {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  margin: 0 0 14px;
  font-size: 13px;
}

.info dt {
  color: var(--text-muted);
  font-size: 12.5px;
}

.info dd {
  margin: 0;
}

.logs {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}

.logs__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.logs__actions {
  display: flex;
  gap: 6px;
}

.logs__list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  max-height: 240px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.logs__list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 9px;
  font-size: 11.5px;
  border-bottom: 1px solid var(--border);
}

.logs__list li:last-child {
  border-bottom: none;
}

.logs__level {
  flex: none;
  width: 40px;
  font-weight: 600;
  text-transform: uppercase;
}

.logs__level[data-level='error'] {
  color: var(--danger);
}

.logs__level[data-level='warn'] {
  color: var(--warn);
}

.logs__level[data-level='info'] {
  color: var(--accent);
}

.logs__at {
  flex: none;
  color: var(--text-muted);
}

.logs__msg {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}

.danger {
  margin-top: 18px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid rgba(243, 139, 168, 0.4);
  background: rgba(243, 139, 168, 0.06);
}

.danger__title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--danger);
}

.about {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.85;
  color: var(--text-muted);
}

.about code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

.sub {
  margin: 16px 0 6px;
  font-size: 13px;
  font-weight: 600;
}

.plain {
  margin: 0;
  padding-left: 20px;
  font-size: 12.5px;
  line-height: 1.9;
  color: var(--text-muted);
}

.plain code {
  padding: 0 4px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent);
}

.plain strong,
.plain em {
  color: var(--text);
}

.spacer {
  flex: 1;
}
</style>
