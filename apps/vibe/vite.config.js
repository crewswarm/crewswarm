import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3333,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
  },
  optimizeDeps: {
    include: ["monaco-editor"],
  },
  worker: {
    format: "es",
  },
});
