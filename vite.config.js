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
    // 分包后 three 单独成 chunk，仍会超 500KB 默认警告线；
    // 保留一个略高于 three 体积的阈值，让"真有异常增大"能被警告出来。
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        /**
         * 手动分包。动机：three.js 原始体积约 1.2MB，此前全打进单个
         * index-*.js（约 1.0MB / gzip 308KB），导致每次改业务代码用户都要
         * 重新下载整个包。拆开后 three 与字体可被浏览器长期缓存，
         * 业务迭代只需重下几十 KB。
         *
         * 分chunk 原则：**按变更频率分层**。越稳定的放越独立的 chunk。
         *   - three     ：几乎不变，独立 chunk，缓存命中率最高
         *   - fonts     ：发布时才变，独立 chunk
         *   - vendor    ：其余 node_modules 依赖（pg / https-proxy-agent）
         *   - 业务代码   ：留在入口 chunk，随每次发布更新
         *
         * ⚠️ 不要拆得太碎：chunk 数量过多会让 HTTP/1.1 下的请求数成为
         * 新瓶颈（本项目是单端口 Node 服务，未开 CDN 多路复用）。
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // three 及官方插件（examples/jsm 里的控件、加载器）
          if (id.includes('node_modules/three')) return 'three';
          // 字体包：只在发布时变，与 three 同等稳定
          if (id.includes('@fontsource')) return 'fonts';
          // 其余第三方依赖
          return 'vendor';
        },
      },
    },
  },
  // GLB 是静态资源，直接走 public / 代理，不做打包处理
  assetsInclude: ['**/*.glb', '**/*.gltf'],
});
