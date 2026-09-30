/**
 * Service Worker 注册：只负责「去发现新版本」，发现之后要不要立刻换版本由调用方裁决。
 *
 * 为什么必须引入 `virtual:pwa-register`：vite-plugin-pwa 的 `injectRegister: 'auto'`
 * 默认只生成一段裸注册脚本 registerSW.js（内容就是一句 `navigator.serviceWorker.register`），
 * 它对 SW 生命周期一无所知。新版 SW 装好、skipWaiting + clientsClaim 接管之后，**页面跑的
 * 仍然是旧 JS**，永远不会自己刷新。vite-plugin-pwa 官方文档原话：
 *
 *   if you're not using any virtual, there is no way to interact with the application ui,
 *   and so, any client tab/window will not be reloaded
 *
 * 代价就是「装成本地应用的用户永远停在旧版本上」——应用窗口不重开就永远看不到新功能。
 *
 * 引入这个虚拟模块后插件会把 `useImportRegister` 置位、`injectRegister` 变成 false，
 * registerSW.js 不再注入，两条注册路径不会重复。
 *
 * 这里刻意只透传 `onNeedReload`：`autoUpdate` 模式下插件的默认行为是在新 SW 接管时无条件
 * `window.location.reload()`，而正文还在防抖窗口里时刷新会丢掉最后几个字。要不要刷、什么时候
 * 刷，必须由持有 `saveState` 的一方决定（见 App.vue）。core 层不 import 任何 store（会成环），
 * 所以状态判断只能回调注入。
 *
 * dev 模式下插件给的 `registerSW` 是空实现，本文件在开发环境不产生任何副作用。
 */
import { registerSW } from 'virtual:pwa-register'

/** 注册 Service Worker；不支持 SW 的环境（以及 dev）静默 no-op。 */
export function registerAppSW(onNeedReload: () => void): void {
  if (!('serviceWorker' in navigator)) return
  registerSW({ onNeedReload })
}
