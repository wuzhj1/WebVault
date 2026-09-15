import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { applyAppearance, readStoredAppearance } from './core/theme/apply.ts'
import './styles/main.css'

// index.html 里的内联脚本已经按存储值写了 data-theme,这里再走一遍是为了校验(不认识的
// 主题回退默认)并把 theme-color meta 同步成主题底色。必须在 mount 之前,首帧才是对的。
applyAppearance(readStoredAppearance())

createApp(App).use(createPinia()).mount('#app')
