/**
 * 配置目录形状验证（src/core/vault/config-layout.ts）：
 * - 目录与文件清单：`.webvault` 是唯一配置目录、旧版 `.config` 只作搬迁源，六张表的文件名不重不漏；
 * - 键名 → 文件的分流：settings 按职责拆成 sync / app / hotkeys / workspace 四档，
 *   每个已登记键落到预期的那档、未知键一律回落 app.json（新设置忘了登记只会落错档，绝不会丢）；
 * - 分流的硬不变量：`partitionRows` 必须让每一行都有桶 —— 漏一行等于悄悄丢设置，
 *   datafiles 的 doFlush 正是靠 `placed === rows.length` 在写盘前拦这一条；
 * - 旧版搬迁：`settings.json` 拆成四档后，四档的并集必须与原表逐行相同（不多不少、不改键名）。
 *
 * 运行：pnpm verify（第 15 个套件；裸 node 直跑本文件）。全部通过退出码 0，否则 1。
 */
import {
  CONFIG_DIR,
  LEGACY_CONFIG_DIR,
  LEGACY_SETTINGS_FILE,
  SETTING_KEYS,
  TABLE_FILES,
  fileOfRow,
  filesOf,
  parseRows,
  partitionRows,
  settingsFileOf,
} from '../src/core/vault/config-layout.ts'

let pass = 0
let fail = 0

