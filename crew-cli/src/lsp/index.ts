import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface TsSystem {
  fileExists(path: string): boolean;
  readFile(path: string): string | undefined;
  readDirectory(...args: unknown[]): string[];
  directoryExists(path: string): boolean;
  getDirectories(path: string): string[];
}

interface TsScriptSnapshot {
  fromString(text: string): unknown;
}

interface TsSourceFile {
  fileName: string;
  getLineAndCharacterOfPosition(pos: number): { line: number; character: number };
}

interface TsProgram {
  getSourceFile(fileName: string): TsSourceFile | undefined;
}

interface TsLanguageService {
  dispose(): void;
  getCompletionsAtPosition(fileName: string, position: number, options: Record<string, unknown>): { entries?: Array<Record<string, unknown>> } | undefined;
  getDefinitionAtPosition(fileName: string, position: number): Array<Record<string, unknown> & { fileName: string; textSpan: { start: number } }> | undefined;
  getReferencesAtPosition(fileName: string, position: number): Array<Record<string, unknown> & { fileName: string; textSpan: { start: number } }> | undefined;
  getNavigationTree(fileName: string): Record<string, unknown>;
  getProgram(): TsProgram | undefined;
}

interface TsApi {
  sys: TsSystem;
  ScriptSnapshot: TsScriptSnapshot;
  findConfigFile(root: string, exists: (path: string) => boolean, configName: string): string | undefined;
  readConfigFile(configPath: string, readFile: (path: string) => string | undefined): { error?: { messageText: unknown }; config: Record<string, unknown> };
  flattenDiagnosticMessageText(messageText: unknown, newline: string): string;
  parseJsonConfigFileContent(config: Record<string, unknown>, sys: TsSystem, basePath: string): {
    errors: Array<{ messageText: unknown }>;
    options: unknown;
    fileNames: string[];
  };
  createCompilerHost(options: unknown, setParentNodes: boolean): unknown;
  createProgram(fileNames: string[], options: unknown, host: unknown): unknown;
  getPreEmitDiagnostics(program: unknown): Array<{
    file?: TsSourceFile;
    start?: number;
    code: number;
    category: number;
    messageText: unknown;
  }>;
  getDefaultLibFilePath(options: unknown): string;
  createLanguageService(serviceHost: Record<string, unknown>): TsLanguageService;
}

// Lazy-load typescript to avoid blocking ESM module init on Node 24+
// (Node 24 ESM resolver can't resolve `import ts from 'typescript'` at top level)
let _ts: TsApi | undefined;
async function ensureTs(): Promise<TsApi> {
  if (!_ts) {
    _ts = await import('typescript').then((m: { default?: unknown }) => (m.default ?? m) as TsApi);
  }
  return _ts as TsApi;
}

export interface LspDiagnostic {
  file: string;
  line: number;
  column: number;
  code: number;
  category: 'error' | 'warning' | 'suggestion' | 'message';
  message: string;
}

export interface LspCompletion {
  name: string;
  kind: string;
  sortText?: string;
}

export interface LspLocation {
  file: string;
  line: number;
  column: number;
}

export interface LspSymbol {
  name: string;
  kind: string;
  line: number;
  column: number;
}

interface LoadedProject {
  root: string;
  // CompilerOptions from the TypeScript API — typed as unknown because TypeScript is a dynamic import
  options: unknown;
  fileNames: string[];
}

function categoryToText(cat: number): LspDiagnostic['category'] {
  // ts.DiagnosticCategory.Error = 1, Warning = 0, Suggestion = 2, Message = 3
  if (cat === 1) return 'error';
  if (cat === 0) return 'warning';
  if (cat === 2) return 'suggestion';
  return 'message';
}

function loadProject(projectDir: string, ts: TsApi): LoadedProject {
  const root = resolve(projectDir);
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) {
    throw new Error(`No tsconfig.json found at or above ${root}`);
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(configPath)
  );
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0];
    throw new Error(ts.flattenDiagnosticMessageText(first.messageText, '\n'));
  }

  return {
    root,
    options: parsed.options,
    fileNames: parsed.fileNames
  };
}

export async function typeCheckProject(projectDir: string, includeFiles: string[] = []): Promise<LspDiagnostic[]> {
  const ts = await ensureTs();
  const project = loadProject(projectDir, ts);
  const includeAbs = new Set(includeFiles.map(x => resolve(project.root, x)));
  const shouldFilter = includeAbs.size > 0;
  const host = ts.createCompilerHost(project.options, true);
  const program = ts.createProgram(project.fileNames, project.options, host);

  const diagnostics = ts.getPreEmitDiagnostics(program);
  const out: LspDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const sourceFile = diagnostic.file;
    if (!sourceFile) continue;
    const absFile = resolve(sourceFile.fileName);
    if (shouldFilter && !includeAbs.has(absFile)) continue;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    out.push({
      file: absFile,
      line: line + 1,
      column: character + 1,
      code: diagnostic.code,
      category: categoryToText(diagnostic.category),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    });
  }
  return out;
}

function kindToText(kind: unknown): string {
  return String(kind || 'unknown');
}

function createLanguageService(projectDir: string, ts: TsApi) {
  const project = loadProject(projectDir, ts);
  const sourceTexts = new Map<string, { version: number; text: string }>();
  for (const file of project.fileNames) {
    const text = ts.sys.readFile(file) || '';
    sourceTexts.set(resolve(file), { version: 1, text });
  }

  const serviceHost = {
    getCompilationSettings: () => project.options,
    getScriptFileNames: () => Array.from(sourceTexts.keys()),
    getScriptVersion: (fileName: string) => String(sourceTexts.get(resolve(fileName))?.version || 1),
    getScriptSnapshot: (fileName: string) => {
      const resolved = resolve(fileName);
      const entry = sourceTexts.get(resolved);
      if (!entry) return undefined;
      return ts.ScriptSnapshot.fromString(entry.text);
    },
    getCurrentDirectory: () => project.root,
    getDefaultLibFileName: (options: unknown) => (ts as { getDefaultLibFilePath(o: unknown): string }).getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories
  };

  const service = ts.createLanguageService(serviceHost);
  return { service, project, sourceTexts };
}

