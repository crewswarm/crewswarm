import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const reportDir = path.join(rootDir, "output");
const reportPath = path.join(reportDir, "performance-audit.json");
const port = Number(process.env.STUDIO_AUDIT_PORT || 3345);
const baseUrl = `http://127.0.0.1:${port}`;

const BUDGETS = {
  domContentLoadedMs: 2500,
  loadMs: 4000,
  lcpMs: 2500,
  resourceCount: 40,
  totalTransferBytes: 1_500_000,
  jsHeapUsedBytes: 80 * 1024 * 1024,
  longTasks: 3,
};

async function ensureBuildOutput() {
  await fs.access(path.join(rootDir, "dist", "index.html"));
}

async function waitForServer(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }

  throw lastError || new Error("Studio server did not become ready");
}

function startServer() {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      STUDIO_PORT: String(port),
    },
    stdio: "ignore",
  });
  return child;
}

async function collectMetrics() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);

  await page.addInitScript(() => {
    window.__studioPerf = {
      lcp: 0,
      cls: 0,
      longTasks: 0,
      longTaskTime: 0,
    };

    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const lastEntry = entries.at(-1);
      if (lastEntry) {
        window.__studioPerf.lcp = lastEntry.startTime;
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          window.__studioPerf.cls += entry.value;
        }
      }
    }).observe({ type: "layout-shift", buffered: true });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__studioPerf.longTasks += 1;
        window.__studioPerf.longTaskTime += entry.duration;
      }
    }).observe({ type: "longtask", buffered: true });
  });

  await cdp.send("Performance.enable");
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForLoadState("load", { timeout: 15_000 });
  await delay(750);

  const browserMetrics = await cdp.send("Performance.getMetrics");
  const runtimeMetrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    const totals = resources.reduce(
      (acc, entry) => {
        acc.transferSize += entry.transferSize || 0;
        if (entry.initiatorType === "script") {
          acc.scriptTransferSize += entry.transferSize || 0;
        }
        return acc;
      },
      { transferSize: 0, scriptTransferSize: 0 },
    );

    return {
      domContentLoadedMs: navigation?.domContentLoadedEventEnd || 0,
      loadMs: navigation?.loadEventEnd || 0,
      resourceCount: resources.length,
      totalTransferBytes: totals.transferSize,
      scriptTransferBytes: totals.scriptTransferSize,
      lcpMs: window.__studioPerf?.lcp || 0,
      cls: window.__studioPerf?.cls || 0,
      longTasks: window.__studioPerf?.longTasks || 0,
      longTaskTimeMs: window.__studioPerf?.longTaskTime || 0,
    };
  });

  await browser.close();

  const cdpMetricMap = Object.fromEntries(
    browserMetrics.metrics.map((metric) => [metric.name, metric.value]),
  );

  return {
    collectedAt: new Date().toISOString(),
    url: baseUrl,
    budgets: BUDGETS,
    metrics: {
      ...runtimeMetrics,
      jsHeapUsedBytes: cdpMetricMap.JSHeapUsedSize || 0,
      nodes: cdpMetricMap.Nodes || 0,
      documents: cdpMetricMap.Documents || 0,
    },
  };
}

function evaluateBudgets(report) {
  const { metrics } = report;

  const checks = [
    ["domContentLoadedMs", metrics.domContentLoadedMs <= BUDGETS.domContentLoadedMs],
    ["loadMs", metrics.loadMs <= BUDGETS.loadMs],
    ["resourceCount", metrics.resourceCount <= BUDGETS.resourceCount],
    ["totalTransferBytes", metrics.totalTransferBytes <= BUDGETS.totalTransferBytes],
    ["jsHeapUsedBytes", metrics.jsHeapUsedBytes <= BUDGETS.jsHeapUsedBytes],
    ["longTasks", metrics.longTasks <= BUDGETS.longTasks],
  ];

  if (metrics.lcpMs > 0) {
    checks.push(["lcpMs", metrics.lcpMs <= BUDGETS.lcpMs]);
  }

  report.checks = checks.map(([name, pass]) => ({ name, pass }));
  report.ok = report.checks.every((check) => check.pass);
}

async function main() {
  await ensureBuildOutput();
  await fs.mkdir(reportDir, { recursive: true });

  console.log("Starting Studio server for performance audit...");
  const server = startServer();

  try {
    console.log("Waiting for Studio server...");
    await waitForServer(baseUrl);
    console.log("Collecting browser metrics...");
    const report = await collectMetrics();
    console.log("Evaluating budgets...");
    evaluateBudgets(report);
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    console.log(`Performance audit written to ${reportPath}`);
    report.checks.forEach((check) => {
      console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name}`);
    });

    assert.ok(report.ok, "Studio performance audit exceeded one or more budgets");
  } finally {
    if (server.exitCode === null && !server.killed) {
      server.kill("SIGTERM");
      await Promise.race([once(server, "exit"), delay(2_000)]);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
