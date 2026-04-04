/**
 * Cumulative Diff Sandbox (Plandex Pattern)
 * 
 * Extends base Sandbox with git-like diff viewing and selective apply/reject.
 * Changes are staged in memory and shown as unified diffs before writing to disk.
 * 
 * Commands:
 *   - showDiffs(): Show unified diff for all staged files
 *   - applyFile(path): Write ONE file to disk
 *   - applyAll(): Write ALL files to disk
 *   - rejectFile(path): Discard changes for ONE file
 */

import { diffLines } from 'diff';
import { Sandbox } from './index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class CumulativeDiffSandbox extends Sandbox {
  private originalFiles = new Map<string, string>();
  private getBranchChanges(branchName: string): Record<string, { original?: string; modified?: string }> {
    return this.state.branches[branchName] as Record<string, { original?: string; modified?: string }>;
  }

  /**
   * Override addChange to track original file contents
   */
  async addChange(filePath: string, modifiedContent: string): Promise<void> {
    // Save original on first change to this file
    if (!this.originalFiles.has(filePath)) {
      const fullPath = join(process.cwd(), filePath);
      try {
        const original = await readFile(fullPath, 'utf-8');
        this.originalFiles.set(filePath, original);
      } catch {
        // New file, no original
        this.originalFiles.set(filePath, '');
      }
    }

    // Call parent to stage the change
    await super.addChange(filePath, modifiedContent);
  }

  /**
   * Show unified diff for all staged files
   * Returns git-style diff output
   */
  showDiffs(branchName?: string): string {
    const targetBranch = branchName || this.getActiveBranch();
    const paths = this.getPendingPaths(targetBranch);

    if (paths.length === 0) {
      return 'No pending changes.';
    }

    let output = '';

    for (const path of paths) {
      const change = this.getBranchChanges(targetBranch)[path];
      if (!change) continue;

      const original = change.original || '';
      const modified = change.modified || '';

      // Generate unified diff
      const diff = diffLines(original, modified);

      output += `\n${'='.repeat(70)}\n`;
      output += `File: ${path}\n`;
      output += `${'='.repeat(70)}\n`;

      diff.forEach(part => {
        const prefix = part.added ? '+' : part.removed ? '-' : ' ';
        const lines = part.value.split('\n');
        
        lines.forEach((line, idx) => {
          // Skip empty last line
          if (idx === lines.length - 1 && line === '') return;
          output += `${prefix} ${line}\n`;
        });
      });
    }

    output += `\n${'='.repeat(70)}\n`;
    output += `Total files changed: ${paths.length}\n`;
    output += `\nCommands:\n`;
    output += `  crew apply              # Apply all changes\n`;
    output += `  crew apply --file <path> # Apply one file\n`;
    output += `  crew reject --file <path> # Reject one file\n`;

    return output;
  }

  /**
   * Apply a single file to disk
   */
  async applyFile(filePath: string, branchName?: string): Promise<void> {
    const targetBranch = branchName || this.getActiveBranch();
    const branch = this.state.branches[targetBranch];
    
    if (!branch || !(filePath in branch)) {
      throw new Error(`No staged changes for ${filePath}`);
    }

    const change = this.getBranchChanges(targetBranch)[filePath];
    const fullPath = join(this.baseDir, filePath);

    // Ensure directory exists
    const { mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(fullPath), { recursive: true });

    // Write file
    const { writeFile } = await import('node:fs/promises');
    await writeFile(fullPath, change.modified, 'utf-8');

    // Remove from staged changes
    delete this.getBranchChanges(targetBranch)[filePath];
    this.originalFiles.delete(filePath);

    await this.persist();
  }

  /**
   * Apply all staged files to disk
   */
  async applyAll(branchName?: string): Promise<void> {
    const targetBranch = branchName || this.getActiveBranch();
    const paths = this.getPendingPaths(targetBranch);

    for (const path of paths) {
      await this.applyFile(path, targetBranch);
    }
  }

  /**
   * Reject (discard) changes for a single file
   */
  async rejectFile(filePath: string, branchName?: string): Promise<void> {
    const targetBranch = branchName || this.getActiveBranch();
    const branch = this.state.branches[targetBranch];

    if (!branch || !(filePath in branch)) {
      throw new Error(`No staged changes for ${filePath}`);
    }

    delete this.getBranchChanges(targetBranch)[filePath];
    this.originalFiles.delete(filePath);

    await this.persist();
  }

  /**
   * Get list of files with staged changes
   */
  getStagedFiles(branchName?: string): string[] {
    return this.getPendingPaths(branchName);
  }

  /**
   * Check if a specific file has staged changes
   */
  hasFileChange(filePath: string, branchName?: string): boolean {
    const targetBranch = branchName || this.getActiveBranch();
    const branch = this.state.branches[targetBranch];
    return branch && filePath in branch;
  }

  /**
   * Get the original content of a file (before changes)
   */
  getOriginalContent(filePath: string): string | undefined {
    return this.originalFiles.get(filePath);
  }

  /**
   * Get the modified content of a file (staged changes)
   */
  getModifiedContent(filePath: string, branchName?: string): string | undefined {
    const targetBranch = branchName || this.getActiveBranch();
    const branch = this.state.branches[targetBranch];
    if (!branch) return undefined;
    
    const change = this.getBranchChanges(targetBranch)[filePath];
    return change?.modified;
  }
}
