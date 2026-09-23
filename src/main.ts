/**
 * 应用入口：装 Pinia、挂根组件。只做两件事，任何额外初始化都应放到各自的 store 里。
 *
 * 硬约束：只用相对导入（本文件是打包入口，不走 `@/` 别名解析链）；必须在 `mount` 之前完成外观落色，
 * 否则首帧会闪一下默认主题。
 */
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { applyAppearance, readStoredAppearance } from './core/theme/apply.ts'
import './styles/main.css'

// index.html 里的内联脚本已经按存储值写了 data-theme,这里再走一遍是为了校验(不认识的
// 主题回退默认)并把 theme-color meta 同步成主题底色。必须在 mount 之前,首帧才是对的。
applyAppearance(readStoredAppearance())

createApp(App).use(createPinia()).mount('#app')
