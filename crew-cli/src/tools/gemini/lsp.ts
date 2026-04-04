/**
 * @license
 * Copyright 2026 CrewSwarm
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LSPTool — Language Server Protocol code intelligence tool.
 * Supports: diagnostics, definition, references, hover, completions.
 * Uses typescript language service when available; falls back to grep-based
 * symbol lookup for JS/Python/Go and other languages.
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import { LSP_TOOL_NAME } from './tool-names.js';
import type { Config } from '../config/config.js';

// ---------------------------------------------------------------------------
// Parameter interface
// ---------------------------------------------------------------------------

export interface LspToolParams {
  /** The LSP action to perform */
  action: 'diagnostics' | 'definition' | 'references' | 'hover' | 'completions';
  /** Target file path (relative or absolute) */
  file: string;
  /** 1-based line number (required for definition/references/hover/completions) */
  line?: number;
  /** 1-based column number */
  column?: number;
  /** Symbol name (alternative to line/column for references) */
  symbol?: string;
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const LSP_PARAMS_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['diagnostics', 'definition', 'references', 'hover', 'completions'],
      description: 'The LSP action to perform',
    },
    file: {
      type: 'string',
      description: 'Path to the source file (relative to workspace root)',
    },
    line: {
      type: 'number',
      description: '1-based line number (required for definition/references/hover/completions)',
    },
    column: {
      type: 'number',
      description: '1-based column number',
    },
    symbol: {
      type: 'string',
      description: 'Symbol name for grep-based reference lookups',
    },
  },
  required: ['action', 'file'],
};

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

