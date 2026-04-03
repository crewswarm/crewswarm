/**
 * HTTP helper for integration/e2e tests.
 *
 * Node 25's global `fetch` (undici) intermittently hangs on localhost connections
 * due to connection-pool behaviour. This helper uses `http.request` which is
 * 100% reliable for local-server health checks and API calls.
 */

import http from "node:http";
import { execSync } from "node:child_process";
import { logHttpInteraction } from "./test-log.mjs";

/**
 * Make an HTTP request using Node's http module (no undici/fetch).
 * Returns { status, data } where data is the parsed JSON body.
 * Falls back to curl if Node's http.request times out (Node 25 SSE saturation issue).
 */
export async function httpRequest(urlStr, { method = "GET", body = null, timeout = 15000, headers = {}, trace = null } = {}) {
  // The dashboard has 237 sync I/O calls (readFileSync, execSync) that block the event loop.
  // Node 25's http.request shares the event loop, so requests queue behind sync I/O.
  // Use curl for localhost (runs in a separate process, unaffected by Node event loop blocking).
  const url = new URL(urlStr);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    return curlRequest(urlStr, { method, body, timeout, headers });
  }
  return _httpRequestNode(urlStr, { method, body, timeout, headers, trace });
}

function _httpRequestNode(urlStr, { method = "GET", body = null, timeout = 15000, headers = {}, trace = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const startedAt = Date.now();
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      timeout,
      agent: false,
      headers: { "content-type": "application/json", connection: "close", ...headers },
    };

    const req = http.request(options, (res) => {
      let d = "";
      res.on("data", (chunk) => (d += chunk));
      res.on("end", () => {
        const durationMs = Date.now() - startedAt;
        try {
          const parsed = JSON.parse(d);
          if (trace) {
            logHttpInteraction({
              test: trace.test,
              file: trace.file,
              operation: trace.operation,
              url: urlStr,
              method,
              timeout_ms: timeout,
              status: res.statusCode,
              duration_ms: durationMs,
              request_headers: headers,
              response_headers: res.headers,
              response_body: parsed,
              extra: trace.extra,
            });
          }
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          if (trace) {
            logHttpInteraction({
              test: trace.test,
              file: trace.file,
              operation: trace.operation,
              url: urlStr,
              method,
              timeout_ms: timeout,
              status: res.statusCode,
              duration_ms: durationMs,
              request_headers: headers,
              response_headers: res.headers,
              response_body: d,
              extra: trace.extra,
            });
          }
          resolve({ status: res.statusCode, data: d });
        }
      });
    });

    req.on("error", (error) => {
      if (trace) {
        logHttpInteraction({
          test: trace.test,
          file: trace.file,
          operation: trace.operation,
          url: urlStr,
          method,
          timeout_ms: timeout,
          duration_ms: Date.now() - startedAt,
          request_headers: headers,
          error,
          extra: trace.extra,
        });
      }
      reject(error);
    });
    req.on("timeout", () => {
      req.destroy();
      const error = new Error("request timeout");
      if (trace) {
        logHttpInteraction({
          test: trace.test,
          file: trace.file,
          operation: trace.operation,
          url: urlStr,
          method,
          timeout_ms: timeout,
          duration_ms: Date.now() - startedAt,
          request_headers: headers,
          error,
          extra: trace.extra,
        });
      }
      reject(error);
    });

    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

/**
 * Fallback HTTP request using curl — bypasses Node 25 connection pool issues.
 * Synchronous, used when httpRequest times out due to SSE connection saturation.
 */
export function curlRequest(urlStr, { method = "GET", body = null, timeout = 15000, headers = {} } = {}) {
  const timeoutSec = Math.max(1, Math.ceil(timeout / 1000));
  const cmdParts = [
    `curl -s --max-time ${timeoutSec}`,
    `-X ${method}`,
    `-H "Content-Type: application/json"`,
  ];
  for (const [k, v] of Object.entries(headers)) {
    cmdParts.push(`-H "${k}: ${v}"`);
  }
  if (body) {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    cmdParts.push(`-d '${bodyStr.replace(/'/g, "'\\''")}'`);
  }
  cmdParts.push(`-w "\\n%{http_code}"`);
  cmdParts.push(`"${urlStr}"`);

  let raw;
  try {
    raw = execSync(cmdParts.join(" "), { encoding: "utf8", timeout: timeout + 3000, stdio: ["pipe", "pipe", "ignore"] });
  } catch (err) {
    // curl exit 28 = timeout, but stdout may still have partial data
    raw = err.stdout || "";
    if (!raw) throw new Error("request timeout");
  }
  const lastNewline = raw.lastIndexOf("\n");
  const bodyStr = lastNewline > 0 ? raw.slice(0, lastNewline) : "";
  const statusStr = lastNewline > 0 ? raw.slice(lastNewline + 1).trim() : raw.trim();
  const status = parseInt(statusStr, 10) || 0;
  let data;
  try { data = JSON.parse(bodyStr); } catch { data = bodyStr; }
  return { status, data };
}

/**
 * Check if a service is up by hitting a URL with curl.
 * Node 25's TCP/HTTP layers share the event loop with SSE connections, causing
 * timeouts even when the server is alive. curl operates at the OS level and
 * is unaffected by Node's connection pooling.
 */
export async function checkServiceUp(url, timeoutMs = 15000) {
  try {
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const output = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --max-time ${timeoutSec} "${url}"`,
      { encoding: "utf8", timeout: timeoutMs + 2000, stdio: ["pipe", "pipe", "ignore"] }
    );
    const code = parseInt(output.trim(), 10);
    return code >= 200 && code < 300;
  } catch {
    return false;
  }
}
