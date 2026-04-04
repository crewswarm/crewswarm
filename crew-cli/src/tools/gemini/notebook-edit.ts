/**
 * @license
 * Copyright 2026 crewswarm
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * NotebookEditTool — Edit Jupyter notebooks (.ipynb files).
 * Supports: add_cell, edit_cell, delete_cell, run_cell, read.
 * .ipynb files are JSON; we read, modify, and write back.
 */

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { execSync } from 'node:child_process';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolResult,
} from './tools.js';
import { NOTEBOOK_EDIT_TOOL_NAME } from './tool-names.js';
import type { Config } from '../config/config.js';

// ---------------------------------------------------------------------------
// Notebook types (minimal subset of .ipynb format)
// ---------------------------------------------------------------------------

interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface NotebookDocument {
  nbformat: number;
  nbformat_minor: number;
  metadata?: Record<string, unknown>;
  cells: NotebookCell[];
}

// ---------------------------------------------------------------------------
// Parameter interface
// ---------------------------------------------------------------------------

export interface NotebookEditToolParams {
  /** The action to perform */
  action: 'add_cell' | 'edit_cell' | 'delete_cell' | 'run_cell' | 'read';
  /** Path to the .ipynb file */
  path: string;
  /** Cell index (0-based) for edit_cell, delete_cell, run_cell */
  index?: number;
  /** Cell type for add_cell */
  cell_type?: 'code' | 'markdown';
  /** Source content for add_cell and edit_cell */
  content?: string;
}

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const NOTEBOOK_EDIT_PARAMS_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['add_cell', 'edit_cell', 'delete_cell', 'run_cell', 'read'],
      description: 'The notebook action to perform',
    },
    path: {
      type: 'string',
      description: 'Path to the .ipynb notebook file (relative to workspace root)',
    },
    index: {
      type: 'number',
      description: '0-based cell index (required for edit_cell, delete_cell, run_cell; optional for add_cell to insert at position)',
    },
    cell_type: {
      type: 'string',
      enum: ['code', 'markdown'],
      description: 'Cell type for add_cell (default: code)',
    },
    content: {
      type: 'string',
      description: 'Cell source content for add_cell and edit_cell',
    },
  },
  required: ['action', 'path'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sourceToLines(content: string): string[] {
  // Store source as array of lines (with \n except last), matching ipynb convention
  const raw = content ?? '';
  if (raw === '') return [];
  const lines = raw.split('\n');
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line));
}

