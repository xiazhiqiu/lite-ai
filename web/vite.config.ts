import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * 值班台前端构建配置。
 *
 * **产物落在 `dist/web`** —— 由 `src/server/http.ts` 同源托管（见 `static.ts`）。
 * 前端**不独立部署**：免 CORS、API 不跨源暴露，`fetch('/chat')` 与页面同源，
 * 也正是 T6 鉴权头能天然透传的前提。
 *
 * ⚠️ **`root` 必须显式指定为 `web/`**：`--config web/vite.config.ts` 只告诉 Vite
 * 去哪读配置，**不会**把 `root` 设成配置所在目录（Vite 的 `root` 默认是
 * `process.cwd()`）。不设就会报 `Could not resolve entry module "index.html"`
 * —— 因为它在仓库根找不到 index.html（那个在 `web/` 下）。
 *
 * dev 期的 `/chat` `/jobs` 等代理指向本地服务端（默认 4100）；生产不需要，
 * 因为同源。
 */
const webRoot = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  build: {
    // 相对 web/ 的 dist/web —— 服务端静态托管的固定约定
    outDir: path.resolve(webRoot, '..', 'dist', 'web'),
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    port: 5174,
    proxy: {
      // 仅 dev 用：把 API 与 SSE 转给本地服务端
      '/chat': { target: 'http://127.0.0.1:4100', changeOrigin: false },
      '/jobs': { target: 'http://127.0.0.1:4100', changeOrigin: false },
      '/usage': { target: 'http://127.0.0.1:4100', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:4100', changeOrigin: false },
    },
  },
})

