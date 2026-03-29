import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * parseDiagnosticOutput is defined inline in cli/index.ts — extract the logic
 * here for unit testing. This mirrors the exact implementation.
 */
function parseDiagnosticOutput(output) {
  const diagnostics = [];
  const seen = new Set();
  const lines = output.split('\n');

  for (const line of lines) {
    let match;

    // TypeScript / ESLint: src/foo.ts(10,5): error TS2345: ...
    // Also: src/foo.ts:10:5 - error TS2345: ...
    match = line.match(/^(.+?)[:(](\d+)[,:](\d+)[):]?\s*[-–:]\s*(error|warning|info)\s+(.+)/i);
    if (!match) {
      // GCC / Clang / Go: foo.go:10:5: error: ...
      match = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning|note|fatal error):\s*(.+)/i);
    }
    if (!match) {
      // Simple file:line: message (pytest, generic)
      match = line.match(/^(.+?):(\d+):\s*(error|Error|FAIL|FAILED|E\s)(.+)/);
      if (match) {
        match = [match[0], match[1], match[2], '1', 'error', match[4].trim()];
      }
    }
    if (!match) {
      // Rust: error[E0308]: ...  at --> src/main.rs:10:5
      match = line.match(/^\s*--> (.+?):(\d+):(\d+)/);
      if (match) {
        match = [match[0], match[1], match[2], match[3], 'error', 'see above'];
      }
    }

    if (match) {
      const key = `${match[1]}:${match[2]}:${(match[5] || '').slice(0, 80)}`;
      if (!seen.has(key)) {
        seen.add(key);
        diagnostics.push({
          file: match[1].trim(),
          line: Number(match[2]),
          column: Number(match[3]) || 1,
          category: String(match[4]).toLowerCase().startsWith('warn') ? 'warning' : 'error',
          message: String(match[5]).trim()
        });
      }
    }
  }

  return diagnostics;
}

// ── TypeScript ────────────────────────────────────────────────────────────

describe('parseDiagnosticOutput - TypeScript', () => {
  test('parses TSC parentheses format', () => {
    const r = parseDiagnosticOutput('src/index.ts(10,5): error TS2345: Argument of type string');
    assert.equal(r.length, 1);
    assert.equal(r[0].file, 'src/index.ts');
    assert.equal(r[0].line, 10);
    assert.equal(r[0].column, 5);
    assert.equal(r[0].category, 'error');
  });

  test('parses TSC colon-dash format', () => {
    const r = parseDiagnosticOutput('src/utils.ts:20:3 - error TS2304: Cannot find name foo');
    assert.equal(r.length, 1);
    assert.equal(r[0].file, 'src/utils.ts');
    assert.equal(r[0].line, 20);
    assert.equal(r[0].column, 3);
  });
});

// ── GCC / Clang ───────────────────────────────────────────────────────────

describe('parseDiagnosticOutput - GCC/Clang', () => {
  test('parses error and warning', () => {
    const input = 'main.c:42:8: error: expected ; before } token\nmain.c:50:1: warning: unused variable x';
    const r = parseDiagnosticOutput(input);
    assert.equal(r.length, 2);
    assert.equal(r[0].category, 'error');
    assert.equal(r[1].category, 'warning');
    assert.equal(r[0].line, 42);
    assert.equal(r[1].line, 50);
  });
});

// ── Go ────────────────────────────────────────────────────────────────────

describe('parseDiagnosticOutput - Go', () => {
  test('parses Go compiler errors', () => {
    const r = parseDiagnosticOutput('./main.go:15:2: error: undefined: foo');
    assert.equal(r.length, 1);
    assert.equal(r[0].file, './main.go');
    assert.equal(r[0].line, 15);
  });
});

// ── Rust ──────────────────────────────────────────────────────────────────

describe('parseDiagnosticOutput - Rust', () => {
  test('parses Rust --> location markers', () => {
    const input = 'error[E0308]: mismatched types\n --> src/main.rs:10:5\n --> src/lib.rs:20:12';
    const r = parseDiagnosticOutput(input);
    assert.equal(r.length, 2);
    assert.equal(r[0].file, 'src/main.rs');
    assert.equal(r[1].file, 'src/lib.rs');
  });
});

// ── Python / pytest ───────────────────────────────────────────────────────

describe('parseDiagnosticOutput - pytest', () => {
  test('parses pytest error lines', () => {
    const input = 'tests/test_auth.py:42: Error assert 1 == 2\ntests/test_api.py:10: FAIL expected 200';
    const r = parseDiagnosticOutput(input);
    assert.equal(r.length, 2);
  });
});

// ── ESLint ────────────────────────────────────────────────────────────────

describe('parseDiagnosticOutput - ESLint', () => {
  test('parses ESLint warning format', () => {
    const r = parseDiagnosticOutput('src/app.js:5:10: warning Unexpected console statement no-console');
    assert.equal(r.length, 1);
    assert.equal(r[0].category, 'warning');
    assert.equal(r[0].file, 'src/app.js');
  });
});

// ── Deduplication ─────────────────────────────────────────────────────────

describe('parseDiagnosticOutput - dedup', () => {
  test('deduplicates identical diagnostics', () => {
    const input = 'src/a.ts:1:1: error: foo\nsrc/a.ts:1:1: error: foo';
    const r = parseDiagnosticOutput(input);
    assert.equal(r.length, 1);
  });
});

// ── Clean output ──────────────────────────────────────────────────────────

describe('parseDiagnosticOutput - clean output', () => {
  test('returns empty for passing test output', () => {
    const r = parseDiagnosticOutput('All tests passed!\n12 passing (3s)');
    assert.equal(r.length, 0);
  });

  test('returns empty for empty string', () => {
    const r = parseDiagnosticOutput('');
    assert.equal(r.length, 0);
  });
});
