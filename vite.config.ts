import { defineConfig, loadEnv } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiBase = env.VITE_API_BASE_URL || 'https://andersan.net:8089'

  return {
    plugins: [svelte()],
    build: {
      // 本番ビルドの出力先:
      // - ローカル: ../airpollutionwatch-api/dashboard/dist
      // - API リポジトリ側の FastAPI がこのディレクトリをそのまま配信する
      outDir: '../airpollutionwatch-api/dashboard/dist',
      // outDir がプロジェクト外のため既定では空にされない。古いハッシュ付き JS が残ると
      // index.html 更新とブラウザキャッシュの取り違えが起きやすいので明示的に空にする。
      emptyOutDir: true,
    },
    server: {
      proxy: {
        // 開発時: /api へのリクエストを API に転送（CORS を回避）
        '/api': {
          target: apiBase,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  }
})
