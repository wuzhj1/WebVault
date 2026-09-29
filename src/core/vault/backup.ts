/**
 * 导出备份：把整库正文 + 索引快照打成一个 `.zip` 交给浏览器下载。
 *
 * 为什么需要它：本项目此前**没有任何导出通道** —— 内置 OPFS 一旦被浏览器清理，
 * 或用户误触「清空本机正文」，唯一副本就只在 Gitee；没配同步的用户则直接全丢。
 * 这是评审里唯一「用户可能真的丢数据」的缺口，所以宁可先做一个只读导出，也不等导入方案。
 *
 * 三处刻意的取舍：
 * - **以磁盘为清单，不以索引为清单**：`listNotePaths()` 列出的是当下真实存在的 `.md`，
 *   索引认得而盘上没有的正文会被如实计入「未包含」而不是静默跳过 —— 备份最忌讳的是
 *   「显示成功但少了几篇」。
 * - **设置表也带上，但凭据字段一律抹空**：备份文件会被丢进下载目录、可能被贴进工单或同步盘。
 *   抹除按字段名递归匹配，逻辑在 `redact.ts`（纯模块，由 `scripts/verify-redact.mts` 钉住），
 *   只对 settings 表生效 —— 另外四张表是用户正文的派生数据，宁可不动也不能误伤。
 * - **纯只读，不提供导入**：恢复 = 把解压出的 `.md` 放回笔记目录，或连回 Gitee 仓库。
 *   导入要处理合并语义、墓碑与同步三元组的冲突，是另一个量级的问题，不在这里含糊地做半套。
 *
 * 快照目录与文件名直接取 `config-layout` 的那份映射 —— 包内 `.webvault/` 与绑定目录里的原件
 * 逐字同名同结构，可以整份 diff；`_webvault` 那种「另起一个名以免覆盖原件」的做法会让解压出来
 * 的东西既不能直接用、也不能直接比。
 *
 * 硬约束：只用相对导入。
 */
import { db } from '../db.ts'
import { CONFIG_DIR, TABLE_FILES, partitionRows } from './config-layout.ts'
import { conflictStamp } from './hash.ts'
import * as opfs from './opfs.ts'
import { redactSecrets } from './redact.ts'
import { buildZip, type ZipEntry } from './zip.ts'

const ENCODER = new TextEncoder()

/** 一次导出的结果，UI 直接照这个报数。 */
export interface BackupArchive {
  /** zip 字节。泛型收窄到 `ArrayBuffer` 是为了能直接喂给 `new Blob([...])`。 */
  bytes: Uint8Array<ArrayBuffer>
  /** 建议的文件名，形如 `webvault-backup-20260929T141500.zip`。 */
  filename: string
  /** 包内正文篇数。 */
  noteCount: number
  /** 索引里标着「已缓存」、盘上却读不到的篇数；大于 0 就是有人比对时会发现的差额。 */
  missing: number
  /** 快照各文件的总行数。 */
  rowCount: number
}

/**
 * 包内说明文案。数字全部来自本次导出的实测值，不写死 —— 免得日后改动后文案与包里的实际内容对不上。
 * `missing` 那一行按需拼接，避免在「一篇都没少」的正常备份里留一条空的列表项。
 */
function readme(a: { noteCount: number; rowCount: number; missing: number; at: string }): string {
  const missingLine =
    a.missing > 0
      ? `  - 索引标着已下载、盘上却读不到的正文 ${a.missing} 篇(导出时已如实计数,不是打包失败)。\n`
      : ''
  return `WebVault 备份
============

导出时间: ${a.at}
正文 ${a.noteCount} 篇,快照 ${a.rowCount} 行。

包含
----
  *.md            笔记正文,保持导出时的库内相对路径 —— 解压即得一份可直接打开的 Markdown 目录。
  ${CONFIG_DIR}/     导出那一刻的配置与索引快照,目录名与文件名都和库内原件一致,可逐字 diff。

不包含
------
  - Gitee token 等凭据。快照里的 sync.json 已把这些字段抹空 —— 备份文件不该替你保管密码,
    恢复时请到「设置 → Gitee 同步」重新填写。
  - 同步日志 sync-log.json(滚动窗口,无备份价值)。
${missingLine}
恢复
----
  1) 连回同一个 Gitee 仓库再同步,或
  2) 把解压出的 .md 放进笔记目录(设置 → 数据与日志 → 绑定目录)。

  链接 / 标签 / 卡片索引都能由正文重建 —— 需要时用「设置 → 数据与日志 → 重建链接与标签索引」
  从这份正文重新算一遍即可,不必依赖快照里的那几行。

注意
----
  本备份为只读,应用暂不支持从 zip 导入。
`
}

