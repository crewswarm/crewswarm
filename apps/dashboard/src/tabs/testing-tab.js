import { getJSON, postJSON } from "../core/api.js";
import { escHtml, showNotification } from "../core/dom.js";
import { state, persistState } from "../core/state.js";

let hideAllViews = () => {};
let setNavActive = () => {};

export function initTestingTab(deps = {}) {
  hideAllViews = deps.hideAllViews || hideAllViews;
  setNavActive = deps.setNavActive || setNavActive;
}

let pollTimer = null;

// ── SSE stream state ──────────────────────────────────────────────────────────
let streamEventSource = null;
let streamOutput = "";

export function showTesting() {
  hideAllViews();
  document.getElementById("testingView").classList.add("active");
  setNavActive("navTesting");
  state.activeTab = "testing";
  persistState();
  loadTestingSummary();
  loadTestingHistory();
  loadRunHistoryChart();
  loadCoverageHeatmap();
  loadStaleFiles();
  // Check if tests are already running
  getJSON("/api/tests/progress").then(p => {
    if (p.running && !progressPollId) {
      renderProgressBar();
      progressPollId = setInterval(renderProgressBar, 2000);
      startStreamingOutput();
    }
  }).catch(() => {});
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.getElementById("testingView").classList.contains("active")) {
      loadTestingSummary();
      loadTestingHistory();
    } else {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 30000);
}

function fmtDur(ms) {
  if (!ms || ms <= 0) return "-";
  if (ms >= 60000) return (ms / 60000).toFixed(1) + "m";
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
  return Math.round(ms) + "ms";
}

function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function passRate(passed, failed) {
  const ran = passed + failed;
  if (ran === 0) return "-";
  return ((passed / ran) * 100).toFixed(0) + "%";
}

const SUITE_LABELS = { unit: "Unit", integration: "Integration", e2e: "E2E", all: "All", unknown: "Other" };
const SUITE_COLORS = { unit: "#818cf8", integration: "#34d399", e2e: "#fbbf24", all: "#60a5fa", unknown: "#94a3b8" };

// ── Stale files ───────────────────────────────────────────────────────────────

let staleFiles = new Set();

async function loadStaleFiles() {
  try {
    const data = await getJSON("/api/tests/stale");
    staleFiles = new Set((data.stale || []).map(s => s.file));
  } catch {}
}

// ── Summary ──────────────────────────────────────────────────────────────────

