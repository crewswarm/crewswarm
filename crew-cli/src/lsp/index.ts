import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Lazy-load typescript to avoid blocking ESM module init on Node 24+
// (Node 24 ESM resolver can't resolve `import ts from 'typescript'` at top level)
let _ts: any;
async function ensureTs(): Promise<any> {
  if (!_ts) {
    _ts = await import('typescript').then(m => m.default ?? m);
  }
  return _ts;
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
  options: any;
  fileNames: string[];
}

function categoryToText(cat: number): LspDiagnostic['category'] {
  // ts.DiagnosticCategory.Error = 1, Warning = 0, Suggestion = 2, Message = 3
  if (cat === 1) return 'error';
  if (cat === 0) return 'warning';
  if (cat === 2) return 'suggestion';
  return 'message';
}

function loadProject(projectDir: string, ts: any): LoadedProject {
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

function kindToText(kind: any): string {
  return String(kind || 'unknown');
}

function createLanguageService(projectDir: string, ts: any) {
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
    getDefaultLibFileName: (options: any) => ts.getDefaultLibFilePath(options),
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

    const items = (completions?.entries || []).filter((entry: any) => {
      if (!prefix) return true;
      return entry.name.toLowerCase().startsWith(prefix.toLowerCase());
    });

    return items.slice(0, Math.max(1, limit)).map((entry: any) => ({
      name: entry.name,
      kind: kindToText(entry.kind),
      sortText: entry.sortText
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
    return defs.map((def: any) => {
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
    return refs.map((ref: any) => {
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
    const walk = (node: any) => {
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
      for (const child of node.childItems || []) walk(child);
    };
    walk(nav);
    return out;
  } finally {
    service.dispose();
  }
}
