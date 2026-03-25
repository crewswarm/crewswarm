/**
 * HTTP helper for integration/e2e tests.
 *
 * Node 25's global `fetch` (undici) intermittently hangs on localhost connections
 * due to connection-pool behaviour. This helper uses `http.request` which is
 * 100% reliable for local-server health checks and API calls.
 */

import http from "node:http";

/**
 * Make an HTTP request using Node's http module (no undici/fetch).
 * Returns { status, data } where data is the parsed JSON body.
 */
export function httpRequest(urlStr, { method = "GET", body = null, timeout = 5000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
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
        try {
          resolve({ status: res.statusCode, data: JSON.parse(d) });
        } catch {
          resolve({ status: res.statusCode, data: d });
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timeout"));
    });

    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

/**
 * Check if a service is up by hitting a URL and checking for a 2xx response.
 */
export async function checkServiceUp(url, timeoutMs = 3000) {
  try {
    const { status } = await httpRequest(url, { timeout: timeoutMs });
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}