function linesToSource(source: string[]): string {
  return source.join('');
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

class NotebookEditToolInvocation extends BaseToolInvocation<NotebookEditToolParams, ToolResult> {
  private readonly resolvedPath: string;

  constructor(
    private readonly config: Config,
    params: NotebookEditToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
    this.resolvedPath = path.isAbsolute(params.path)
      ? params.path
      : path.resolve(this.config.getTargetDir(), params.path);
  }

  getDescription(): string {
    const { action, path: p, index, cell_type } = this.params;
    const idx = index != null ? `[${index}]` : '';
    const ct = cell_type ? ` (${cell_type})` : '';
    return `notebook-edit ${action} ${p}${idx}${ct}`;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    const { action } = this.params;

    try {
      switch (action) {
        case 'read':
          return await this.readNotebook();
        case 'add_cell':
          return await this.addCell();
        case 'edit_cell':
          return await this.editCell();
        case 'delete_cell':
          return await this.deleteCell();
        case 'run_cell':
          return await this.runCell();
        default:
          return { llmContent: `Unknown action: ${action}`, returnDisplay: `Unknown action: ${action}` };
      }
    } catch (err) {
      return {
        llmContent: `NotebookEdit error: ${err?.message || String(err)}`,
        returnDisplay: `NotebookEdit error: ${err?.message || String(err)}`,
        error: { message: err?.message || String(err), type: undefined as any },
      };
    }
  }

  // ---- read -----------------------------------------------------------------

  private async readNotebook(): Promise<ToolResult> {
    const nb = await this.loadNotebook();
    const summary = nb.cells.map((cell, i) => {
      const src = linesToSource(cell.source).slice(0, 200);
      const outputs = Array.isArray(cell.outputs) && cell.outputs.length > 0
        ? ` [${cell.outputs.length} output(s)]`
        : '';
      return `[${i}] ${cell.cell_type}${outputs}:\n${src}`;
    }).join('\n\n');
    const result = `Notebook: ${this.params.path}\nFormat: ${nb.nbformat}.${nb.nbformat_minor}\nCells: ${nb.cells.length}\n\n${summary}`;
    return { llmContent: result, returnDisplay: result };
  }

  // ---- add_cell -------------------------------------------------------------

  private async addCell(): Promise<ToolResult> {
    const { content, cell_type, index } = this.params;
    if (content == null) {
      return { llmContent: "add_cell requires 'content' parameter", returnDisplay: "add_cell requires content" };
    }
    const nb = await this.loadNotebook();
    const newCell: NotebookCell = {
      cell_type: cell_type ?? 'code',
      source: sourceToLines(content),
      metadata: {},
      outputs: [],
      execution_count: null,
    };
    if (index != null && index >= 0 && index <= nb.cells.length) {
      nb.cells.splice(index, 0, newCell);
    } else {
      nb.cells.push(newCell);
    }
    await this.saveNotebook(nb);
    const insertedAt = index != null ? index : nb.cells.length - 1;
    const msg = `Added ${newCell.cell_type} cell at index ${insertedAt}`;
    return { llmContent: msg, returnDisplay: msg };
  }

  // ---- edit_cell ------------------------------------------------------------

  private async editCell(): Promise<ToolResult> {
    const { index, content } = this.params;
    if (index == null) {
      return { llmContent: "edit_cell requires 'index' parameter", returnDisplay: "edit_cell requires index" };
    }
    if (content == null) {
      return { llmContent: "edit_cell requires 'content' parameter", returnDisplay: "edit_cell requires content" };
    }
    const nb = await this.loadNotebook();
    if (index < 0 || index >= nb.cells.length) {
      return {
        llmContent: `Cell index ${index} out of range (notebook has ${nb.cells.length} cells)`,
        returnDisplay: `Cell index out of range`,
      };
    }
    nb.cells[index].source = sourceToLines(content);
    // Clear outputs when editing code cells (stale outputs are misleading)
    if (nb.cells[index].cell_type === 'code') {
      nb.cells[index].outputs = [];
      nb.cells[index].execution_count = null;
    }
    await this.saveNotebook(nb);
    const msg = `Edited cell ${index}`;
    return { llmContent: msg, returnDisplay: msg };
  }

  // ---- delete_cell ----------------------------------------------------------

  private async deleteCell(): Promise<ToolResult> {
    const { index } = this.params;
    if (index == null) {
      return { llmContent: "delete_cell requires 'index' parameter", returnDisplay: "delete_cell requires index" };
    }
    const nb = await this.loadNotebook();
    if (index < 0 || index >= nb.cells.length) {
      return {
        llmContent: `Cell index ${index} out of range (notebook has ${nb.cells.length} cells)`,
        returnDisplay: `Cell index out of range`,
      };
    }
    nb.cells.splice(index, 1);
    await this.saveNotebook(nb);
    const msg = `Deleted cell ${index} (${nb.cells.length} cells remaining)`;
    return { llmContent: msg, returnDisplay: msg };
  }

  // ---- run_cell -------------------------------------------------------------

  private async runCell(): Promise<ToolResult> {
    const { index } = this.params;
    if (index == null) {
      return { llmContent: "run_cell requires 'index' parameter", returnDisplay: "run_cell requires index" };
    }
    const nb = await this.loadNotebook();
    if (index < 0 || index >= nb.cells.length) {
      return {
        llmContent: `Cell index ${index} out of range`,
        returnDisplay: `Cell index out of range`,
      };
    }
    const cell = nb.cells[index];
    if (cell.cell_type !== 'code') {
      return {
        llmContent: `Cell ${index} is a ${cell.cell_type} cell, only code cells can be run`,
        returnDisplay: `Cannot run non-code cell`,
      };
    }
    const src = linesToSource(cell.source);

    // Try jupyter nbconvert --execute approach on a temp copy
    try {
      const tmpDir = await fsPromises.mkdtemp(path.join(path.dirname(this.resolvedPath), '.nb-run-'));
      const tmpNb = path.join(tmpDir, 'run.ipynb');
      // Write a single-cell notebook
      const singleCell: NotebookDocument = {
        nbformat: nb.nbformat,
        nbformat_minor: nb.nbformat_minor,
        metadata: nb.metadata,
        cells: [{ ...cell, outputs: [], execution_count: null }],
      };
      await fsPromises.writeFile(tmpNb, JSON.stringify(singleCell, null, 2), 'utf8');
      try {
        execSync(
          `jupyter nbconvert --to notebook --execute --inplace ${JSON.stringify(tmpNb)}`,
          { cwd: this.config.getTargetDir(), encoding: 'utf8', timeout: 60000 },
        );
        const executed = JSON.parse(await fsPromises.readFile(tmpNb, 'utf8')) as NotebookDocument;
        const outputs = executed.cells[0]?.outputs ?? [];
        await fsPromises.rm(tmpDir, { recursive: true, force: true });

        // Update the original notebook's cell with new outputs
        nb.cells[index].outputs = outputs;
        nb.cells[index].execution_count = (nb.cells[index].execution_count ?? 0) + 1;
        await this.saveNotebook(nb);

        const outputText = this.formatOutputs(outputs);
        const result = `Cell ${index} executed.\n${outputText}`;
        return { llmContent: result, returnDisplay: result };
      } catch (jupyterErr: unknown) {
        await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        // Fall through to python -c fallback
      }
    } catch {
      // mkdtemp or other setup failed, fall through
    }

    // Fallback: python -c (no output capture into notebook, but returns stdout)
    try {
      const out = execSync(`python3 -c ${JSON.stringify(src)}`, {
        cwd: this.config.getTargetDir(),
        encoding: 'utf8',
        timeout: 30000,
      });
      const result = `Cell ${index} executed (via python3):\n${out.trim() || '(no output)'}`;
      return { llmContent: result, returnDisplay: result };
    } catch (pyErr: unknown) {
      const e = pyErr as { stderr?: { toString(): string }; message?: string };
      const stderr = e?.stderr?.toString?.()?.trim() || e?.message || 'execution failed';
      return { llmContent: `Cell ${index} execution failed:\n${stderr}`, returnDisplay: `Execution failed` };
    }
  }

  // ---- internal helpers -----------------------------------------------------

  private async loadNotebook(): Promise<NotebookDocument> {
    let raw: string;
    try {
      raw = await fsPromises.readFile(this.resolvedPath, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read notebook ${this.params.path}: ${err.message}`);
    }
    try {
      return JSON.parse(raw) as NotebookDocument;
    } catch {
      throw new Error(`${this.params.path} is not valid JSON (not a valid .ipynb file)`);
    }
  }

  private async saveNotebook(nb: NotebookDocument): Promise<void> {
    await fsPromises.mkdir(path.dirname(this.resolvedPath), { recursive: true });
    await fsPromises.writeFile(this.resolvedPath, JSON.stringify(nb, null, 1), 'utf8');
  }

  private formatOutputs(outputs: unknown[]): string {
    if (!Array.isArray(outputs) || outputs.length === 0) return '(no outputs)';
    return outputs.map((o: Record<string, unknown>) => {
      if (o.output_type === 'stream') {
        return `[${o.name}] ${Array.isArray(o.text) ? o.text.join('') : o.text}`;
      }
      if (o.output_type === 'execute_result' || o.output_type === 'display_data') {
        const txt = o.data?.['text/plain'];
        return Array.isArray(txt) ? txt.join('') : (txt ?? '');
      }
      if (o.output_type === 'error') {
        return `[error] ${o.ename}: ${o.evalue}`;
      }
      return JSON.stringify(o);
    }).join('\n');
  }
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

export class NotebookEditTool extends BaseDeclarativeTool<NotebookEditToolParams, ToolResult> {
  static readonly Name = NOTEBOOK_EDIT_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      NotebookEditTool.Name,
      'NotebookEdit',
      'Edit Jupyter notebooks (.ipynb files). Supports: read (view structure), add_cell (insert code/markdown), edit_cell (modify content by index), delete_cell (remove by index), run_cell (execute and capture output using jupyter or python3).',
      Kind.Write,
      NOTEBOOK_EDIT_PARAMS_SCHEMA,
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(params: NotebookEditToolParams): string | null {
    if (!params.path?.trim()) {
      return "The 'path' parameter must be non-empty.";
    }
    if (!params.path.endsWith('.ipynb')) {
      return "The 'path' parameter must point to a .ipynb file.";
    }
    if (params.action === 'add_cell' && params.content == null) {
      return "add_cell requires the 'content' parameter.";
    }
    if ((params.action === 'edit_cell' || params.action === 'delete_cell' || params.action === 'run_cell') && params.index == null) {
      return `${params.action} requires the 'index' parameter.`;
    }
    if (params.action === 'edit_cell' && params.content == null) {
      return "edit_cell requires the 'content' parameter.";
    }
    return null;
  }

  protected createInvocation(
    params: NotebookEditToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<NotebookEditToolParams, ToolResult> {
    return new NotebookEditToolInvocation(
      this.config,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }
}
