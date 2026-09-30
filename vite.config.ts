import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * SEO 打点。
 *
 * canonical / og:url / og:image / robots.txt / sitemap.xml 全都要**绝对地址**，而绝对地址 =
 * 部署域名 + `base` 子路径。域名既推不出来也不在 base 里，所以单独给一个 `VAULT_ORIGIN`；
 * `base` 那一半则由本插件从配置里现取 —— 放进 `public/` 的静态文件拿不到它，
 * 在 Gitee Pages 这种子路径部署下会写成 `https://xxx/repo/` 以外的错误地址。
 *
 * 占位符用 `__SITE_URL__` 而不是 `%SITE_URL%`：Vite 自己有一套 `%NAME%` 的 HTML 环境变量
 * 替换（`%BASE_URL%` 就是走它），换个前缀能彻底避开那条正则，不用关心钩子执行顺序。
 */
function seo(siteUrl: string): Plugin {
  const sitemap =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `  <url><loc>${siteUrl}</loc></url>\n` +
    '</urlset>\n'

  // 注意：爬虫只从「域名根」读 robots.txt。托管在 GitHub Pages 项目页这类子路径时，
  // 本文件落在 https://wuzhj1.github.io/WebVault/robots.txt，爬虫根本不会去读，
  // 真正生效的是 https://wuzhj1.github.io/robots.txt（归用户站点仓库管，这里无权改）。
  // 保留它是为了换成自定义域名或根路径部署时开箱即用 —— 那两种情况它是唯一权威。
  const robots =
    '# WebVault\n' +
    'User-agent: *\n' +
    'Allow: /\n' +
    '\n' +
    `Sitemap: ${siteUrl}sitemap.xml\n`

  return {
    name: 'webvault:seo',
    transformIndexHtml(html) {
      return html.replace(/__SITE_URL__/g, siteUrl)
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robots })
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Sub-path hosts (Gitee Pages: https://user.gitee.io/repo/) need VAULT_BASE=/repo/.
  // Put it in .env.local rather than on the command line: Git Bash rewrites a
  // leading-slash argument into a Windows path before Vite ever sees it.
  const env = loadEnv(mode, process.cwd(), ['VAULT_', 'VITE_'])
  const rawBase = env.VAULT_BASE || process.env.VAULT_BASE || '/'
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`

  // 域名单独配置；默认值就是当前线上站点（GitHub Pages）。
  const rawOrigin = env.VAULT_ORIGIN || process.env.VAULT_ORIGIN || 'https://wuzhj1.github.io'
  const siteUrl = `${rawOrigin.replace(/\/+$/, '')}${base}`

  return {
    base,
    plugins: [
      vue(),
      seo(siteUrl),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: 'WebVault 笔记',
          short_name: 'WebVault',
          description: '本地优先的 Markdown 双链笔记,正文存在本机,通过你自己的 Gitee 仓库同步。',
          lang: 'zh-CN',
          theme_color: '#15161b',
          background_color: '#15161b',
          display: 'standalone',
          orientation: 'any',
          start_url: base,
          scope: base,
          icons: [
            { src: 'pwa/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
            {
              src: 'pwa/maskable-icon-192x192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'maskable',
            },
            {
              src: 'pwa/maskable-icon-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          // 应用外壳与主题/图标进 precache，装完即离线。
          // vditor 的运行期资源（lute、公式、mermaid 等，全量 20MB+）**不进** precache：
          // globIgnores 排除掉，安装包保持在几百 KB；首次打开编辑器时由下面的 CacheFirst
          // 规则逐文件按需入缓存，之后同样离线可用——路径稳定且随 vditor 包版本变化，
          // CacheFirst 对它是安全的。
          globPatterns: ['**/*.{js,css,html,svg,png,gif}'],
          // og-cover.png 是给爬虫和分享卡片读的，应用自己永不加载，
          // 让每个安装包多背 58KB 没有意义。
          globIgnores: ['vditor/**', 'og-cover.png'],
          navigateFallback: `${base}index.html`,
          maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
          runtimeCaching: [
            {
              // Sync correctness depends on fresh sha comparisons: never serve the Gitee API
              // from cache.
              urlPattern: ({ url }) => url.hostname === 'gitee.com',
              handler: 'NetworkOnly',
            },
            {
              // 任意 base 下的 vditor 资源（/vditor/ 或 /my-vault/vditor/）都走这里；
              // 条目上限防止长期累积，一年过期兜底 vditor 升级后的旧文件。
              urlPattern: ({ url }) => url.pathname.includes('/vditor/'),
              handler: 'CacheFirst',
              options: {
                cacheName: 'vditor-assets',
                cacheableResponse: { statuses: [0, 200] },
                expiration: { maxEntries: 700, maxAgeSeconds: 60 * 60 * 24 * 365 },
              },
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      host: true,
      port: 5173,
    },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 4096,
    },
  }
})