class LspToolInvocation extends BaseToolInvocation<LspToolParams, ToolResult> {
  constructor(
    private readonly config: Config,
    params: LspToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  getDescription(): string {
    const { action, file, line, column, symbol } = this.params;
    const loc = line != null ? `:${line}${column != null ? `:${column}` : ''}` : '';
    return `lsp ${action} ${file}${loc}${symbol ? ` (${symbol})` : ''}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { action, file, line, column, symbol } = this.params;
    const workspaceRoot = this.config.getTargetDir();
    const absFile = path.isAbsolute(file)
      ? file
      : path.resolve(workspaceRoot, file);

    try {
      switch (action) {
        case 'diagnostics':
          return await this.runDiagnostics(workspaceRoot, absFile);
        case 'definition':
          return await this.runDefinition(workspaceRoot, absFile, line, column, symbol);
        case 'references':
          return await this.runReferences(workspaceRoot, absFile, line, column, symbol);
        case 'hover':
          return await this.runHover(workspaceRoot, absFile, line, column);
        case 'completions':
          return await this.runCompletions(workspaceRoot, absFile, line, column);
        default:
          return { llmContent: `Unknown action: ${action}`, returnDisplay: `Unknown action: ${action}` };
      }
    } catch (err: any) {
      return {
        llmContent: `LSP error: ${err?.message || String(err)}`,
        returnDisplay: `LSP error: ${err?.message || String(err)}`,
        error: { message: err?.message || String(err), type: undefined as any },
      };
    }
  }

  // ---- diagnostics ----------------------------------------------------------

  private async runDiagnostics(workspaceRoot: string, absFile: string): Promise<ToolResult> {
    const ext = path.extname(absFile).toLowerCase();
    const isTs = ext === '.ts' || ext === '.tsx';
    const isJs = ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs';

    if (isTs || isJs) {
      // Try TypeScript language service first
      try {
        const lsp = await import('../../lsp/index.js');
        const diagnostics = await lsp.typeCheckProject(workspaceRoot, [absFile]);
        if (diagnostics.length === 0) {
          return { llmContent: 'No diagnostics found.', returnDisplay: 'No diagnostics.' };
        }
        const output = diagnostics
          .map(d => `${d.file}:${d.line}:${d.column} [${d.category}] TS${d.code}: ${d.message}`)
          .join('\n');
        return { llmContent: output, returnDisplay: output };
      } catch {
        // Fall through to tsc fallback
      }

      // tsc --noEmit fallback
      try {
        const out = execSync(`npx tsc --noEmit 2>&1 || true`, {
          cwd: workspaceRoot,
          encoding: 'utf8',
          timeout: 30000,
        });
        const filtered = out
          .split('\n')
          .filter(line => line.includes(path.basename(absFile)) || line.includes('error TS'))
          .join('\n')
          .trim();
        const result = filtered || 'No diagnostics found.';
        return { llmContent: result, returnDisplay: result };
      } catch (err: any) {
        return { llmContent: `tsc failed: ${err.message}`, returnDisplay: `tsc failed: ${err.message}` };
      }
    }

    // Non-TS/JS: try language-specific lint tools
    if (ext === '.py') {
      try {
        const out = execSync(`python -m py_compile ${JSON.stringify(absFile)} 2>&1 || true`, {
          cwd: workspaceRoot,
          encoding: 'utf8',
          timeout: 10000,
        });
        const result = out.trim() || 'No syntax errors found.';
        return { llmContent: result, returnDisplay: result };
      } catch (err: any) {
        return { llmContent: `py_compile failed: ${err.message}`, returnDisplay: `py_compile error` };
      }
    }

    return {
      llmContent: `Diagnostics not supported for ${ext} files. Supported: .ts, .tsx, .js, .jsx, .py`,
      returnDisplay: `Diagnostics not supported for ${ext}`,
    };
  }

  // ---- definition -----------------------------------------------------------

  private async runDefinition(
    workspaceRoot: string,
    absFile: string,
    line?: number,
    column?: number,
    symbol?: string,
  ): Promise<ToolResult> {
    const ext = path.extname(absFile).toLowerCase();
    const isTs = ext === '.ts' || ext === '.tsx';
    const isJs = ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs';

    if ((isTs || isJs) && line != null) {
      try {
        const lsp = await import('../../lsp/index.js');
        const defs = await lsp.getDefinitions(workspaceRoot, absFile, line, column ?? 1);
        if (defs.length === 0) {
          return { llmContent: 'No definition found.', returnDisplay: 'No definition found.' };
        }
        const output = defs.map(d => `${d.file}:${d.line}:${d.column}`).join('\n');
        return { llmContent: output, returnDisplay: output };
      } catch {
        // Fall through to grep fallback
      }
    }

    // Grep-based fallback: find export declarations of the symbol
    const sym = symbol || (await this.extractSymbolAtPosition(absFile, line, column));
    if (!sym) {
      return {
        llmContent: 'Could not determine symbol. Provide symbol parameter or valid line/column.',
        returnDisplay: 'Symbol not found.',
      };
    }
    return this.grepDefinition(workspaceRoot, sym);
  }

  // ---- references -----------------------------------------------------------

  private async runReferences(
    workspaceRoot: string,
    absFile: string,
    line?: number,
    column?: number,
    symbol?: string,
  ): Promise<ToolResult> {
    const ext = path.extname(absFile).toLowerCase();
    const isTs = ext === '.ts' || ext === '.tsx';
    const isJs = ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs';

    if ((isTs || isJs) && line != null) {
      try {
        const lsp = await import('../../lsp/index.js');
        const refs = await lsp.getReferences(workspaceRoot, absFile, line, column ?? 1);
        if (refs.length === 0) {
          return { llmContent: 'No references found.', returnDisplay: 'No references found.' };
        }
        const output = refs.map(r => `${r.file}:${r.line}:${r.column}`).join('\n');
        return { llmContent: output, returnDisplay: output };
      } catch {
        // Fall through to grep fallback
      }
    }

    const sym = symbol || (await this.extractSymbolAtPosition(absFile, line, column));
    if (!sym) {
      return {
        llmContent: 'Could not determine symbol. Provide symbol parameter or valid line/column.',
        returnDisplay: 'Symbol not found.',
      };
    }

    // Grep for all usages of the symbol
    try {
      const out = execSync(
        `grep -rn --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" --include="*.py" --include="*.go" "\\b${sym}\\b" .`,
        { cwd: workspaceRoot, encoding: 'utf8', timeout: 15000 },
      );
      const result = out.trim() || 'No references found.';
      return { llmContent: result, returnDisplay: result };
    } catch (err: any) {
      // grep exit code 1 means no matches (not an error)
      if (err?.status === 1) {
        return { llmContent: 'No references found.', returnDisplay: 'No references found.' };
      }
      return { llmContent: `grep failed: ${err.message}`, returnDisplay: `grep failed` };
    }
  }

  // ---- hover ----------------------------------------------------------------

  private async runHover(
    workspaceRoot: string,
    absFile: string,
    line?: number,
    column?: number,
  ): Promise<ToolResult> {
    if (line == null) {
      return { llmContent: 'hover requires line parameter', returnDisplay: 'hover requires line' };
    }
    const ext = path.extname(absFile).toLowerCase();
    const isTs = ext === '.ts' || ext === '.tsx';
    const isJs = ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs';

    if (isTs || isJs) {
      try {
        const lsp = await import('../../lsp/index.js');
        // getDocumentSymbols gives type info per file; for hover we inspect symbols near the position
        const symbols = await lsp.getDocumentSymbols(workspaceRoot, absFile);
        const near = symbols.filter(s => Math.abs(s.line - line) <= 1);
        if (near.length > 0) {
          const output = near.map(s => `${s.kind} ${s.name} (line ${s.line}:${s.column})`).join('\n');
          return { llmContent: output, returnDisplay: output };
        }
        return { llmContent: 'No type information found at this position.', returnDisplay: 'No type info.' };
      } catch (err: any) {
        return { llmContent: `hover failed: ${err.message}`, returnDisplay: `hover failed` };
      }
    }

    // Fallback: show the line itself
    try {
      const { readFileSync } = await import('node:fs');
      const content = readFileSync(absFile, 'utf8');
      const lines = content.split('\n');
      const targetLine = lines[(line - 1)] || '';
      return { llmContent: targetLine, returnDisplay: targetLine };
    } catch (err: any) {
      return { llmContent: `Could not read file: ${err.message}`, returnDisplay: `Read error` };
    }
  }

  // ---- completions ----------------------------------------------------------

  private async runCompletions(
    workspaceRoot: string,
    absFile: string,
    line?: number,
    column?: number,
  ): Promise<ToolResult> {
    if (line == null || column == null) {
      return { llmContent: 'completions requires line and column parameters', returnDisplay: 'completions requires line and column' };
    }
    const ext = path.extname(absFile).toLowerCase();
    const isTs = ext === '.ts' || ext === '.tsx';
    const isJs = ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs';

    if (isTs || isJs) {
      try {
        const lsp = await import('../../lsp/index.js');
        const items = await lsp.getCompletions(workspaceRoot, absFile, line, column, 30, '');
        if (items.length === 0) {
          return { llmContent: 'No completions found.', returnDisplay: 'No completions.' };
        }
        const output = items.map(i => `${i.name} (${i.kind})`).join('\n');
        return { llmContent: output, returnDisplay: output };
      } catch (err: any) {
        return { llmContent: `completions failed: ${err.message}`, returnDisplay: `completions failed` };
      }
    }

    return {
      llmContent: `Completions not supported for ${path.extname(absFile)} files.`,
      returnDisplay: `Completions not supported.`,
    };
  }

  // ---- helpers --------------------------------------------------------------

  /** Extract word at line:column from a file */
  private async extractSymbolAtPosition(
    absFile: string,
    line?: number,
    column?: number,
  ): Promise<string | null> {
    if (line == null) return null;
    try {
      const { readFileSync } = await import('node:fs');
      const content = readFileSync(absFile, 'utf8');
      const lines = content.split('\n');
      const targetLine = lines[(line - 1)] || '';
      const col = (column ?? 1) - 1;
      // Walk back and forward to find word boundaries
      let start = col;
      let end = col;
      const wordChar = /\w/;
      while (start > 0 && wordChar.test(targetLine[start - 1])) start--;
      while (end < targetLine.length && wordChar.test(targetLine[end])) end++;
      const word = targetLine.slice(start, end);
      return word || null;
    } catch {
      return null;
    }
  }

  /** Grep for definition pattern: export function/class/const/interface NAME */
  private grepDefinition(workspaceRoot: string, symbol: string): ToolResult {
    const patterns = [
      `export (function|class|const|let|var|interface|type|enum) ${symbol}`,
      `def ${symbol}\\b`,        // Python
      `func ${symbol}\\b`,       // Go
      `function ${symbol}\\b`,   // JS unqualified
    ];
    const pattern = patterns.join('|');
    try {
      const out = execSync(`grep -rn -E "${pattern}" .`, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        timeout: 15000,
      });
      const result = out.trim() || 'No definition found.';
      return { llmContent: result, returnDisplay: result };
    } catch (err: any) {
      if (err?.status === 1) {
        return { llmContent: 'No definition found.', returnDisplay: 'No definition found.' };
      }
      return { llmContent: `grep failed: ${err.message}`, returnDisplay: `grep failed` };
    }
  }
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class LspTool extends BaseDeclarativeTool<LspToolParams, ToolResult> {
  static readonly Name = LSP_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      LspTool.Name,
      'LSP',
      'Language Server Protocol tool for code intelligence: get diagnostics (type errors, lint), go-to-definition, find references, hover type info, and completions. Uses TypeScript language service when available; falls back to grep-based symbol lookup.',
      Kind.Read,
      LSP_PARAMS_SCHEMA,
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(params: LspToolParams): string | null {
    if (!params.file?.trim()) {
      return "The 'file' parameter must be non-empty.";
    }
    const positionActions: LspToolParams['action'][] = ['hover', 'completions'];
    if (positionActions.includes(params.action) && params.line == null) {
      return `Action '${params.action}' requires the 'line' parameter.`;
    }
    return null;
  }

  protected createInvocation(
    params: LspToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<LspToolParams, ToolResult> {
    return new LspToolInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}