function lineColToPosition(text: string, line: number, column: number): number {
  const lines = text.split('\n');
  const lineIndex = Math.max(0, line - 1);
  const offset = lines.slice(0, lineIndex).reduce((sum: number, x: string) => sum + x.length + 1, 0) + Math.max(0, column - 1);
  return Math.min(offset, text.length);
}

export async function getCompletions(
  projectDir: string,
  filePath: string,
  line: number,
  column: number,
  limit = 50,
  prefix = ''
): Promise<LspCompletion[]> {
  const ts = await ensureTs();
  const { service, project, sourceTexts } = createLanguageService(projectDir, ts);
  try {
    const absFile = resolve(project.root, filePath);
    if (!existsSync(absFile)) {
      throw new Error(`File not found: ${absFile}`);
    }

    if (!sourceTexts.has(absFile)) {
      sourceTexts.set(absFile, { version: 1, text: ts.sys.readFile(absFile) || '' });
    }

    const fileText = sourceTexts.get(absFile)?.text || '';
    const lines = fileText.split('\n');
    const lineIndex = Math.max(0, line - 1);
    const safeLine = lines[lineIndex] || '';
    const offset = lines.slice(0, lineIndex).reduce((sum: number, x: string) => sum + x.length + 1, 0) + Math.max(0, column - 1);
    const position = Math.min(offset, fileText.length);

    const completions = service.getCompletionsAtPosition(absFile, position, {
      includeCompletionsWithInsertText: true,
      includeCompletionsForModuleExports: true
    });

    const items = (completions?.entries || []).filter((entry: Record<string, unknown>) => {
      if (!prefix) return true;
      return String(entry.name || '').toLowerCase().startsWith(prefix.toLowerCase());
    });

    return items.slice(0, Math.max(1, limit)).map((entry: Record<string, unknown>) => ({
      name: String(entry.name || ''),
      kind: kindToText(entry.kind),
      sortText: entry.sortText as string | undefined
    }));
  } finally {
    service.dispose();
  }
}

export async function getDefinitions(projectDir: string, filePath: string, line: number, column: number): Promise<LspLocation[]> {
  const ts = await ensureTs();
  const { service, project, sourceTexts } = createLanguageService(projectDir, ts);
  try {
    const absFile = resolve(project.root, filePath);
    const fileText = sourceTexts.get(absFile)?.text || ts.sys.readFile(absFile) || '';
    const position = lineColToPosition(fileText, line, column);
    const defs = service.getDefinitionAtPosition(absFile, position) || [];
    return defs.map((def: Record<string, unknown> & { fileName: string; textSpan: { start: number } }) => {
      const sf = service.getProgram()?.getSourceFile(def.fileName);
      const lc = sf?.getLineAndCharacterOfPosition(def.textSpan.start) || { line: 0, character: 0 };
      return {
        file: resolve(def.fileName),
        line: lc.line + 1,
        column: lc.character + 1
      };
    });
  } finally {
    service.dispose();
  }
}

export async function getReferences(projectDir: string, filePath: string, line: number, column: number): Promise<LspLocation[]> {
  const ts = await ensureTs();
  const { service, project, sourceTexts } = createLanguageService(projectDir, ts);
  try {
    const absFile = resolve(project.root, filePath);
    const fileText = sourceTexts.get(absFile)?.text || ts.sys.readFile(absFile) || '';
    const position = lineColToPosition(fileText, line, column);
    const refs = service.getReferencesAtPosition(absFile, position) || [];
    return refs.map((ref: Record<string, unknown> & { fileName: string; textSpan: { start: number } }) => {
      const sf = service.getProgram()?.getSourceFile(ref.fileName);
      const lc = sf?.getLineAndCharacterOfPosition(ref.textSpan.start) || { line: 0, character: 0 };
      return {
        file: resolve(ref.fileName),
        line: lc.line + 1,
        column: lc.character + 1
      };
    });
  } finally {
    service.dispose();
  }
}

export async function getDocumentSymbols(projectDir: string, filePath: string): Promise<LspSymbol[]> {
  const ts = await ensureTs();
  const { service, project } = createLanguageService(projectDir, ts);
  try {
    const absFile = resolve(project.root, filePath);
    const nav = service.getNavigationTree(absFile);
    const out: LspSymbol[] = [];
    const walk = (node: Record<string, unknown> & { spans?: Array<{ start: number }>; text?: string; kind?: unknown; childItems?: unknown[] }) => {
      for (const span of node.spans || []) {
        const sf = service.getProgram()?.getSourceFile(absFile);
        const lc = sf?.getLineAndCharacterOfPosition(span.start) || { line: 0, character: 0 };
        if (node.text && node.text !== '<global>') {
          out.push({
            name: node.text,
            kind: String(node.kind || 'unknown'),
            line: lc.line + 1,
            column: lc.character + 1
          });
        }
      }
      for (const child of node.childItems || []) {
        walk(child as Record<string, unknown> & { spans?: Array<{ start: number }>; text?: string; kind?: unknown; childItems?: unknown[] });
      }
    };
    walk(nav);
    return out;
  } finally {
    service.dispose();
  }
}