/**
 * 组装一次完整备份。不负责触发下载（那是 `downloadZip` 的事），以便调用方先拿到统计再决定提示文案。
 *
 * 顺序：先列盘上有什么 → 读正文 → 逐表读并按档分桶 → 打包。
 * 全程只读，任何一步抛错都不会动到库里的数据。
 */
export async function buildBackup(): Promise<BackupArchive> {
  const onDisk = await opfs.listNotePaths()

  const entries: ZipEntry[] = []
  // 真正进了包的正文路径 —— 「索引说有、实际没读出来」也算差额，只比对磁盘清单会漏掉这一类。
  const included = new Set<string>()
  for (const path of onDisk) {
    // 读与 stat 并发：备份是低频的用户动作，但也不该因为多一次串行往返让大库白等一轮。
    // 拿得到真实 mtime 就写进 zip，恢复出来的文件保留原来的修改时间；拿不到则回落当前时间。
    const [text, mtime] = await Promise.all([opfs.readNote(path), opfs.fileMtimeOf(path)])
    if (text === null) continue
    entries.push({ path, data: ENCODER.encode(text), mtime: mtime ?? Date.now() })
    included.add(path)
  }

  let rowCount = 0
  let noteRows: { path: string; cached: number; removedLocal: number }[] = []
  for (const [table, files] of TABLE_FILES) {
    // 滚动日志只有最近约 300 条，没有备份价值还平添噪音。
    if (table === 'syncLog') continue
    const rows: unknown[] = await db.table(table).toArray()
    rowCount += rows.length
    const groups = partitionRows(table, files, rows)
    for (const file of files) {
      const bucket = groups.get(file) ?? []
      // 抹凭据只对 settings 生效、且在分桶之后：只动字段值、不动键名，分流结果不受影响。
      const payload = table === 'settings' ? redactSecrets(bucket) : bucket
      // 与 datafiles.doFlush 同样的 `JSON.stringify(rows, null, 1)` —— 快照要能和原件逐字 diff。
      entries.push({
        path: `${CONFIG_DIR}/${file}`,
        data: ENCODER.encode(JSON.stringify(payload, null, 1)),
        mtime: Date.now(),
      })
    }
    if (table === 'notes') noteRows = rows as { path: string; cached: number; removedLocal: number }[]
  }

  // 索引说「正文在本机」而包里没有的 —— 备份最忌讳静默少几篇，这里如实计数交给 UI 报出来。
  const missing = noteRows.filter((n) => n.cached === 1 && n.removedLocal === 0 && !included.has(n.path)).length

  const noteCount = included.size
  const at = new Date().toLocaleString('zh-CN', { hour12: false })
  entries.push({
    path: `${CONFIG_DIR}/README.txt`,
    data: ENCODER.encode(readme({ noteCount, rowCount, missing, at })),
    mtime: Date.now(),
  })

  const bytes = await buildZip(entries)
  return {
    bytes,
    filename: `webvault-backup-${conflictStamp(new Date())}.zip`,
    noteCount,
    missing,
    rowCount,
  }
}

/**
 * 把字节交给浏览器下载。
 *
 * `revokeObjectURL` 必须延后：`<a download>` 触发的下载是异步取走 blob 的，
 * 点完立刻撤销会拿到 0 字节的文件（这是最常见的"打包成功但下载出来是空的"）。30 秒足够
 * 任何规模的下载启动，而对象 URL 不撤销会一直占着内存，直到页面卸载。
 */
export function downloadZip(bytes: Uint8Array<ArrayBuffer>, filename: string): void {
  const blob = new Blob([bytes], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
