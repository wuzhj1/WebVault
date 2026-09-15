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
          // The editor's markdown engine and theme assets must be available offline, so they
          // ride in the precache alongside the app shell.
          globPatterns: ['**/*.{js,css,html,svg,png,gif}'],
          navigateFallback: `${base}index.html`,
          maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
          runtimeCaching: [
            {
              // Sync correctness depends on fresh sha comparisons: never serve the Gitee API
              // from cache.
              urlPattern: ({ url }) => url.hostname === 'gitee.com',
              handler: 'NetworkOnly',
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
