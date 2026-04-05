import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let filterToolsForTask, detectTaskDomains;

describe('ToolFilter', async () => {
  before(async () => {
    const mod = await import('../../src/engine/tool-filter.ts');
    filterToolsForTask = mod.filterToolsForTask;
    detectTaskDomains = mod.detectTaskDomains;
  });

  describe('detectTaskDomains', () => {
    it('always includes coding', () => {
      const domains = detectTaskDomains('hello');
      assert.ok(domains.has('coding'));
    });

    it('detects git domain', () => {
      const domains = detectTaskDomains('commit these changes and push');
      assert.ok(domains.has('git'));
    });

    it('detects research domain', () => {
      const domains = detectTaskDomains('search the web for React best practices');
      assert.ok(domains.has('research'));
    });

    it('detects testing domain', () => {
      const domains = detectTaskDomains('write unit tests for the parser');
      assert.ok(domains.has('testing'));
    });

    it('detects docs domain', () => {
      const domains = detectTaskDomains('update the README with install instructions');
      assert.ok(domains.has('docs'));
    });

    it('detects full for complex tasks', () => {
      const domains = detectTaskDomains('refactor the entire project to use TypeScript');
      assert.ok(domains.has('full'));
    });
  });

  describe('filterToolsForTask', () => {
    const allTools = [
      { name: 'read_file' }, { name: 'write_file' }, { name: 'replace' },
      { name: 'glob' }, { name: 'grep_search' }, { name: 'run_shell_command' },
      { name: 'git' }, { name: 'worktree' },
      { name: 'google_web_search' }, { name: 'web_fetch' },
      { name: 'save_memory' }, { name: 'get_internal_docs' },
      { name: 'lsp' }, { name: 'notebook_edit' },
      { name: 'enter_plan_mode' }, { name: 'tracker_create_task' },
      { name: 'spawn_agent' }, { name: 'agent_message' },
    ];

    it('includes core tools for any task', () => {
      const filtered = filterToolsForTask(allTools, 'fix a bug');
      assert.ok(filtered.some(t => t.name === 'read_file'));
      assert.ok(filtered.some(t => t.name === 'write_file'));
      assert.ok(filtered.some(t => t.name === 'run_shell_command'));
    });

    it('includes git tools for git tasks', () => {
      const filtered = filterToolsForTask(allTools, 'commit and push changes');
      assert.ok(filtered.some(t => t.name === 'git'));
    });

    it('excludes git tools for non-git tasks', () => {
      const filtered = filterToolsForTask(allTools, 'fix a typo in math.ts');
      assert.ok(!filtered.some(t => t.name === 'git'));
    });

    it('includes web tools for research tasks', () => {
      const filtered = filterToolsForTask(allTools, 'search for React docs');
      assert.ok(filtered.some(t => t.name === 'google_web_search'));
    });

    it('returns all tools for full domain', () => {
      const filtered = filterToolsForTask(allTools, 'refactor the entire project');
      assert.equal(filtered.length, allTools.length);
    });

    it('respects maxTools limit', () => {
      const filtered = filterToolsForTask(allTools, 'refactor the entire project', { maxTools: 5 });
      assert.ok(filtered.length <= 5);
    });
  });
});