/** 用 JSON 序列化后比较，失败时打印 expected/actual 差异。 */
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else {
    fail++
    console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`)
  }
}

function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else {
    fail++
    console.log(`FAIL ${name}${detail ? `\n  ${detail}` : ''}`)
  }
}

/** 确定性伪随机（mulberry32），免得 fuzz 断言今天过明天挂、还查不出是哪一版输入。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- 1. 目录形状：一个配置目录，旧的只作搬迁源 ----
check('CONFIG_DIR is .webvault', CONFIG_DIR, '.webvault')
check('legacy CONFIG_DIR is .config', LEGACY_CONFIG_DIR, '.config')
check('legacy settings file name', LEGACY_SETTINGS_FILE, 'settings.json')
ok('config dir is a dot-dir (OS hides it by default)', CONFIG_DIR.startsWith('.'))
ok('config dir is not the generic .config', CONFIG_DIR !== LEGACY_CONFIG_DIR)
ok('legacy dir is not nested inside the new one', !CONFIG_DIR.includes(LEGACY_CONFIG_DIR))
ok('config dir carries the app name', CONFIG_DIR.includes('vault'))
ok('config dir has no path separator (must be top-level)', !CONFIG_DIR.includes('/'))

// ---- 2. 表 → 文件清单：六张表、文件名不重不漏 ----
check('six tables registered', TABLE_FILES.length, 6)
check(
  'table names',
  TABLE_FILES.map(([table]) => table),
  ['notes', 'links', 'tags', 'cards', 'settings', 'syncLog'],
)

const allFiles: string[] = []
for (const [table, files] of TABLE_FILES) {
  ok(`${table} has at least one file`, files.length > 0)
  for (const file of files) {
    allFiles.push(file)
    ok(`${table}/${file} is .json`, file.endsWith('.json'))
    ok(`${table}/${file} is flat (no slash)`, !file.includes('/'))
    ok(`${table}/${file} is not empty`, file.length > 0)
  }
}
check('file names are globally unique across tables', new Set(allFiles).size, allFiles.length)
check('nine config files in total', allFiles.length, 9)

check('notes is single-file', filesOf('notes'), ['notes.json'])
check('links is single-file', filesOf('links'), ['links.json'])
check('tags is single-file', filesOf('tags'), ['tags.json'])
check('cards is single-file', filesOf('cards'), ['cards.json'])
check('syncLog is single-file', filesOf('syncLog'), ['sync-log.json'])
check(
  'settings splits into four duty files',
  filesOf('settings'),
  ['sync.json', 'app.json', 'hotkeys.json', 'workspace.json'],
)
check('unknown table resolves to no file', filesOf('nope'), [])
check('config table is not persisted to files (handle cannot be serialized)', filesOf('config'), [])

// ---- 3. settings 键名注册表：唯一、非空、值固定 ----
const keyEntries = Object.entries(SETTING_KEYS)
check('six settings keys declared', keyEntries.length, 6)
check('keys are unique', new Set(keyEntries.map(([, value]) => value)).size, keyEntries.length)
for (const [name, value] of keyEntries) {
  ok(`SETTING_KEYS.${name} is a non-empty string`, typeof value === 'string' && value.length > 0)
}
check('sync key', SETTING_KEYS.syncSettings, 'sync-settings')
check('last-open-path key', SETTING_KEYS.lastOpenPath, 'last-open-path')
check('recent key', SETTING_KEYS.recentPaths, 'ui-recent-paths')
check('pinned key', SETTING_KEYS.pinnedPaths, 'ui-pinned-paths')
check('collapsed key', SETTING_KEYS.collapsedDirs, 'ui-collapsed-dirs')
check('shortcut key', SETTING_KEYS.shortcutBindings, 'ui-shortcut-bindings')

// ---- 4. 键 → 档的分流 ----
const settingsFiles = filesOf('settings')
check('sync settings go to sync.json', settingsFileOf(SETTING_KEYS.syncSettings), 'sync.json')
check('shortcut bindings go to hotkeys.json', settingsFileOf(SETTING_KEYS.shortcutBindings), 'hotkeys.json')
check('last-open-path goes to workspace.json', settingsFileOf(SETTING_KEYS.lastOpenPath), 'workspace.json')
check('recent goes to workspace.json', settingsFileOf(SETTING_KEYS.recentPaths), 'workspace.json')
check('pinned goes to workspace.json', settingsFileOf(SETTING_KEYS.pinnedPaths), 'workspace.json')
check('collapsed goes to workspace.json', settingsFileOf(SETTING_KEYS.collapsedDirs), 'workspace.json')
check('unknown key falls back to app.json', settingsFileOf('brand-new-setting'), 'app.json')
check('empty key falls back to app.json', settingsFileOf(''), 'app.json')
check('case matters (no case folding)', settingsFileOf('SYNC-SETTINGS'), 'app.json')

// 每个已登记键都必须落进 settings 的文件清单 —— 落到清单外等于那行永远写不出去。
for (const [name, value] of keyEntries) {
  ok(
    `SETTING_KEYS.${name} → ${settingsFileOf(value)} is one of the settings files`,
    settingsFiles.includes(settingsFileOf(value)),
    `got ${settingsFileOf(value)}, files = ${settingsFiles.join(',')}`,
  )
}

// ---- 5. fileOfRow：一表一档 vs 一表多档 ----
check('non-settings rows go to the only file', fileOfRow('notes', filesOf('notes'), { path: 'a.md' }), 'notes.json')
check('unknown table with no files resolves empty', fileOfRow('whatever', [], {}), '')
check(
  'settings row routes by key',
  fileOfRow('settings', settingsFiles, { key: SETTING_KEYS.syncSettings, value: '{}' }),
  'sync.json',
)
check('settings row without key falls back', fileOfRow('settings', settingsFiles, { value: '{}' }), 'app.json')
check('settings row with non-string key falls back', fileOfRow('settings', settingsFiles, { key: 42 }), 'app.json')
check('settings row with null row falls back', fileOfRow('settings', settingsFiles, null), 'app.json')

// ---- 6. partitionRows：不变量「每一行都有桶」----
const realisticSettings = [
  { key: SETTING_KEYS.syncSettings, value: '{"token":"x"}' },
  { key: SETTING_KEYS.lastOpenPath, value: '"notes/a.md"' },
  { key: SETTING_KEYS.recentPaths, value: '["a.md"]' },
  { key: SETTING_KEYS.pinnedPaths, value: '[]' },
  { key: SETTING_KEYS.collapsedDirs, value: '[]' },
  { key: SETTING_KEYS.shortcutBindings, value: '{"search":"mod+f"}' },
  { key: 'ui-something-new', value: 'true' },
]
const buckets = partitionRows('settings', settingsFiles, realisticSettings)
check('bucket names exactly the settings files', [...buckets.keys()], settingsFiles)
for (const [, rows] of buckets) ok('bucket is an array', Array.isArray(rows))
const placed = [...buckets.values()].reduce((n, rows) => n + rows.length, 0)
check('every settings row has a bucket', placed, realisticSettings.length)
check('sync.json only holds the sync key', buckets.get('sync.json'), [realisticSettings[0]])
check('hotkeys.json only holds bindings', buckets.get('hotkeys.json'), [realisticSettings[5]])
check(
  'workspace.json holds the four workspace keys in order',
  buckets.get('workspace.json'),
  [realisticSettings[1], realisticSettings[2], realisticSettings[3], realisticSettings[4]],
)
check('app.json holds the unknown key', buckets.get('app.json'), [realisticSettings[6]])

// 空表也要建齐四个桶：flush 照桶写，缺桶就是「删了这个文件却以为写过了」。
const emptyBuckets = partitionRows('settings', settingsFiles, [])
check('empty table still gets all buckets', [...emptyBuckets.keys()], settingsFiles)
for (const [, rows] of emptyBuckets) check('empty bucket is empty', rows, [])

// 一表一档的表：整表进唯一的桶，顺序原样保留。
const noteRows = [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }]
const noteBuckets = partitionRows('notes', filesOf('notes'), noteRows)
check('notes rows all land in notes.json', noteBuckets.get('notes.json'), noteRows)
check('notes has exactly one bucket', noteBuckets.size, 1)

// fuzz：任意键名、任意行数都不能漏行、也不能产生清单外的桶。
const rand = mulberry32(20260929)
const fragments = ['ui-', 'sync-', 'app-', 'x', 'y', '', 'panel', 'graph', '42', '中文', '-']
for (let round = 0; round < 40; round++) {
  const n = Math.floor(rand() * 60)
  const rows: { key: string; value: string }[] = []
  for (let i = 0; i < n; i++) {
    const key = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => fragments[Math.floor(rand() * fragments.length)]).join('')
    rows.push({ key, value: String(i) })
  }
  const grouped = partitionRows('settings', settingsFiles, rows)
  const total = [...grouped.values()].reduce((acc, r) => acc + r.length, 0)
  if (total !== n) {
    fail++
    console.log(`FAIL fuzz round ${round}: ${n} rows became ${total}`)
  } else pass++
  const stray = [...grouped.keys()].filter((f) => !settingsFiles.includes(f))
  if (stray.length > 0) {
    fail++
    console.log(`FAIL fuzz round ${round}: stray buckets ${stray.join(',')}`)
  } else pass++
  // 桶内顺序 = 原表顺序（分桶不重排），拼回去应是原表的一个稳定划分。
  const rebuilt: typeof rows = []
  for (const f of settingsFiles) rebuilt.push(...(grouped.get(f) ?? []))
  const sameSize = rebuilt.length === rows.length
  const sameKeys = [...rebuilt].map((r) => r.key).sort().join('|') === rows.map((r) => r.key).sort().join('|')
  if (sameSize && sameKeys) pass++
  else {
    fail++
    console.log(`FAIL fuzz round ${round}: rebuilt differs (size ${sameSize}, keys ${sameKeys})`)
  }
}

// ---- 7. 旧版搬迁：settings.json 拆四档后并集必须逐行相同 ----
{
  const legacyText = JSON.stringify(realisticSettings, null, 1)
  const parsed = parseRows(legacyText)
  ok('legacy settings.json parses to an array', Array.isArray(parsed))
  const grouped = partitionRows('settings', settingsFiles, parsed ?? [])
  const union: unknown[] = []
  for (const file of settingsFiles) union.push(...(grouped.get(file) ?? []))
  // 按桶序拼回，行序必然与原表不同（分组本就不保跨档顺序）——
  // 真正的不变量是「同一组行、不多不少、一字不改」，所以比排序后的逐行序列化。
  check(
    'split union is exactly the legacy rows (no loss, no duplication, no mutation)',
    union.map((row) => JSON.stringify(row)).sort(),
    realisticSettings.map((row) => JSON.stringify(row)).sort(),
  )
  for (const file of settingsFiles) {
    const body = JSON.stringify(grouped.get(file) ?? [], null, 1)
    const back = parseRows(body)
    ok(`${file} round-trips through JSON.stringify(rows, null, 1)`, back !== null && back.length === (grouped.get(file) ?? []).length)
  }
  // 拆完之后，任何一档都不该出现「归别的档」的键 —— 否则搬迁等于把设置写串了。
  for (const file of settingsFiles) {
    const wrong = (grouped.get(file) ?? []).filter(
      (row) => settingsFileOf(String((row as { key?: unknown }).key)) !== file,
    )
    check(`no cross-file key leaks into ${file}`, wrong, [])
  }
}

// ---- 8. parseRows：不是行数组就按损坏处理 ----
check('valid array parses', parseRows('[{"a":1}]'), [{ a: 1 }])
check('empty array parses', parseRows('[]'), [])
check('nested arrays are fine', parseRows('[[1],[2]]'), [[1], [2]])
check('invalid JSON → null', parseRows('{oops'), null)
check('object is not rows → null', parseRows('{"a":1}'), null)
check('string is not rows → null', parseRows('"hi"'), null)
check('number is not rows → null', parseRows('42'), null)
check('null is not rows → null', parseRows('null'), null)
check('boolean is not rows → null', parseRows('true'), null)

console.log(`${fail === 0 ? 'OK  ' : 'FAIL'} verify-config-layout: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
