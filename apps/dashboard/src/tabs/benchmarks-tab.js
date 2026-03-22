import { escHtml } from '../core/dom.js';

// ── Benchmark task runner state ──────────────────────────────────────────────
let _runnerTasks = [];        // cached task rows from HuggingFace
let _runnerAbort = null;      // AbortController for active SSE stream

export function showBenchmarks({ hideAllViews, setNavActive } = {}) {
  if (typeof hideAllViews === 'function') hideAllViews();
  const view = document.getElementById('benchmarksView');
  if (view) view.classList.add('active');
  if (typeof setNavActive === 'function') setNavActive('navBenchmarks');
  loadBenchmarkOptions().then(() => {
    const sel = document.getElementById('benchmarkSelect');
    if (sel && sel.value) loadBenchmarkLeaderboard(sel.value);
  });
}

export async function loadBenchmarkOptions() {
  const sel = document.getElementById('benchmarkSelect');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Loading… —</option>';
  try {
    const r = await fetch('/api/zeroeval/benchmarks');
    const arr = await r.json();
    if (!Array.isArray(arr)) throw new Error('Expected array');
    sel.innerHTML = '<option value="">— Pick benchmark —</option>';
    arr.forEach(b => {
      const id = typeof b === 'object' ? (b.benchmark_id || b.id) : b;
      const name = typeof b === 'object' ? (b.name || id) : id;
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    if (cur && arr.some(b => (typeof b === 'object' ? b.benchmark_id : b) === cur)) {
      sel.value = cur;
    } else {
      const DEFAULT_BENCHMARK = 'swe-bench-verified';
      if (arr.some(b => (typeof b === 'object' ? b.benchmark_id : b) === DEFAULT_BENCHMARK)) {
        sel.value = DEFAULT_BENCHMARK;
      }
    }
    return sel.value;
  } catch (e) {
    sel.innerHTML = '<option value="">— Failed to load —</option>';
  }
}

export async function loadBenchmarks() {
  await loadBenchmarkOptions();
  const sel = document.getElementById('benchmarkSelect');
  if (sel && sel.value) loadBenchmarkLeaderboard(sel.value);
}

export async function loadBenchmarkLeaderboard(benchmarkId) {
  const tableEl = document.getElementById('benchmarkTable');
  const metaEl = document.getElementById('benchmarkMeta');
  if (!tableEl || !metaEl) return;
  if (!benchmarkId) {
    tableEl.innerHTML = '';
    metaEl.style.display = 'none';
    return;
  }
  tableEl.innerHTML = '<div class="meta" style="padding:20px;">Loading…</div>';
  metaEl.style.display = 'none';
  try {
    const r = await fetch('/api/zeroeval/benchmarks/' + encodeURIComponent(benchmarkId));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || data.detail || 'Failed to load');
    const models = data.entries || data.models || [];
    const totalModels = data.total_models ?? data.statistics?.total_models ?? models.length;
    const avgScore = data.statistics?.average_score ?? (models.length ? models.reduce((s, m) => (s + (m.normalized_score ?? m.benchmark_score ?? m.score ?? 0)), 0) / models.length : 0);
    const displayName = data.benchmark_name || data.name || benchmarkId;
    const displayDesc = data.benchmark_description || data.description || '';
    metaEl.innerHTML = '<b>' + escHtml(displayName) + '</b>' + (displayDesc ? ': ' + escHtml(displayDesc.slice(0, 200)) : '') + ' | ' + totalModels + ' models, avg ' + (avgScore * 100).toFixed(1) + '%';
    metaEl.style.display = 'block';
    if (!models.length) {
      tableEl.innerHTML = '<div class="meta" style="padding:20px;">No model scores for this benchmark.</div>';
      return;
    }
    const rows = models.slice(0, 100).map(m => {
      const score = (m.normalized_score != null ? m.normalized_score : (m.benchmark_score != null ? m.benchmark_score : m.score)) ?? 0;
      const pct = (score * 100).toFixed(1);
      const inp = m.input_cost_per_million != null ? Math.round(m.input_cost_per_million * 100) + '¢' : '—';
      const out = m.output_cost_per_million != null ? Math.round(m.output_cost_per_million * 100) + '¢' : '—';
      const inC = m.input_cost_per_million ?? 0;
      const outC = m.output_cost_per_million ?? 0;
      const centsPerPt = (inC + outC) > 0 && score > 0 ? ((inC + outC) * 100 / (score * 100)).toFixed(1) + '¢/pt' : '—';
      return '<tr><td style="padding:6px 10px;">' + (m.rank || '-') + '</td><td style="padding:6px 10px;">' + escHtml(m.model_name || m.model_id) + '</td><td style="padding:6px 10px;">' + escHtml(m.organization_name || '') + '</td><td style="padding:6px 10px;font-weight:600;">' + pct + '%</td><td style="padding:6px 10px;font-size:11px;" title="¢ per 1M input tokens">' + inp + '</td><td style="padding:6px 10px;font-size:11px;" title="¢ per 1M output tokens">' + out + '</td><td style="padding:6px 10px;font-size:11px;" title="¢ per score point (1M in+out / score%)">' + centsPerPt + '</td><td style="padding:6px 10px;font-size:11px;">' + (m.analysis_method || '-').slice(0, 40) + '</td></tr>';
    }).join('');
    tableEl.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="border-bottom:1px solid var(--border);"><th style="text-align:left;padding:6px 10px;">Rank</th><th style="text-align:left;padding:6px 10px;">Model</th><th style="text-align:left;padding:6px 10px;">Org</th><th style="text-align:left;padding:6px 10px;">Score</th><th style="text-align:left;padding:6px 10px;" title="¢ per 1M input">in ¢</th><th style="text-align:left;padding:6px 10px;" title="¢ per 1M output">out ¢</th><th style="text-align:left;padding:6px 10px;" title="¢ per score point">¢/pt</th><th style="text-align:left;padding:6px 10px;">Method</th></tr></thead><tbody>' + rows + '</tbody></table>';
  } catch (e) {
    tableEl.innerHTML = '<div style="color:var(--red);padding:20px;">Error: ' + escHtml(e.message) + '</div>';
  }
}

// ── Custom runner — load SWE-Bench tasks into the task picker ────────────────
export async function loadBenchmarkTasks() {
  const sel = document.getElementById('benchmarkTaskSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Loading tasks… —</option>';
  try {
    const r = await fetch('/api/benchmark-tasks?benchmark=swe-bench-verified&offset=0&length=50');
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load tasks');
    const rows = data.rows || [];
    _runnerTasks = rows.map(r => r.row || r);
    sel.innerHTML = '<option value="">— Pick a task —</option>';
    _runnerTasks.forEach((task, i) => {
      const id = task.instance_id || task.id || `task-${i}`;
      const repo = task.repo || '';
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = id + (repo ? ` (${repo})` : '');
      sel.appendChild(opt);
    });
  } catch (e) {
    sel.innerHTML = '<option value="">— Failed: ' + escHtml(e.message) + ' —</option>';
  }
}

// Show problem statement preview when a task is selected
export function onBenchmarkTaskSelect(idx) {
  const preview = document.getElementById('benchmarkTaskPreview');
  if (!preview) return;
  if (idx === '' || idx == null || !_runnerTasks[idx]) { preview.style.display = 'none'; return; }
  const task = _runnerTasks[idx];
  const ps = task.problem_statement || task.description || '(no problem statement)';
  preview.textContent = ps.slice(0, 800) + (ps.length > 800 ? '\n…' : '');
  preview.style.display = 'block';
}

// ── Stream a benchmark task through an engine ────────────────────────────────
export async function runBenchmarkTask() {
  const sel = document.getElementById('benchmarkTaskSelect');
  const engineSel = document.getElementById('benchmarkRunEngine');
  const modelInput = document.getElementById('benchmarkRunModel');
  const outputEl = document.getElementById('benchmarkRunOutput');
  const streamEl = document.getElementById('benchmarkRunStream');
  const statusEl = document.getElementById('benchmarkRunStatus');
  const stopBtn = document.getElementById('benchmarkRunStop');
  const runBtn = document.getElementById('benchmarkRunBtn');
  if (!sel || !engineSel || !outputEl || !streamEl) return;

  const idx = sel.value;
  if (idx === '' || idx == null || !_runnerTasks[idx]) {
    alert('Pick a task first — click "↻ Load Tasks" if the list is empty.');
    return;
  }
  const task = _runnerTasks[idx];
  const engine = engineSel.value;
  const model = (modelInput?.value || '').trim() || undefined;

  // Cancel any existing run
  if (_runnerAbort) { try { _runnerAbort.abort(); } catch {} }
  _runnerAbort = new AbortController();

  outputEl.style.display = 'flex';
  streamEl.textContent = '';
  statusEl.textContent = `Running on ${engine}…`;
  if (stopBtn) stopBtn.style.display = 'inline-block';
  if (runBtn) runBtn.disabled = true;

  try {
    const resp = await fetch('/api/benchmark-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instanceId: task.instance_id || task.id,
        problemStatement: task.problem_statement || task.description || '',
        repo: task.repo || '',
        hints: task.hints_text || '',
        engine,
        ...(model ? { model } : {}),
      }),
      signal: _runnerAbort.signal,
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        const line = part.replace(/^data:\s*/, '');
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'chunk' && ev.text) {
            streamEl.textContent += ev.text;
            streamEl.scrollTop = streamEl.scrollHeight;
          } else if (ev.type === 'done') {
            const ok = ev.exitCode === 0 || ev.exitCode == null;
            statusEl.textContent = ok ? '✓ Done' : `✗ Exit ${ev.exitCode}`;
            statusEl.style.color = ok ? 'var(--green)' : 'var(--red)';
          } else if (ev.type === 'error' || ev.error) {
            streamEl.textContent += '\n[error] ' + (ev.error || ev.message || JSON.stringify(ev));
          }
        } catch {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      streamEl.textContent += '\n[stream error] ' + e.message;
      statusEl.textContent = '✗ Error';
      statusEl.style.color = 'var(--red)';
    } else {
      statusEl.textContent = '⏹ Stopped';
      statusEl.style.color = 'var(--text-2)';
    }
  } finally {
    if (stopBtn) stopBtn.style.display = 'none';
    if (runBtn) runBtn.disabled = false;
    _runnerAbort = null;
  }
}

export function stopBenchmarkRun() {
  if (_runnerAbort) {
    try { _runnerAbort.abort(); } catch {}
    _runnerAbort = null;
  }
}
