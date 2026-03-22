import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StudioBroadcaster } from '../studio/broadcaster.js';

export interface WatchEvent {
  type: 'todo_detected' | 'file_changed';
  file: string;
  todoCount?: number;
  todos?: string[];
}

function extractTodos(content: string): string[] {
  const todos: string[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.toLowerCase().includes('todo')) {
      todos.push(line.trim());
    }
  }
  return todos;
}

export async function inspectFileForTodos(path: string): Promise<WatchEvent> {
  let content = '';
  try {
    content = await readFile(path, 'utf8');
  } catch {
    return { type: 'file_changed', file: path };
  }

  const todos = extractTodos(content);
  if (todos.length > 0) {
    return {
      type: 'todo_detected',
      file: path,
      todoCount: todos.length,
      todos
    };
  }

  return { type: 'file_changed', file: path };
}

export function startWatchMode(
  rootDir: string,
  onEvent: (event: WatchEvent) => Promise<void> | void,
  ignored: string[] = ['node_modules', '.git', 'dist', '.crew'],
  options?: { broadcastToStudio?: boolean; studioUrl?: string }
) {
  // Initialize Studio broadcaster if requested
  let broadcaster: StudioBroadcaster | null = null;
  if (options?.broadcastToStudio) {
    broadcaster = new StudioBroadcaster(options?.studioUrl);
    broadcaster.connect().catch(() => {
      // Studio not running - continue without broadcast
    });
  }

  // Prefer chokidar if available for robust cross-platform watching.
  try {
    const chokidarMod = (globalThis as any).__crewChokidarCache
      || null;
    if (chokidarMod?.watch) {
      const watcher = chokidarMod.watch(rootDir, { ignored, ignoreInitial: true });
      
      watcher.on('change', async (file: string) => {
        const event = await inspectFileForTodos(file);
        await onEvent(event);
        
        // Broadcast to Studio
        if (broadcaster) {
          await broadcaster.broadcastFileChange(file, true);
        }
      });
      
      watcher.on('add', async (file: string) => {
        if (broadcaster) {
          await broadcaster.broadcastFileCreated(file);
        }
      });
      
      watcher.on('unlink', async (file: string) => {
        if (broadcaster) {
          await broadcaster.broadcastFileDeleted(file);
        }
      });
      
      return watcher;
    }
  } catch {
    // fallback below
  }

  const watcher = watch(rootDir, { recursive: true }, async (eventType, filename) => {
    if (!filename) return;
    const relative = String(filename);
    if (ignored.some(p => relative.includes(p))) return;

    const fullPath = join(rootDir, relative);
    const event = await inspectFileForTodos(fullPath);
    await onEvent(event);
    
    // Broadcast to Studio
    if (broadcaster) {
      if (eventType === 'rename') {
        // Could be add or delete - check if file exists
        await broadcaster.broadcastFileChange(fullPath, true);
      } else {
        await broadcaster.broadcastFileChange(fullPath, true);
      }
    }
  });

  return watcher;
}

// Lazy-load chokidar once if installed.
void import('chokidar')
  .then(mod => {
    (globalThis as any).__crewChokidarCache = mod.default || mod;
  })
  .catch(() => {
    // optional dependency
  });
