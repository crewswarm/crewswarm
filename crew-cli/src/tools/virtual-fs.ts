/**
 * VirtualFS - Filesystem abstraction layer
 * Redirects all file operations through the sandbox for staging
 * 
 * @license
 * Portions inspired by Gemini CLI architecture
 * Copyright 2026 CrewSwarm
 */

import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { Sandbox } from '../sandbox/index.js';
import { join, dirname } from 'node:path';

export interface FileStats {
  size: number;
  mtime: Date;
  isDirectory: () => boolean;
  isFile: () => boolean;
}

export class VirtualFS {
  constructor(private sandbox: Sandbox, private baseDir: string = process.cwd()) {}

  /**
   * Read file - checks sandbox first, then disk
   */
  async readFile(path: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    // Normalize path
    const fullPath = this.resolvePath(path);
    
    // Check if staged in sandbox
    const branch = this.sandbox.getState()?.branches?.[this.sandbox.getActiveBranch()];
    const staged = branch?.[fullPath];
    
    if (staged?.modified) {
      return staged.modified;
    }
    
    // Fall back to real disk
    return fs.readFile(fullPath, encoding);
  }

  /**
   * Write file - stages in sandbox, doesn't touch disk
   */
  async writeFile(path: string, content: string): Promise<void> {
    const fullPath = this.resolvePath(path);
    await this.sandbox.addChange(fullPath, content);
  }

  /**
   * Check if file exists - checks sandbox and disk
   */
  async exists(path: string): Promise<boolean> {
    const fullPath = this.resolvePath(path);
    
    // Check sandbox first
    const branch = this.sandbox.getState()?.branches?.[this.sandbox.getActiveBranch()];
    if (branch?.[fullPath]) return true;
    
    // Check real disk
    try {
      await fs.access(fullPath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file stats - checks sandbox first
   */
  async stat(path: string): Promise<FileStats> {
    const fullPath = this.resolvePath(path);
    
    // Check sandbox first
    const branch = this.sandbox.getState()?.branches?.[this.sandbox.getActiveBranch()];
    const staged = branch?.[fullPath];
    
    if (staged?.modified) {
      // Return fake stat for staged file
      return {
        size: staged.modified.length,
        mtime: new Date(staged.timestamp),
        isDirectory: () => false,
        isFile: () => true
      };
    }
    
    // Fall back to real disk
    return fs.stat(fullPath) as Promise<FileStats>;
  }

  /**
   * Create directory - pass through (directories don't need staging)
   */
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const fullPath = this.resolvePath(path);
    await fs.mkdir(fullPath, options);
  }

  /**
   * Read directory - real disk only (no staging for directories)
   */
  async readdir(path: string): Promise<string[]> {
    const fullPath = this.resolvePath(path);
    return fs.readdir(fullPath);
  }

  /**
   * Resolve relative path to absolute
   */
  private resolvePath(path: string): string {
    if (path.startsWith('/')) return path;
    return join(this.baseDir, path);
  }

  /**
   * Check if path is staged in sandbox
   */
  isStaged(path: string): boolean {
    const fullPath = this.resolvePath(path);
    const branch = this.sandbox.getState()?.branches?.[this.sandbox.getActiveBranch()];
    return !!branch?.[fullPath];
  }

  /**
   * Get all staged paths
   */
  getStagedPaths(): string[] {
    return this.sandbox.getPendingPaths();
  }
}

/**
 * Factory function to create VirtualFS instance
 */
export function createVirtualFS(sandbox: Sandbox, baseDir?: string): VirtualFS {
  return new VirtualFS(sandbox, baseDir);
}