async function loadTestingSummary() {
  const container = document.getElementById("testingContent");
  if (!container) return;
  try {
    const data = await getJSON("/api/tests/summary");
    if (!data.latest && !data.fileCounts) {
      container.innerHTML = '<div class="empty-state">No test results found. Run tests to see results here.</div>';
      return;
    }

    let html = "";
    const fc = data.fileCounts || {};
    const tc = data.testCounts || {};

    // ── Suite overview cards with file counts, test counts, and run buttons ──
    html += '<div class="test-launch-grid">';
    const launchItems = [
      { key: "unit", label: "Unit", files: fc.unit, tests: tc.unit, cmd: "test:unit", color: SUITE_COLORS.unit },
      { key: "integration", label: "Integration", files: fc.integration, tests: tc.integration, cmd: "test:integration", color: SUITE_COLORS.integration },
      { key: "e2e", label: "E2E", files: fc.e2e, tests: tc.e2e, cmd: "test:e2e", color: SUITE_COLORS.e2e },
      { key: "playwright", label: "Playwright", files: fc.playwright, tests: tc.playwright, cmd: "test:playwright", color: "#f472b6" },
      { key: "crew-cli", label: "crew-cli", files: fc["crew-cli"], tests: tc["crew-cli"], cmd: "test", color: "#10b981" },
    ];
    for (const item of launchItems) {
      const testsLabel = item.tests ? `<span class="test-launch-tests">${item.tests} tests</span>` : "";
      const runBtn = item.cmd ? `<button class="test-launch-btn" data-action="runTests" data-arg="${item.cmd}">▶ Run</button>` : `<span class="meta" style="font-size:10px">npx playwright test</span>`;
      html += `
        <div class="test-launch-card" style="border-color:${item.color}30">
          <div class="test-launch-header">
            <span class="test-launch-name" style="color:${item.color}">${item.label}</span>
            ${runBtn}
          </div>
          <div class="test-launch-counts">
            <span class="test-launch-files">${item.files || 0} files</span>
            ${testsLabel}
          </div>
        </div>`;
    }
    // Total + Run All
    const totalTests = Object.values(tc).reduce((s, v) => s + (v || 0), 0);
    html += `
      <div class="test-launch-card test-launch-total" style="border-color:var(--accent)">
        <div class="test-launch-header">
          <span class="test-launch-name" style="color:var(--accent)">All</span>
          <button class="test-launch-btn" data-action="runTests" data-arg="test:all" style="background:var(--accent);color:#fff">▶ Run All</button>
        </div>
        <div class="test-launch-counts">
          <span class="test-launch-files">${fc.total || 0} files</span>
          ${totalTests ? `<span class="test-launch-tests">${totalTests}+ tests</span>` : ""}
        </div>
      </div>`;
    html += '</div>';

    // ── Per-suite cards with file-level breakdown and per-file run buttons ──
    html += '<div class="test-section-title">Latest Results by Suite</div>';
    html += '<div class="test-suite-grid">';
    for (const suiteKey of ["unit", "integration", "e2e", "all"]) {
      const s = data.suites?.[suiteKey];
      if (!s || (!s.total && !s.passed && !s.failed)) continue;
      const ran = (s.passed || 0) + (s.failed || 0);
      const statusClass = s.failed > 0 ? "test-status-fail" : "test-status-pass";
      const statusLabel = s.failed > 0 ? "FAIL" : "PASS";
      const color = SUITE_COLORS[suiteKey];
      // Build per-file rows from tests array
      let fileRows = "";
      if (s.tests && s.tests.length > 0) {
        const byFile = new Map();
        for (const t of s.tests) {
          const f = t.file || "unknown";
          if (!byFile.has(f)) byFile.set(f, { pass: 0, fail: 0, skip: 0 });
          const fb = byFile.get(f);
          if (t.status === "pass") fb.pass++;
          else if (t.status === "fail") fb.fail++;
          else if (t.status === "skip") fb.skip++;
        }
        fileRows = '<div class="test-file-list">';
        for (const [filePath, counts] of byFile) {
          const shortFile = filePath.split("/").pop();
          const relFile = filePath.replace(/^\/.*?CrewSwarm\//, "");
          const isStale = staleFiles.has(relFile) || staleFiles.has(filePath);
          const staleBadge = isStale ? '<span class="test-stale-badge" title="Source changed since last run">⚠️ stale</span>' : "";
          const fileStatusDot = counts.fail > 0 ? "🔴" : "🟢";
          fileRows += `
            <div class="test-file-row">
              <span class="test-file-dot">${fileStatusDot}</span>
              <span class="test-file-name" title="${escHtml(filePath)}">${escHtml(shortFile)}</span>
              ${staleBadge}
              <span class="test-file-counts"><span class="test-color-pass">${counts.pass}p</span> <span class="${counts.fail > 0 ? 'test-color-fail' : ''}">${counts.fail}f</span></span>
              <button class="test-file-run-btn" data-action="runSingleFile" data-arg="${escHtml(suiteKey)}" data-arg2="${escHtml(relFile)}" title="Run this file only">▶</button>
            </div>`;
        }
        fileRows += '</div>';
      }
      html += `
        <div class="test-suite-card">
          <div class="test-suite-header">
            <span class="test-suite-name" style="color:${color}">${SUITE_LABELS[suiteKey]}</span>
            <span class="test-summary-status ${statusClass}">${statusLabel}</span>
          </div>
          <div class="test-suite-stats">
            <div><span class="test-color-pass">${s.passed || 0}</span> pass</div>
            <div><span class="${s.failed > 0 ? 'test-color-fail' : ''}">${s.failed || 0}</span> fail</div>
            <div><span class="${s.skipped > 0 ? 'test-color-skip' : ''}">${s.skipped || 0}</span> skip</div>
            <div><strong>${s.total || 0}</strong> total</div>
          </div>
          <div class="test-suite-meta">
            ${passRate(s.passed || 0, s.failed || 0)} pass rate · ${fmtDur(s.duration_ms)} · ${fmtDate(s.timestamp)}
          </div>
          <div class="test-progress-bar">
            <div class="test-progress-pass" style="width:${ran > 0 ? ((s.passed || 0) / ran * 100) : 0}%"></div>
            <div class="test-progress-fail" style="width:${ran > 0 ? ((s.failed || 0) / ran * 100) : 0}%"></div>
          </div>
          ${fileRows}
        </div>`;
    }
    html += '</div>';

    // ── Failures with drill-down ──────────────────────────────────────────────
    const allFailures = [];
    for (const s of Object.values(data.suites || {})) {
      if (s.failures) allFailures.push(...s.failures);
    }
    if (allFailures.length > 0) {
      html += `<div class="test-section-title">Failures (${allFailures.length})</div>`;
      for (const f of allFailures) {
        const failureId = "fail-" + Math.random().toString(36).slice(2);
        const relFile = (f.file || "").replace(/^\/.*?CrewSwarm\//, "");
        const rerunCmd = f.rerun_command || "";
        const errorLines = (f.error || "").split("\n").slice(0, 10).join("\n");
        // Playwright screenshot path check
        const testSlug = (f.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80);
        const screenshotPath = `${testSlug}/test-failed-1.png`;
        const isPlaywright = (f.file || "").includes(".spec.") || (f.file || "").includes("playwright");
        const screenshotHtml = isPlaywright ? `
          <div class="test-failure-screenshot" id="ss-${escHtml(failureId)}">
            <img src="/api/tests/screenshot?path=${encodeURIComponent(screenshotPath)}"
              class="test-screenshot-thumb"
              alt="Failure screenshot"
              onerror="this.parentElement.style.display='none'"
              onclick="this.classList.toggle('test-screenshot-expanded')"
              title="Click to expand" />
          </div>` : "";
        html += `
          <div class="test-failure-card test-failure-expandable" id="${escHtml(failureId)}">
            <div class="test-failure-header" data-action="toggleFailure" data-arg="${escHtml(failureId)}">
              <span class="test-failure-toggle">▶</span>
              <span class="test-failure-name">${escHtml(f.name)}</span>
              <span class="test-failure-file-inline">${escHtml(f.file || "")}</span>
              ${f.classification && f.classification !== "unknown" ? `<span class="test-failure-class">${escHtml(f.classification)}</span>` : ""}
            </div>
            <div class="test-failure-detail" style="display:none">
              ${f.error ? `<pre class="test-failure-error">${escHtml(String(f.error).slice(0, 500))}</pre>` : ""}
              ${errorLines ? `<pre class="test-failure-stack">${escHtml(errorLines)}</pre>` : ""}
              ${screenshotHtml}
              <div class="test-failure-actions">
                ${relFile ? `<a class="test-failure-link" href="#" onclick="return false" title="${escHtml(relFile)}">${escHtml(relFile.split("/").pop())}</a>` : ""}
                ${rerunCmd ? `<div class="test-failure-rerun">
                  <code>${escHtml(rerunCmd)}</code>
                  <button class="test-copy-btn" data-action="copyText" data-arg="${escHtml(rerunCmd)}" title="Copy rerun command">Copy</button>
                </div>` : ""}
              </div>
            </div>
          </div>`;
      }
    }

    // ── Skips ──
    const allSkips = [];
    for (const [suite, s] of Object.entries(data.suites || {})) {
      if (s.skips) allSkips.push(...s.skips.map(sk => ({ ...sk, suite })));
    }
    if (allSkips.length > 0) {
      html += `<details class="test-skips-section">`;
      html += `<summary class="test-section-title" style="cursor:pointer">Skipped (${allSkips.length}) — click to expand</summary>`;
      html += `<table class="test-groups-table"><thead><tr><th>Test</th><th>File</th><th>Suite</th></tr></thead><tbody>`;
      for (const sk of allSkips.slice(0, 50)) {
        html += `<tr><td>${escHtml(sk.name)}</td><td class="meta">${escHtml(sk.file)}</td><td><span class="test-cat-badge test-cat-${escHtml(sk.suite)}">${escHtml(sk.suite)}</span></td></tr>`;
      }
      if (allSkips.length > 50) html += `<tr><td colspan="3" class="meta">...and ${allSkips.length - 50} more</td></tr>`;
      html += `</tbody></table></details>`;
    }

    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Failed to load test results: ${escHtml(e.message)}</div>`;
  }
}

// ── History ──────────────────────────────────────────────────────────────────

async function loadTestingHistory() {
  const container = document.getElementById("testingHistory");
  if (!container) return;
  try {
    const data = await getJSON("/api/tests/history");
    if (!data.history || data.history.length === 0) {
      container.innerHTML = '<div class="meta">No run history yet.</div>';
      return;
    }

    let html = `<div class="test-section-title">Run History</div>`;
    html += `
      <table class="test-history-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Suite</th>
            <th>Status</th>
            <th class="num">Pass</th>
            <th class="num">Fail</th>
            <th class="num">Skip</th>
            <th class="num">Total</th>
            <th class="num">Duration</th>
            <th class="num">Rate</th>
          </tr>
        </thead>
        <tbody>`;
    for (const r of data.history.slice(0, 25)) {
      const statusCls = r.failed > 0 ? "test-color-fail" : "test-color-pass";
      const suiteLabel = SUITE_LABELS[r.suite] || r.suite || "?";
      const suiteColor = SUITE_COLORS[r.suite] || SUITE_COLORS.unknown;
      html += `
          <tr data-action="loadRunDetail" data-arg="${escHtml(r.runId)}" style="cursor:pointer" class="${r.failed > 0 ? 'test-row-fail' : ''}">
            <td class="meta" style="white-space:nowrap">${fmtDate(r.timestamp)}</td>
            <td><span class="test-cat-badge" style="background:${suiteColor}20;color:${suiteColor}">${suiteLabel}</span></td>
            <td class="${statusCls}" style="font-weight:600">${r.failed > 0 ? "FAIL" : "PASS"} ▸</td>
            <td class="num">${r.passed}</td>
            <td class="num ${r.failed > 0 ? 'test-color-fail' : ''}">${r.failed}</td>
            <td class="num ${r.skipped > 0 ? 'test-color-skip' : ''}">${r.skipped}</td>
            <td class="num"><strong>${r.total}</strong></td>
            <td class="num">${fmtDur(r.duration_ms)}</td>
            <td class="num">${passRate(r.passed, r.failed)}</td>
          </tr>`;
    }
    html += "</tbody></table>";
    html += '<div id="testingRunDetail"></div>';
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="meta">Failed to load history: ${escHtml(e.message)}</div>`;
  }
}

// ── Run detail (click a row to see failures/skips) ───────────────────────────

export async function loadRunDetail(runId) {
  const container = document.getElementById("testingRunDetail");
  if (!container) return;
  container.innerHTML = '<div class="meta" style="padding:12px">Loading run detail...</div>';
  try {
    const data = await getJSON("/api/tests/run-detail?runId=" + encodeURIComponent(runId));
    if (data.error) { container.innerHTML = `<div class="meta">${escHtml(data.error)}</div>`; return; }
    let html = `<div class="test-section-title">Run Detail: ${escHtml(runId)} <span class="meta" style="font-weight:400;font-size:11px;text-transform:none">${fmtDate(data.timestamp)}</span></div>`;
    html += `<div class="test-suite-meta" style="margin-bottom:12px">${data.passed} pass, ${data.failed} fail, ${data.skipped} skip, ${data.total} total · ${fmtDur(data.duration_ms)} · ${passRate(data.passed, data.failed)} pass rate</div>`;
    const hasDetail = (data.failures?.length > 0) || (data.skips?.length > 0);
    if (!hasDetail && data.total > 0) {
      html += `<div class="meta" style="padding:8px 0;color:var(--text-2)">No detailed failure/skip data saved for this run. Run with <code>npm run test:all</code> to generate full reports.</div>`;
    }
    if (data.failures && data.failures.length > 0) {
      html += `<div class="test-section-title">Failures (${data.failures.length})</div>`;
      for (const f of data.failures) {
        const failureId = "rd-fail-" + Math.random().toString(36).slice(2);
        const rerunCmd = f.rerun_command || f.selector?.command || "";
        html += `
          <div class="test-failure-card test-failure-expandable" id="${escHtml(failureId)}">
            <div class="test-failure-header" data-action="toggleFailure" data-arg="${escHtml(failureId)}">
              <span class="test-failure-toggle">▶</span>
              <span class="test-failure-name">${escHtml(f.name)}</span>
            </div>
            <div class="test-failure-detail" style="display:none">
              <div class="test-failure-file">${escHtml(f.file)}</div>
              ${f.error ? `<pre class="test-failure-error">${escHtml(String(f.error).slice(0, 500))}</pre>` : ""}
              ${f.error_stack ? `<pre class="test-failure-stack">${escHtml(String(f.error_stack).split("\n").slice(0, 10).join("\n"))}</pre>` : ""}
              <div class="test-failure-actions">
                ${rerunCmd ? `<div class="test-failure-rerun">
                  <code>${escHtml(rerunCmd)}</code>
                  <button class="test-copy-btn" data-action="copyText" data-arg="${escHtml(rerunCmd)}" title="Copy rerun command">Copy</button>
                </div>` : ""}
              </div>
            </div>
          </div>`;
      }
    }
    if (data.skips && data.skips.length > 0) {
      html += `<details><summary class="test-section-title" style="cursor:pointer">Skipped (${data.skips.length})</summary>`;
      html += `<table class="test-groups-table"><thead><tr><th>Test</th><th>File</th></tr></thead><tbody>`;
      for (const sk of data.skips.slice(0, 50)) {
        html += `<tr><td>${escHtml(sk.name)}</td><td class="meta">${escHtml(sk.file)}</td></tr>`;
      }
      if (data.skips.length > 50) html += `<tr><td colspan="2" class="meta">...and ${data.skips.length - 50} more</td></tr>`;
      html += `</tbody></table></details>`;
    }
    container.innerHTML = html;
    container.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (e) {
    container.innerHTML = `<div class="meta">Failed: ${escHtml(e.message)}</div>`;
  }
}

// ── Run tests action ─────────────────────────────────────────────────────────

let progressPollId = null;

function renderProgressBar() {
  const el = document.getElementById("testProgressBar");
  if (!el) return;
  getJSON("/api/tests/progress").then(p => {
    if (!p.running && !p.finished) { el.innerHTML = ""; return; }
    const elapsed = ((p.finished || Date.now()) - p.started) / 1000;
    const elapsedStr = elapsed >= 60 ? (elapsed / 60).toFixed(1) + "m" : Math.round(elapsed) + "s";
    const total = p.passed + p.failed + p.skipped;
    const suiteLabel = SUITE_LABELS[p.suite?.replace("test:", "")] || p.suite || "Tests";
    if (p.running) {
      const file = p.current_file ? p.current_file.split("/").pop() : "";
      el.innerHTML = `
        <div class="test-progress-live">
          <div class="test-progress-live-header">
            <span class="test-progress-live-status">⏳ Running ${escHtml(suiteLabel)}...</span>
            <span class="meta">${elapsedStr}</span>
            <button class="test-stop-btn" data-action="stopTests" title="Stop running tests">■ Stop</button>
          </div>
          <div class="test-progress-live-stats">
            <span class="test-color-pass">${p.passed} pass</span>
            <span class="test-color-fail">${p.failed} fail</span>
            <span class="test-color-skip">${p.skipped} skip</span>
            <span>${p.files_done} files</span>
            <span>${total} tests</span>
          </div>
          ${file ? `<div class="test-progress-live-file">${escHtml(file)}</div>` : ""}
          <div class="test-progress-bar" style="margin-top:6px">
            <div class="test-progress-pass" style="width:${total > 0 ? (p.passed / total * 100) : 0}%;transition:width 0.3s"></div>
            <div class="test-progress-fail" style="width:${total > 0 ? (p.failed / total * 100) : 0}%;transition:width 0.3s"></div>
          </div>
        </div>`;
    } else {
      // Finished
      const statusCls = p.failed > 0 ? "test-color-fail" : "test-color-pass";
      const statusLabel = p.failed > 0 ? "FAILED" : "PASSED";
      el.innerHTML = `
        <div class="test-progress-live test-progress-done">
          <div class="test-progress-live-header">
            <span class="${statusCls}" style="font-weight:700">✓ ${escHtml(suiteLabel)} ${statusLabel}</span>
            <span class="meta">${elapsedStr}</span>
          </div>
          <div class="test-progress-live-stats">
            <span class="test-color-pass">${p.passed} pass</span>
            <span class="test-color-fail">${p.failed} fail</span>
            <span class="test-color-skip">${p.skipped} skip</span>
            <span>${p.files_done} files</span>
          </div>
        </div>`;
      // Stop polling, refresh data
      if (progressPollId) { clearInterval(progressPollId); progressPollId = null; }
      stopStreamingOutput();
      loadTestingSummary();
      loadTestingHistory();
      loadRunHistoryChart();
      // Clear done state after 10s
      setTimeout(() => { if (el) el.innerHTML = ""; }, 10000);
    }
  }).catch(() => {});
}

export async function runTests(suite) {
  try {
    showNotification(`Starting ${suite}...`);
    await postJSON("/api/tests/run", { suite });
    // Start polling progress
    if (progressPollId) clearInterval(progressPollId);
    renderProgressBar();
    progressPollId = setInterval(renderProgressBar, 2000);
    startStreamingOutput();
  } catch (e) {
    showNotification("Failed to start tests: " + e.message, true);
  }
}

export async function stopTests() {
  try {
    const res = await postJSON("/api/tests/stop", {});
    if (res.stopped) {
      showNotification("Tests stopped.");
      if (progressPollId) { clearInterval(progressPollId); progressPollId = null; }
      stopStreamingOutput();
      renderProgressBar();
      setTimeout(() => refreshTestData(), 1000);
    } else {
      showNotification("No running tests to stop.");
    }
  } catch (e) {
    showNotification("Failed to stop tests: " + e.message, true);
  }
}

// ── Feature 1: Per-File Run Buttons ──────────────────────────────────────────

export async function runSingleFile(suiteKey, filePath) {
  // Map suite key to npm script
  const suiteCmd = {
    unit: "test:unit", integration: "test:integration", e2e: "test:e2e",
    all: "test:all", unknown: "test:unit",
  }[suiteKey] || "test:unit";
  try {
    showNotification(`Running ${filePath.split("/").pop()}...`);
    await postJSON("/api/tests/run", { suite: suiteCmd, file: filePath });
    if (progressPollId) clearInterval(progressPollId);
    renderProgressBar();
    progressPollId = setInterval(renderProgressBar, 2000);
    startStreamingOutput();
  } catch (e) {
    showNotification("Failed to start test: " + e.message, true);
  }
}

// ── Feature 3: Live Streaming Output ─────────────────────────────────────────

function startStreamingOutput() {
  stopStreamingOutput();
  streamOutput = "";
  const termEl = ensureTerminalPanel();
  if (termEl) { termEl.style.display = "block"; termEl.querySelector("pre").textContent = ""; }

  streamEventSource = new EventSource("/api/tests/stream");
  streamEventSource.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.reset) {
        streamOutput = msg.text || "";
      } else if (msg.text) {
        streamOutput += msg.text;
      }
      if (msg.done) {
        stopStreamingOutput();
      }
      const el = document.getElementById("testStreamPre");
      if (el) {
        el.textContent = streamOutput;
        el.scrollTop = el.scrollHeight;
      }
    } catch {}
  };
  streamEventSource.onerror = () => { stopStreamingOutput(); };
}

