import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // All /api/* calls proxy to the Node dashboard server
      '/api': {
        target: 'http://127.0.0.1:4319',
        changeOrigin: true,
      },
      '/events': {
        target: 'http://127.0.0.1:4319',
        changeOrigin: true,
      },
      '/favicon.png': {
        target: 'http://127.0.0.1:4319',
        changeOrigin: true,
      },
    },
  },
});
