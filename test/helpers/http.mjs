/**
 * HTTP helper for integration/e2e tests.
 *
 * Node 25's global `fetch` (undici) intermittently hangs on localhost connections
 * due to connection-pool behaviour. This helper uses `http.request` which is
 * 100% reliable for local-server health checks and API calls.
 */

import http from "node:http";
import { logHttpInteraction } from "./test-log.mjs";

/**
 * Make an HTTP request using Node's http module (no undici/fetch).
 * Returns { status, data } where data is the parsed JSON body.
 */
export function httpRequest(urlStr, { method = "GET", body = null, timeout = 15000, headers = {}, trace = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const startedAt = Date.now();
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      timeout,
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
 * Check if a service is up by hitting a URL and checking for a 2xx response.
 */
export async function checkServiceUp(url, timeoutMs = 8000) {
  try {
    const { status } = await httpRequest(url, { timeout: timeoutMs });
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}