function stopStreamingOutput() {
  if (streamEventSource) {
    streamEventSource.close();
    streamEventSource = null;
  }
}

function ensureTerminalPanel() {
  let panel = document.getElementById("testStreamPanel");
  if (!panel) {
    const bar = document.getElementById("testProgressBar");
    if (!bar) return null;
    panel = document.createElement("div");
    panel.id = "testStreamPanel";
    panel.className = "test-stream-panel";
    panel.style.display = "none";
    panel.innerHTML = `
      <div class="test-stream-header">
        <span>Live Output</span>
        <button class="test-stream-close" onclick="document.getElementById('testStreamPanel').style.display='none'">✕</button>
      </div>
      <pre id="testStreamPre" class="test-stream-pre"></pre>`;
    bar.parentNode?.insertBefore(panel, bar.nextSibling);
  }
  return panel;
}

// ── Feature 4: Failure Drill-Down toggle ─────────────────────────────────────

export function toggleFailure(targetId) {
  const card = document.getElementById(targetId);
  if (!card) return;
  const detail = card.querySelector(".test-failure-detail");
  const toggle = card.querySelector(".test-failure-toggle");
  if (!detail) return;
  const isOpen = detail.style.display !== "none";
  detail.style.display = isOpen ? "none" : "block";
  if (toggle) toggle.textContent = isOpen ? "▶" : "▼";
}

