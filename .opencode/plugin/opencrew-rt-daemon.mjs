#!/usr/bin/env node
// Try compiled JS first, fall back to TypeScript via bun
let mod;
try {
  mod = await import("./dist/opencrew-rt.js");
} catch {
  // dist not built - use bun to run TypeScript directly
  const { execSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const tsFile = path.join(__dirname, "..", "plugin-test", "opencrew-rt.ts");
  // Re-exec under bun
  console.log("[opencrew-rt-daemon] dist not found, building with bun...");
  try {
    execSync(`bun build "${tsFile}" --outdir "${path.join(__dirname, "dist")}" --target node`, { stdio: "inherit" });
    mod = await import("./dist/opencrew-rt.js");
  } catch (buildErr) {
    console.error("[opencrew-rt-daemon] Failed to build:", buildErr.message);
    process.exit(1);
  }
}
const { runtimeStatus, startServer } = mod;

const host = process.env.OPENCREW_RT_HOST || "127.0.0.1"
const port = Number(process.env.OPENCREW_RT_PORT || "18889")
const secure = (process.env.OPENCREW_RT_SECURE || "0") === "1"
const requireToken = (process.env.OPENCREW_RT_REQUIRE_TOKEN || "1") !== "0"
const token = process.env.OPENCREW_RT_AUTH_TOKEN || ""
const tlsKeyPath = process.env.OPENCREW_RT_TLS_KEY_PATH
const tlsCertPath = process.env.OPENCREW_RT_TLS_CERT_PATH

if (requireToken && !token) {
  console.error("OPENCREW_RT_AUTH_TOKEN is required when OPENCREW_RT_REQUIRE_TOKEN=1")
  process.exit(1)
}

const status = runtimeStatus()
if (status.running) {
  console.log(`OpenCrew RT already running on ${status.config?.secure ? "wss" : "ws"}://${status.config?.host}:${status.config?.port}`)
} else {
  await startServer({
    host,
    port,
    secure,
    requireToken,
    token,
    tlsKeyPath,
    tlsCertPath,
  })
  console.log(`OpenCrew RT started on ${secure ? "wss" : "ws"}://${host}:${port}`)
}

const keepAlive = setInterval(() => {
  const s = runtimeStatus()
  console.log(`[opencrew-rt-daemon] running=${s.running} clients=${s.clients}`)
}, 60000)

function shutdown() {
  clearInterval(keepAlive)
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
