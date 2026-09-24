/**
 * 把 `node_modules/vditor/dist` 拷进 `public/vditor/dist`。
 *
 * Vditor 运行时按 `cdn`（应用 BASE_URL + `/vditor`）自己拉取高亮样式、语言包、lute、
 * 公式/图表引擎等静态资源，这些文件必须作为站点资产一起发布。它们不进版本库
 * （随依赖升级、纯派生物），由本脚本在 dev / build 前生成；`verify-theme` 也依赖它先跑过一次。
 *
 * 剔除 `ts/`、`types/`、`*.d.ts` 与 `index/method` 主入口 js：那是给打包链和类型系统看的
 * 产物，浏览器从不按 cdn 路径请求它们。其余（含 mathjax/mermaid 等重型引擎）原样保留，
 * 供运行时按需加载；体积问题交给 PWA 侧解决——它们不进 precache，首次用到才入缓存。
 *
 * 幂等：先删后拷，重复执行结果一致。找不到 vditor 依赖时直接失败——没装依赖的环境
 * 本来也跑不起来 dev/build。
 */
import { existsSync } from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, '..', 'node_modules', 'vditor', 'dist')
const dest = path.join(here, '..', 'public', 'vditor', 'dist')

/** 运行时永远不会请求的打包产物（按一级条目名跳过）。 */
const SKIP = new Set([
  'ts',
  'types',
  'index.d.ts',
  'method.d.ts',
  'index.js',
  'index.min.js',
  'method.js',
  'method.min.js',
])

if (!existsSync(src)) {
  console.error('copy-vditor: 找不到 node_modules/vditor/dist,请先安装依赖')
  process.exit(1)
}

await rm(dest, { recursive: true, force: true })
await cp(src, dest, { recursive: true, filter: (from) => !SKIP.has(path.basename(String(from))) })
console.log(`copy-vditor: ${path.relative(process.cwd(), dest)} 就绪`)
