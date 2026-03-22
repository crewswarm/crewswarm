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
