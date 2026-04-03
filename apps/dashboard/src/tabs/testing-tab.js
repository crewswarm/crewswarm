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

export function showTesting() {
  hideAllViews();
  document.getElementById("testingView").classList.add("active");
  setNavActive("navTesting");
  state.activeTab = "testing";
  persistState();
  loadTestingSummary();
  loadTestingHistory();
  // Check if tests are already running
  getJSON("/api/tests/progress").then(p => {
    if (p.running && !progressPollId) {
      renderProgressBar();
      progressPollId = setInterval(renderProgressBar, 2000);
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
      { key: "playwright", label: "Playwright", files: fc.playwright, tests: tc.playwright, cmd: "test:e2e:vibe", color: "#f472b6" },
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

    // ── Per-suite cards ──
    html += '<div class="test-section-title">Latest Results by Suite</div>';
    html += '<div class="test-suite-grid">';
    for (const suiteKey of ["unit", "integration", "e2e", "all"]) {
      const s = data.suites?.[suiteKey];
      if (!s || (!s.total && !s.passed && !s.failed)) continue;
      const ran = (s.passed || 0) + (s.failed || 0);
      const statusClass = s.failed > 0 ? "test-status-fail" : "test-status-pass";
      const statusLabel = s.failed > 0 ? "FAIL" : "PASS";
      const color = SUITE_COLORS[suiteKey];
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
        </div>`;
    }
    html += '</div>';

    // ── Failures ──
    const allFailures = [];
    for (const s of Object.values(data.suites || {})) {
      if (s.failures) allFailures.push(...s.failures);
    }
    if (allFailures.length > 0) {
      html += `<div class="test-section-title">Failures (${allFailures.length})</div>`;
      for (const f of allFailures) {
        html += `
          <div class="test-failure-card">
            <div class="test-failure-name">${escHtml(f.name)}</div>
            <div class="test-failure-file">${escHtml(f.file)}</div>
            ${f.classification && f.classification !== "unknown" ? `<span class="test-failure-class">${escHtml(f.classification)}</span>` : ""}
            ${f.error ? `<pre class="test-failure-error">${escHtml(String(f.error).slice(0, 500))}</pre>` : ""}
            ${f.rerun_command ? `<div class="test-failure-rerun"><code>${escHtml(f.rerun_command)}</code></div>` : ""}
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
        html += `
          <div class="test-failure-card">
            <div class="test-failure-name">${escHtml(f.name)}</div>
            <div class="test-failure-file">${escHtml(f.file)}</div>
            ${f.error ? `<pre class="test-failure-error">${escHtml(String(f.error).slice(0, 500))}</pre>` : ""}
            ${f.rerun_command ? `<div class="test-failure-rerun"><code>${escHtml(f.rerun_command)}</code></div>` : ""}
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
      loadTestingSummary();
      loadTestingHistory();
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
  } catch (e) {
    showNotification("Failed to start tests: " + e.message, true);
  }
}