// ── Feature 6: Coverage Heatmap ──────────────────────────────────────────────

async function loadCoverageHeatmap() {
  const container = document.getElementById("testingCoverage");
  if (!container) return;
  try {
    const data = await getJSON("/api/tests/coverage-map");
    const total = (data.covered?.length || 0) + (data.uncovered?.length || 0);
    if (total === 0) { container.innerHTML = ""; return; }
    const pct = total > 0 ? Math.round((data.covered.length / total) * 100) : 0;
    let html = `<div class="test-section-title">Coverage Heatmap <span class="meta" style="font-weight:400;font-size:12px">${data.covered.length}/${total} files (${pct}%)</span></div>`;
    html += '<div class="test-coverage-grid">';
    for (const f of (data.covered || [])) {
      html += `<div class="test-coverage-block test-coverage-covered" title="${escHtml(f.file)}"></div>`;
    }
    for (const f of (data.uncovered || [])) {
      html += `<div class="test-coverage-block test-coverage-uncovered" title="${escHtml(f.file)}"></div>`;
    }
    html += '</div>';
    html += `<div class="test-coverage-legend">
      <span><span class="test-coverage-dot test-coverage-dot-green"></span> Covered (${data.covered.length})</span>
      <span><span class="test-coverage-dot test-coverage-dot-red"></span> Uncovered (${data.uncovered.length})</span>
    </div>`;
    container.innerHTML = html;
    // Tooltip on hover
    container.querySelectorAll(".test-coverage-block").forEach(el => {
      el.addEventListener("click", () => {
        showNotification(el.title, false);
      });
    });
  } catch {}
}

