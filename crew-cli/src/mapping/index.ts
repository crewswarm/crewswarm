import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import ignore from 'ignore';

export interface RepositoryGraphNode {
  path: string;
  imports: string[];
  importedBy: string[];
}

export interface RepositoryGraph {
  root: string;
  nodeCount: number;
  edgeCount: number;
  nodes: RepositoryGraphNode[];
}

function toHtmlEscaped(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs'
]);

function createIgnoreMatcher(rootDir: string) {
  const ig = ignore();
  ig.add(['.git', 'node_modules', 'dist', 'build', '.crew', '.next', '.turbo', 'coverage']);
  return readFile(join(rootDir, '.gitignore'), 'utf8')
    .then(content => {
      ig.add(content);
      return ig;
    })
    .catch(() => ig);
}

async function walkIncludedEntries(rootDir: string): Promise<Array<{ fullPath: string; relPath: string; isDir: boolean }>> {
  console.log(`[walkIncludedEntries] Starting walk for root: ${rootDir}`);
  const ig = await createIgnoreMatcher(rootDir);
  console.log(`[walkIncludedEntries] Ignore matcher created`);
  const out: Array<{ fullPath: string; relPath: string; isDir: boolean }> = [];

  async function walk(currentPath: string): Promise<void> {
    const relCurrentPath = relative(rootDir, currentPath);
    console.log(`[walk] Entering directory: ${relCurrentPath || '(root)'}`);
    
    let entries: string[];
    try {
      entries = await readdir(currentPath);
      console.log(`[walk] Directory ${relCurrentPath || '(root)'} contains ${entries.length} entries`);
    } catch (err) {
      console.log(`[walk] Failed to read directory ${relCurrentPath || '(root)'}: ${err}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = join(currentPath, entry);
      const relPath = relative(rootDir, fullPath);
      console.log(`[walk] Processing entry: ${relPath}`);
      
      let entryStat;
      try {
        entryStat = await stat(fullPath);
        console.log(`[walk] Successfully stat'd: ${relPath}`);
      } catch (err) {
        console.log(`[walk] Failed to stat ${relPath}: ${err}`);
        continue;
      }

      const isDir = entryStat.isDirectory();
      console.log(`[walk] Entry ${relPath} is ${isDir ? 'directory' : 'file'}`);
      
      const checkPath = isDir ? `${relPath}/` : relPath;
      const shouldIgnore = ig.ignores(checkPath);
      console.log(`[walk] Ignore check for ${checkPath}: ${shouldIgnore ? 'IGNORED' : 'INCLUDED'}`);
      
      if (shouldIgnore) {
        console.log(`[walk] Skipping ignored path: ${checkPath}`);
        continue;
      }

      console.log(`[walk] Adding to output: ${relPath} (${isDir ? 'dir' : 'file'})`);
      out.push({ fullPath, relPath, isDir });
      
      if (isDir) {
        console.log(`[walk] Recursing into directory: ${relPath}`);
        await walk(fullPath);
        console.log(`[walk] Returned from directory: ${relPath}`);
      }
    }
    
    console.log(`[walk] Exiting directory: ${relCurrentPath || '(root)'}`);
  }

  await walk(rootDir);
  console.log(`[walkIncludedEntries] Walk complete. Found ${out.length} entries (${out.filter(e => e.isDir).length} dirs, ${out.filter(e => !e.isDir).length} files)`);
  return out;
}

function parseImports(content: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /import\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /import\s*?\(\s*?['"]([^'"]+)['"]\s*?\)/g,
    /export\s+[^'"]*?from\s+['"]([^'"]+)['"]/g,
    /require\s*?\(\s*?['"]([^'"]+)['"]\s*?\)/g
  ];

  for (const rx of patterns) {
    for (const match of content.matchAll(rx)) {
      if (match[1]) specs.add(match[1]);
    }
  }
  return Array.from(specs);
}

