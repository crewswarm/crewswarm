import ts from 'typescript';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

interface LoadedProject {
  root: string;
  options: ts.CompilerOptions;
  fileNames: string[];
}

function categoryToText(cat: ts.DiagnosticCategory): LspDiagnostic['category'] {
  if (cat === ts.DiagnosticCategory.Error) return 'error';
  if (cat === ts.DiagnosticCategory.Warning) return 'warning';
  if (cat === ts.DiagnosticCategory.Suggestion) return 'suggestion';
  return 'message';
}

function loadProject(projectDir: string): LoadedProject {
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

export function typeCheckProject(projectDir: string, includeFiles: string[] = []): LspDiagnostic[] {
  const project = loadProject(projectDir);
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

function kindToText(kind: ts.ScriptElementKind): string {
  return String(kind || 'unknown');
}

export function getCompletions(
  projectDir: string,
  filePath: string,
  line: number,
  column: number,
  limit = 50,
  prefix = ''
): LspCompletion[] {
  const project = loadProject(projectDir);
  const absFile = resolve(project.root, filePath);
  if (!existsSync(absFile)) {
    throw new Error(`File not found: ${absFile}`);
  }

  const sourceTexts = new Map<string, { version: number; text: string }>();
  for (const file of project.fileNames) {
    const text = ts.sys.readFile(file) || '';
    sourceTexts.set(resolve(file), { version: 1, text });
  }
  if (!sourceTexts.has(absFile)) {
    sourceTexts.set(absFile, { version: 1, text: ts.sys.readFile(absFile) || '' });
  }

  const serviceHost: ts.LanguageServiceHost = {
    getCompilationSettings: () => project.options,
    getScriptFileNames: () => Array.from(sourceTexts.keys()),
    getScriptVersion: fileName => String(sourceTexts.get(resolve(fileName))?.version || 1),
    getScriptSnapshot: fileName => {
      const resolved = resolve(fileName);
      const entry = sourceTexts.get(resolved);
      if (!entry) return undefined;
      return ts.ScriptSnapshot.fromString(entry.text);
    },
    getCurrentDirectory: () => project.root,
    getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories
  };

  const service = ts.createLanguageService(serviceHost);
  try {
    const fileText = sourceTexts.get(absFile)?.text || '';
    const lines = fileText.split('\n');
    const lineIndex = Math.max(0, line - 1);
    const safeLine = lines[lineIndex] || '';
    const offset = lines.slice(0, lineIndex).reduce((sum, x) => sum + x.length + 1, 0) + Math.max(0, column - 1);
    const position = Math.min(offset, fileText.length);

    const completions = service.getCompletionsAtPosition(absFile, position, {
      includeCompletionsWithInsertText: true,
      includeCompletionsForModuleExports: true
    });

    const items = (completions?.entries || []).filter(entry => {
      if (!prefix) return true;
      return entry.name.toLowerCase().startsWith(prefix.toLowerCase());
    });

    return items.slice(0, Math.max(1, limit)).map(entry => ({
      name: entry.name,
      kind: kindToText(entry.kind),
      sortText: entry.sortText
    }));
  } finally {
    service.dispose();
  }
}
