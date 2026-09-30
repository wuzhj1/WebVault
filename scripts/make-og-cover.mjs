/**
 * 生成链接分享卡 public/og-cover.png（固定 1200×630）。
 *
 * 做法是让本机浏览器对 scripts/og-cover.html 截一张窗口尺寸的图，而不是自己排版：
 * 文案里全是中文，而仓库不引任何字体/图像依赖（见 make-icons.mjs 的自制光栅化器，
 * 它只会画图元），中文字形只能借系统字体渲染。
 *
 * 因此这个脚本**不挂在 pnpm build 上** —— CI 的字体环境和本地不同，跑出来的图会漂。
 * og-cover.png 本身是提交进版本库的，构建时原样拷贝；只有改了 og-cover.html 才需要
 * 在本机重新跑一次：node scripts/make-og-cover.mjs（或 pnpm og）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = resolve(join(ROOT, 'scripts', 'og-cover.html'))
const OUT = resolve(join(ROOT, 'public', 'og-cover.png'))

/** 常见安装位置；CHROME_PATH 允许在非标准路径下覆盖。 */
const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

const browser = BROWSERS.find((p) => existsSync(p))
if (!browser) {
  console.error('找不到 Chrome / Edge。设置 CHROME_PATH 环境变量后重试。')
  process.exit(1)
}

// --user-data-dir 用一次性临时目录：本机默认 profile 可能正被开着的浏览器锁住，
// 而且截图不该把开发用的扩展、书签栏一起拍进去。
const profile = mkdtempSync(join(tmpdir(), 'og-cover-'))
try {
  const result = spawnSync(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      '--window-size=1200,630',
      `--user-data-dir=${profile}`,
      `--screenshot=${OUT}`,
      `file://${SOURCE.replace(/\\/g, '/')}`,
    ],
    { stdio: 'ignore', windowsHide: true },
  )

  if (result.status !== 0 || !existsSync(OUT)) {
    console.error(`截图失败（exit=${result.status}）。可手动打开 ${SOURCE} 后按 1200×630 截图。`)
    process.exit(1)
  }

  // 从 IHDR 读实际尺寸：--window-size 在 HiDPI 或缩放不为 100% 的机器上可能不给到 1200×630，
  // 这里当场校验，不等平台在审核 og:image 时才报「尺寸不符」。
  const png = readFileSync(OUT)
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (width !== 1200 || height !== 630) {
    console.error(`尺寸不对：实际 ${width}×${height}，期望 1200×630。`)
    console.error('多半是系统缩放不是 100%，把系统缩放调回 100% 再跑一次。')
    process.exit(1)
  }

  console.log(`wrote public/og-cover.png (1200x630, ${png.length} bytes)`)
} finally {
  rmSync(profile, { recursive: true, force: true })
}