function resolveImport(fromFile: string, specifier: string, knownFiles: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const fromDir = dirname(fromFile);
  const absBase = resolve(fromDir, specifier);
  const candidates = [
    absBase,
    `${absBase}.ts`,
    `${absBase}.tsx`,
    `${absBase}.js`,
    `${absBase}.jsx`,
    `${absBase}.mjs`,
    `${absBase}.cjs`,
    join(absBase, 'index.ts'),
    join(absBase, 'index.tsx'),
    join(absBase, 'index.js'),
    join(absBase, 'index.jsx'),
    join(absBase, 'index.mjs'),
    join(absBase, 'index.cjs')
  ];

  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

export async function buildRepositoryGraph(dirPath: string): Promise<RepositoryGraph> {
  const root = resolve(dirPath);
  const entries = await walkIncludedEntries(root);
  const sourceFiles = entries
    .filter(entry => !entry.isDir && SOURCE_EXTENSIONS.has(extname(entry.fullPath).toLowerCase()))
    .map(entry => entry.fullPath);

  const knownFileSet = new Set(sourceFiles);
  const importsByFile = new Map<string, Set<string>>();
  const importedByFile = new Map<string, Set<string>>();

  for (const file of sourceFiles) {
    importsByFile.set(file, new Set());
    importedByFile.set(file, new Set());
  }

  for (const file of sourceFiles) {
    let content = '';
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const imports = parseImports(content);
    for (const specifier of imports) {
      const resolved = resolveImport(file, specifier, knownFileSet);
      if (!resolved) continue;
      importsByFile.get(file)?.add(resolved);
      importedByFile.get(resolved)?.add(file);
    }
  }

  const nodes: RepositoryGraphNode[] = sourceFiles.map(file => ({
    path: relative(root, file),
    imports: Array.from(importsByFile.get(file) || []).map(x => relative(root, x)).sort(),
    importedBy: Array.from(importedByFile.get(file) || []).map(x => relative(root, x)).sort()
  })).sort((a, b) => a.path.localeCompare(b.path));

  const edgeCount = nodes.reduce((sum, node) => sum + node.imports.length, 0);
  return {
    root,
    nodeCount: nodes.length,
    edgeCount,
    nodes
  };
}

export async function buildRepositoryMap(dirPath: string): Promise<string> {
  const root = resolve(dirPath);
  const entries = await walkIncludedEntries(root);
  const lines: string[] = [];
  const rootName = root.split('/').pop() || '.';
  lines.push(`${rootName}/`);

  const byParent = new Map<string, Array<{ fullPath: string; relPath: string; isDir: boolean }>>();
  for (const entry of entries) {
    const parentRel = relative(root, dirname(entry.fullPath));
    const key = parentRel === '' ? '.' : parentRel;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)?.push(entry);
  }

  function render(relDir: string, prefix: string) {
    const bucket = (byParent.get(relDir) || []).slice().sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.relPath.localeCompare(b.relPath);
    });

    for (let i = 0; i < bucket.length; i += 1) {
      const item = bucket[i];
      const isLast = i === bucket.length - 1;
      const marker = isLast ? '└── ' : '├── ';
      lines.push(`${prefix}${marker}${item.relPath.split('/').pop() || item.relPath}${item.isDir ? '/' : ''}`);
      if (item.isDir) {
        render(item.relPath, `${prefix}${isLast ? '    ' : '│   '}`);
      }
    }
  }

  render('.', '');
  return `${lines.join('\n')}\n`;
}

