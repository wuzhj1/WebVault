import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(({ mode }) => {
  // Sub-path hosts (Gitee Pages: https://user.gitee.io/repo/) need VAULT_BASE=/repo/.
  // Put it in .env.local rather than on the command line: Git Bash rewrites a
  // leading-slash argument into a Windows path before Vite ever sees it.
  const env = loadEnv(mode, process.cwd(), ['VAULT_', 'VITE_'])
  const rawBase = env.VAULT_BASE || process.env.VAULT_BASE || '/'
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`

  return {
    base,
    plugins: [
      vue(),
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
          globIgnores: ['vditor/**'],
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
