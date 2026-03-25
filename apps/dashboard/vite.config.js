import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig } from 'vite';

function walkFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkFiles(fullPath, acc);
    } else if (stat.isFile()) {
      acc.push(fullPath);
    }
  }
  return acc;
}

function copyPublicFilesPlugin() {
  const rootDir = resolve(__dirname);
  const publicDir = resolve(rootDir, 'public');
  const outDir = resolve(rootDir, 'dist');
  return {
    name: 'copy-dashboard-public-files',
    closeBundle() {
      for (const sourcePath of walkFiles(publicDir)) {
        const relPath = relative(publicDir, sourcePath);
        const targetPath = resolve(outDir, relPath);
        mkdirSync(resolve(targetPath, '..'), { recursive: true });
        writeFileSync(targetPath, readFileSync(sourcePath));
      }
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: false,
        dead_code: true,
      },
    },
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Split large tab modules into separate chunks
          if (id.includes('src/tabs/')) {
            const match = id.match(/tabs\/([^/]+)\.js/);
            if (match) return `tab-${match[1]}`;
          }
          // Split chat modules
          if (id.includes('src/chat/')) {
            return 'chat-core';
          }
          // Split components
          if (id.includes('src/components/')) {
            return 'components';
          }
          // Split core utilities
          if (id.includes('src/core/')) {
            return 'core-utils';
          }
          // Setup wizard separate chunk
          if (id.includes('setup-wizard')) {
            return 'setup-wizard';
          }
          // Orchestration and CLI process
          if (id.includes('orchestration-status')) {
            return 'orchestration';
          }
          if (id.includes('cli-process')) {
            return 'cli-process';
          }
        },
      },
    },
  },
  plugins: [copyPublicFilesPlugin()],
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
