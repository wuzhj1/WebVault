/**
 * `*.vue` 单文件组件的模块声明：让 TypeScript 把 `.vue` 导入当作组件类型，
 * 否则 `import App from './App.vue'` 无法通过类型检查（Vite 打包本身不关心这件事）。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // props/数据/额外选项都不做约束，具体类型由各组件内部自行收敛。
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
