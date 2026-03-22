import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
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

function inferImageMime(path: string): string | null {
  const ext = extname(path).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return null;
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

export async function buildImageContextBlock(paths: string[] = [], maxBytes = 250_000): Promise<string> {
  if (!paths.length) return '';
  const sections: string[] = [];

  for (const rawPath of paths) {
    const abs = resolve(rawPath);
    try {
      const mime = inferImageMime(abs);
      if (!mime) {
        sections.push(`### Image Context: ${abs}\n(unsupported image type; supported: png, jpg, jpeg, webp, gif)`);
        continue;
      }

      const buf = await readFile(abs);
      const used = buf.subarray(0, maxBytes);
      const truncated = buf.length > maxBytes;
      const dataUri = `data:${mime};base64,${used.toString('base64')}`;
      sections.push([
        `### Image Context: ${abs}`,
        `mime: ${mime}`,
        `bytes: ${buf.length}${truncated ? ` (truncated to ${maxBytes})` : ''}`,
        '```text',
        dataUri,
        '```',
        'Instruction: If vision is available, inspect this image for UI/layout/code details and apply the request.'
      ].join('\n'));
    } catch (error) {
      sections.push(`### Image Context: ${abs}\n(unavailable: ${(error as Error).message})`);
    }
  }

  return `## Extra Image Context\n${sections.join('\n\n')}`;
}

/** Load images as structured attachments for multimodal LLM input */
export async function loadImageAttachments(
  paths: string[] = [],
  maxBytes = 250_000
): Promise<Array<{ data: string; mimeType: string }>> {
  if (!paths.length) return [];
  const attachments: Array<{ data: string; mimeType: string }> = [];

  for (const rawPath of paths) {
    const abs = resolve(rawPath);
    try {
      const mime = inferImageMime(abs);
      if (!mime) continue;
      const buf = await readFile(abs);
      const used = buf.subarray(0, maxBytes);
      attachments.push({ data: used.toString('base64'), mimeType: mime });
    } catch {
      // Skip unreadable files
    }
  }

  return attachments;
}

export function mergeTaskWithContext(task: string, blocks: string[]): string {
  const filtered = blocks.map(x => String(x || '').trim()).filter(Boolean);
  if (!filtered.length) return task;
  return `${task}\n\n${filtered.join('\n\n')}`;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function enforceContextBudget(
  task: string,
  blocks: string[],
  maxTokens?: number,
  mode: 'trim' | 'stop' = 'trim'
): { task: string; estimatedTokens: number; trimmed: boolean; exceeded: boolean } {
  const merged = mergeTaskWithContext(task, blocks);
  if (!maxTokens || maxTokens <= 0) {
    return { task: merged, estimatedTokens: estimateTokens(merged), trimmed: false, exceeded: false };
  }

  const estimated = estimateTokens(merged);
  if (estimated <= maxTokens) {
    return { task: merged, estimatedTokens: estimated, trimmed: false, exceeded: false };
  }

  if (mode === 'stop') {
    return { task: merged, estimatedTokens: estimated, trimmed: false, exceeded: true };
  }

  const baseTask = String(task || '');
  const maxChars = maxTokens * 4;
  const baseChars = baseTask.length;
  const remainingForContext = Math.max(0, maxChars - baseChars - 2);
  const contextText = blocks.map(x => String(x || '').trim()).filter(Boolean).join('\n\n');
  const clippedContext = contextText.slice(0, remainingForContext);
  const clipped = clippedContext ? `${baseTask}\n\n${clippedContext}` : baseTask.slice(0, maxChars);
  return {
    task: clipped,
    estimatedTokens: estimateTokens(clipped),
    trimmed: true,
    exceeded: false
  };
}