// ── Feature 7: Run History Chart ─────────────────────────────────────────────

async function loadRunHistoryChart() {
  const container = document.getElementById("testingChart");
  if (!container) return;
  try {
    const data = await getJSON("/api/tests/history");
    const runs = (data.history || []).slice(0, 20).reverse();
    if (runs.length === 0) { container.innerHTML = ""; return; }

    const W = 600, H = 120, PAD = 30, BAR_GAP = 2;
    const maxTotal = Math.max(...runs.map(r => (r.passed || 0) + (r.failed || 0)), 1);
    const barW = Math.floor((W - PAD * 2 - BAR_GAP * (runs.length - 1)) / runs.length);

    let bars = "";
    let labels = "";
    runs.forEach((r, i) => {
      const x = PAD + i * (barW + BAR_GAP);
      const total = (r.passed || 0) + (r.failed || 0);
      const passH = total > 0 ? Math.round(((r.passed || 0) / maxTotal) * (H - PAD)) : 0;
      const failH = total > 0 ? Math.round(((r.failed || 0) / maxTotal) * (H - PAD)) : 0;
      const passY = H - PAD - passH - failH;
      const failY = H - PAD - failH;
      if (failH > 0) bars += `<rect x="${x}" y="${failY}" width="${barW}" height="${failH}" fill="#ef4444" rx="1" opacity="0.85"><title>${fmtDate(r.timestamp)} — ${r.failed} fail</title></rect>`;
      if (passH > 0) bars += `<rect x="${x}" y="${passY}" width="${barW}" height="${passH}" fill="#22c55e" rx="1" opacity="0.85"><title>${fmtDate(r.timestamp)} — ${r.passed} pass</title></rect>`;
      // Label every 5th
      if (i % 5 === 0 || i === runs.length - 1) {
        const ts = r.timestamp ? new Date(r.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
        labels += `<text x="${x + barW / 2}" y="${H - 2}" text-anchor="middle" font-size="9" fill="var(--text-3, #888)">${ts}</text>`;
      }
    });

    const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${W}px;height:${H}px;display:block">
      <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="var(--border,#333)" stroke-width="1"/>
      ${bars}
      ${labels}
    </svg>`;

    container.innerHTML = `
      <div class="test-section-title">Run History (last ${runs.length})
        <span class="test-chart-legend">
          <span style="color:#22c55e">■</span> Pass
          <span style="color:#ef4444">■</span> Fail
        </span>
      </div>
      <div class="test-chart-wrap">${svg}</div>`;
  } catch {}
}

// ── copyText action ───────────────────────────────────────────────────────────

export function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => {
    showNotification("Copied to clipboard");
  }).catch(() => {
    showNotification("Copy failed", true);
  });
}
