/**
 * Static file serving — MIME types, serveStatic helper, fallback HTML.
 * Extracted from dashboard.mjs to reduce file size.
 */

import fs from "node:fs";
import path from "node:path";

// ── MIME type map ────────────────────────────────────────────────────────────

export const STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".json": "application/json",
  ".woff2":"font/woff2",
  ".woff": "font/woff",
};

// ── Static file server ───────────────────────────────────────────────────────

/**
 * Serve a static file from disk. Writes headers + body to `res`.
 * Returns true if the file was served, false if not found.
 */
export function serveStatic(res, filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const ext  = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": STATIC_MIME[ext] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
    return true;
  } catch { return false; }
}

// ── Fallback HTML ────────────────────────────────────────────────────────────
// Shown only when frontend/dist/ has not been built yet.

export const fallbackHtml = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>CrewSwarm</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a12;color:#e5e7eb;">
<div style="text-align:center;max-width:480px;padding:40px;">
  <div style="font-size:48px;margin-bottom:16px;">&#x1f6a7;</div>
  <h2 style="margin:0 0 12px;font-size:22px;">Frontend not built</h2>
  <p style="color:#9ca3af;margin:0 0 24px;line-height:1.6;">
    The dashboard UI hasn't been compiled yet. Run the build command and restart the server.
  </p>
  <code style="display:block;background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:16px;font-size:13px;text-align:left;color:#a3e635;">
    cd frontend &amp;&amp; npm run build
  </code>
</div>
</body>
</html>`;

/**
 * Handle a non-API request by trying Vite dist, dev fallback, then inline HTML.
 * Returns true if the request was handled.
 *
 * @param {URL} url - Parsed request URL
 * @param {import("node:http").ServerResponse} res
 * @param {string} frontendDist - Absolute path to frontend/dist/
 * @param {string} frontendSrc  - Absolute path to frontend/
 * @param {string} openclawDir  - Absolute path to repo root
 */
export function handleStaticRequest(url, res, frontendDist, frontendSrc, openclawDir) {
  // Serve frontend static assets (Vite dist in prod, src in dev fallback)
  if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/events")) {
    const distFile = path.join(frontendDist, url.pathname === "/" ? "index.html" : url.pathname);
    if (serveStatic(res, distFile)) return true;
    // Dev fallback: serve from frontend/src or frontend/index.html directly
    if (url.pathname === "/") {
      const devIndex = path.join(frontendSrc, "index.html");
      if (serveStatic(res, devIndex)) return true;
    }
    const srcFile = path.join(frontendSrc, url.pathname);
    if (serveStatic(res, srcFile)) return true;
  }

  if (url.pathname === "/") {
    // Final fallback -- serve legacy inline HTML if frontend not built yet
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
      pragma: "no-cache",
    });
    res.end(fallbackHtml);
    return true;
  }

  if (url.pathname === "/crew-chat.html") {
    const chatFile = path.join(openclawDir, "crew-chat.html");
    try {
      const chatHtml = fs.readFileSync(chatFile, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(chatHtml);
    } catch { res.writeHead(404); res.end("Not found"); }
    return true;
  }

  if (url.pathname === "/favicon.ico" || url.pathname === "/favicon.png") {
    const faviconPath = path.join(openclawDir, "website", "favicon.png");
    try {
      const data = fs.readFileSync(faviconPath);
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      res.end(data);
    } catch {
      res.writeHead(204);
      res.end();
    }
    return true;
  }

  return false;
}
