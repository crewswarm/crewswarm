import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getProjectContext } from './git.js';

export function collectOption(value: string, previous: string[] = []): string[] {
  if (!value) return previous;
  return [...previous, value];
}

export async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) {
    data += String(chunk);
  }
  return data.trim();
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

export async function buildFileContextBlock(paths: string[] = [], maxChars = 8000): Promise<string> {
  if (!paths.length) return '';
  const sections: string[] = [];

  for (const rawPath of paths) {
    const abs = resolve(rawPath);
    try {
      const content = await readFile(abs, 'utf8');
      sections.push([
        `### File Context: ${abs}`,
        '```text',
        clip(content, maxChars),
        '```'
      ].join('\n'));
    } catch (error) {
      sections.push(`### File Context: ${abs}\n(unavailable: ${(error as Error).message})`);
    }
  }

  return `## Extra File Context\n${sections.join('\n\n')}`;
}

export async function buildRepoContextBlock(repos: string[] = []): Promise<string> {
  if (!repos.length) return '';
  const sections: string[] = [];

  for (const repo of repos) {
    const abs = resolve(repo);
    const gitBlock = await getProjectContext(abs).catch((error: Error) => `## Git Context\n${error.message}`);
    sections.push(`### Repo Context: ${abs}\n${gitBlock}`);
  }

  return `## Extra Repository Context\n${sections.join('\n\n')}`;
}

export function mergeTaskWithContext(task: string, blocks: string[]): string {
  const filtered = blocks.map(x => String(x || '').trim()).filter(Boolean);
  if (!filtered.length) return task;
  return `${task}\n\n${filtered.join('\n\n')}`;
}