export function renderGraphHtml(graph: RepositoryGraph): string {
  const data = JSON.stringify(graph);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Repository Graph</title>
  <style>
    :root { --bg:#0f172a; --card:#111827; --text:#e5e7eb; --muted:#94a3b8; --link:#38bdf8; --edge:#334155; }
    body { margin:0; background:linear-gradient(120deg,#0b1220,#111827); color:var(--text); font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .wrap { max-width:1200px; margin:0 auto; padding:24px; }
    h1 { margin:0 0 4px; font-size:20px; }
    .meta { color:var(--muted); margin-bottom:16px; }
    .search { width:100%; padding:10px 12px; border:1px solid #374151; border-radius:8px; background:#0b1020; color:var(--text); margin-bottom:14px; }
    .grid { display:grid; gap:10px; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); }
    .node { background:rgba(17,24,39,.8); border:1px solid #1f2937; border-radius:10px; padding:12px; }
    .path { color:var(--link); font-weight:600; margin-bottom:8px; word-break:break-all; }
    .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
    .list { margin:6px 0 0; padding-left:16px; max-height:120px; overflow:auto; }
    .empty { color:var(--muted); font-style:italic; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Repository Dependency Graph</h1>
    <div class="meta" id="meta"></div>
    <input id="search" class="search" placeholder="Filter nodes by path..." />
    <div id="grid" class="grid"></div>
  </div>
  <script>
    const graph = ${data};
    const grid = document.getElementById('grid');
    const meta = document.getElementById('meta');
    const search = document.getElementById('search');
    const esc = s => String(s).replace(/[&<>\\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c] || c));
    meta.textContent = \`\${graph.root} | nodes: \${graph.nodeCount} | edges: \${graph.edgeCount}\`;
    function render(filter = '') {
      const q = filter.trim().toLowerCase();
      const nodes = graph.nodes.filter(n => !q || n.path.toLowerCase().includes(q));
      grid.innerHTML = nodes.map(n => \`
        <article class="node">
          <div class="path">\${esc(n.path)}</div>
          <div class="label">imports</div>
          \${n.imports.length ? '<ul class="list">' + n.imports.map(i => '<li>' + esc(i) + '</li>').join('') + '</ul>' : '<div class="empty">(none)</div>'}
          <div class="label" style="margin-top:8px">imported by</div>
          \${n.importedBy.length ? '<ul class="list">' + n.importedBy.map(i => '<li>' + esc(i) + '</li>').join('') + '</ul>' : '<div class="empty">(none)</div>'}
        </article>
      \`).join('');
    }
    render();
    search.addEventListener('input', () => render(search.value));
  </script>
</body>
</html>
`;
}

export function buildRepositoryGraphDot(graph: RepositoryGraph): string {
  const lines: string[] = [];
  lines.push('digraph RepositoryGraph {');
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box, style=rounded, fontsize=10];');

  for (const node of graph.nodes) {
    lines.push(`  "${node.path}";`);
  }
  for (const node of graph.nodes) {
    for (const target of node.imports) {
      lines.push(`  "${node.path}" -> "${target}";`);
    }
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildRepositoryGraphHtml(graph: RepositoryGraph): string {
  const payload = JSON.stringify(graph);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Repository Graph</title>
  <style>
    :root { --bg:#0b1220; --panel:#111a2d; --text:#dbe7ff; --muted:#8fa7d1; --accent:#63d3ff; --line:#21314f; }
    * { box-sizing:border-box; }
    body { margin:0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background:linear-gradient(160deg,#0a1324,#101a31); color:var(--text); }
    .wrap { display:grid; grid-template-columns: 360px 1fr; min-height:100vh; }
    .left { border-right:1px solid var(--line); padding:16px; background:rgba(8,13,24,.6); }
    .right { padding:16px; }
    input { width:100%; padding:10px; border:1px solid var(--line); border-radius:10px; background:#0f1728; color:var(--text); }
    h1 { margin:0 0 8px; font-size:16px; color:var(--accent); }
    .meta { color:var(--muted); font-size:12px; margin-bottom:12px; }
    .list { margin-top:10px; max-height:calc(100vh - 130px); overflow:auto; border:1px solid var(--line); border-radius:10px; }
    .item { padding:10px 12px; border-bottom:1px solid var(--line); cursor:pointer; font-size:12px; }
    .item:hover, .item.active { background:#17223b; }
    .item:last-child { border-bottom:none; }
    .panel { border:1px solid var(--line); border-radius:12px; padding:14px; background:rgba(12,18,32,.75); }
    .k { color:var(--muted); font-size:12px; margin-top:10px; }
    .v { white-space:pre-wrap; font-size:12px; line-height:1.45; }
    @media (max-width: 900px) { .wrap { grid-template-columns: 1fr; } .left { border-right:none; border-bottom:1px solid var(--line); } }
  </style>
</head>
<body>
  <div class="wrap">
    <aside class="left">
      <h1>Repository Graph</h1>
      <div class="meta">${escapeHtml(graph.root)}<br/>${graph.nodeCount} nodes • ${graph.edgeCount} edges</div>
      <input id="q" placeholder="Filter files..." />
      <div id="list" class="list"></div>
    </aside>
    <main class="right">
      <div class="panel">
        <h1 id="title">Select a node</h1>
        <div class="k">Imports</div>
        <div id="imports" class="v">(none)</div>
        <div class="k">Imported By</div>
        <div id="importedBy" class="v">(none)</div>
      </div>
    </main>
  </div>
  <script>
    const graph = ${payload};
    const list = document.getElementById('list');
    const q = document.getElementById('q');
    const title = document.getElementById('title');
    const importsEl = document.getElementById('imports');
    const importedByEl = document.getElementById('importedBy');
    let activePath = '';
    function render(items) {
      list.innerHTML = '';
      for (const node of items) {
        const row = document.createElement('div');
        row.className = 'item' + (node.path === activePath ? ' active' : '');
        row.textContent = node.path;
        row.onclick = () => select(node.path);
        list.appendChild(row);
      }
    }
    function select(path) {
      activePath = path;
      const node = graph.nodes.find(n => n.path === path);
      if (!node) return;
      title.textContent = node.path;
      importsEl.textContent = node.imports.length ? node.imports.join('\\n') : '(none)';
      importedByEl.textContent = node.importedBy.length ? node.importedBy.join('\\n') : '(none)';
      render(filterNodes(q.value));
    }
    function filterNodes(text) {
      const t = String(text || '').toLowerCase().trim();
      if (!t) return graph.nodes;
      return graph.nodes.filter(n => n.path.toLowerCase().includes(t));
    }
    q.addEventListener('input', () => render(filterNodes(q.value)));
    render(graph.nodes);
    if (graph.nodes[0]) select(graph.nodes[0].path);
  </script>
</body>
</html>
`;
}
