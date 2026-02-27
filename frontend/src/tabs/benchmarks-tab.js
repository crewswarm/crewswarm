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
