import { defineConfig } from 'vite';

/**
 * Vite 配置
 * - /api 全部代理到本地 Node 服务（8787），SSE 流式进度可正常穿透
 * - 需要代理是因为：混元 3D 的签名密钥不能放浏览器，且云端接口不允许跨域
 */
export default defineConfig({
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: false,
      },
    },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 3000,
  },
  // GLB 是静态资源，直接走 public / 代理，不做打包处理
  assetsInclude: ['**/*.glb', '**/*.gltf'],
});
