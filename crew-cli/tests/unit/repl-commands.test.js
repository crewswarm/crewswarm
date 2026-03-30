/**
 * Unit tests for crew-cli/src/repl/index.ts — helper functions and structures.
 *
 * The REPL exports only `startRepl` which requires full dependency injection,
 * so we test internal logic by reading source text and verifying structures,
 * plus importing to verify the module loads without crashing.
 *
 * Extends the existing tests/repl.test.js with deeper coverage.
 *
 * Run with: node --import tsx --test crew-cli/tests/unit/repl-commands.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPL_SOURCE = readFileSync(join(__dirname, '..', '..', 'src', 'repl', 'index.ts'), 'utf8');

// ---------------------------------------------------------------------------
// 1. Module export
// ---------------------------------------------------------------------------

describe('REPL module export', () => {
  it('exports startRepl as a function', async () => {
    const mod = await import('../../src/repl/index.js');
    assert.equal(typeof mod.startRepl, 'function');
  });
});

// ---------------------------------------------------------------------------
// 2. Slash command completeness
// ---------------------------------------------------------------------------

describe('Slash command coverage', () => {
  const allExpected = [
    '/help', '/info', '/status', '/history', '/clear', '/exit',
    '/models', '/model', '/engines', '/engine', '/mode', '/stack',
    '/preview', '/apply', '/rollback', '/branch', '/branches',
    '/tools', '/trace', '/timeline', '/cost', '/system', '/permissions',
    '/image', '/search', '/recall', '/sessions', '/resume', '/skills',
  ];

  for (const cmd of allExpected) {
    it(`defines ${cmd} in SLASH_COMMAND_GROUPS`, () => {
      assert.ok(
        REPL_SOURCE.includes(`'${cmd}'`) || REPL_SOURCE.includes(`"${cmd}"`),
        `${cmd} should appear in SLASH_COMMAND_GROUPS`,
      );
    });
  }

  it('SLASH_COMMAND_GROUPS is organized by category', () => {
    assert.ok(REPL_SOURCE.includes("title: 'Session'"));
    assert.ok(REPL_SOURCE.includes("title: 'Model & Engine'"));
    assert.ok(REPL_SOURCE.includes("title: 'Sandbox'"));
    assert.ok(REPL_SOURCE.includes("title: 'Runtime'"));
    assert.ok(REPL_SOURCE.includes("title: 'Context'"));
  });
});

// ---------------------------------------------------------------------------
// 3. getSlashCommands helper
// ---------------------------------------------------------------------------

describe('getSlashCommands', () => {
  it('is defined as a function returning deduplicated commands', () => {
    assert.ok(REPL_SOURCE.includes('function getSlashCommands'));
    assert.ok(REPL_SOURCE.includes('new Set(flat)'));
  });
});

// ---------------------------------------------------------------------------
// 4. AVAILABLE_MODELS
// ---------------------------------------------------------------------------

describe('AVAILABLE_MODELS', () => {
  it('is defined as a const array', () => {
    assert.ok(REPL_SOURCE.includes('const AVAILABLE_MODELS'));
  });

  const expectedModels = [
    'gemini-2.5-flash',
    'deepseek-v3.2',
    'grok-4.1-fast',
  ];

  for (const model of expectedModels) {
    it(`includes ${model}`, () => {
      assert.ok(REPL_SOURCE.includes(model), `${model} should be in AVAILABLE_MODELS`);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. AVAILABLE_ENGINES
// ---------------------------------------------------------------------------

describe('AVAILABLE_ENGINES', () => {
  it('is defined as a const array', () => {
    assert.ok(REPL_SOURCE.includes('const AVAILABLE_ENGINES'));
  });

  for (const engine of ['auto', 'cursor', 'claude', 'gemini', 'codex', 'crew-cli']) {
    it(`includes ${engine}`, () => {
      assert.ok(REPL_SOURCE.includes(`'${engine}'`));
    });
  }
});

// ---------------------------------------------------------------------------
// 6. ReplState interface and mode cycling
// ---------------------------------------------------------------------------

describe('ReplState and mode management', () => {
  it('defines ReplState interface with expected fields', () => {
    assert.ok(REPL_SOURCE.includes('model: string'));
    assert.ok(REPL_SOURCE.includes('engine: string'));
    assert.ok(REPL_SOURCE.includes('autoApply: boolean'));
    assert.ok(REPL_SOURCE.includes('verbose: boolean'));
  });

  it('defines REPL_MODE_ORDER for mode cycling', () => {
    const match = REPL_SOURCE.match(/REPL_MODE_ORDER[^=]*=\s*\[([^\]]*)\]/s);
    assert.ok(match, 'REPL_MODE_ORDER should be defined');
    const modes = match[1];
    assert.ok(modes.includes('manual'), 'should include manual');
    assert.ok(modes.includes('assist'), 'should include assist');
    assert.ok(modes.includes('autopilot'), 'should include autopilot');
  });
});

// ---------------------------------------------------------------------------
// 7. resolveConfiguredReplModel
// ---------------------------------------------------------------------------

describe('resolveConfiguredReplModel', () => {
  it('is defined as a function', () => {
    assert.ok(REPL_SOURCE.includes('function resolveConfiguredReplModel'));
  });

  it('checks repoConfig repl.model first', () => {
    assert.ok(REPL_SOURCE.includes("repoConfig?.repl?.model"));
  });

  it('checks env vars as fallback', () => {
    assert.ok(REPL_SOURCE.includes('CREW_CHAT_MODEL'));
    assert.ok(REPL_SOURCE.includes('CREW_ROUTER_MODEL'));
    assert.ok(REPL_SOURCE.includes('CREW_EXECUTION_MODEL'));
  });

  it('has a hardcoded default model', () => {
    assert.ok(REPL_SOURCE.includes("return 'grok-4-1-fast-reasoning'"));
  });
});

// ---------------------------------------------------------------------------
// 8. readJsonFile helper
// ---------------------------------------------------------------------------

describe('readJsonFile', () => {
  it('is defined and handles missing files', () => {
    assert.ok(REPL_SOURCE.includes('function readJsonFile'));
    assert.ok(REPL_SOURCE.includes('existsSync(filePath)'));
    assert.ok(REPL_SOURCE.includes('return null'));
  });
});

// ---------------------------------------------------------------------------
// 9. printSlashCommandMenu
// ---------------------------------------------------------------------------

describe('printSlashCommandMenu', () => {
  it('is defined and supports filtering', () => {
    assert.ok(REPL_SOURCE.includes('function printSlashCommandMenu'));
    assert.ok(REPL_SOURCE.includes('filter'));
  });
});

// ---------------------------------------------------------------------------
// 10. Tab completion and input handling
// ---------------------------------------------------------------------------

describe('Tab completion', () => {
  it('source includes completer logic for slash commands', () => {
    // Tab completion is implemented via readline completer
    assert.ok(
      REPL_SOURCE.includes('completer') || REPL_SOURCE.includes('getSlashCommands'),
      'REPL should have tab-completion support',
    );
  });
});

describe('Input trimming', () => {
  it('trims input before processing', () => {
    assert.ok(REPL_SOURCE.includes('const trimmed = input.trim()'));
  });

  it('short-circuits on empty input', () => {
    assert.ok(REPL_SOURCE.includes('if (!trimmed)'));
  });
});

// ---------------------------------------------------------------------------
// 11. listInstalledSkills
// ---------------------------------------------------------------------------

describe('listInstalledSkills', () => {
  it('is defined and reads from ~/.crewswarm/skills', () => {
    assert.ok(REPL_SOURCE.includes('async function listInstalledSkills'));
    assert.ok(REPL_SOURCE.includes("'skills'"));
    assert.ok(REPL_SOURCE.includes("SKILL.md"));
  });
});

// ---------------------------------------------------------------------------
// 12. buildModelSummary
// ---------------------------------------------------------------------------

describe('buildModelSummary', () => {
  it('is defined and builds a summary object', () => {
    assert.ok(REPL_SOURCE.includes('function buildModelSummary'));
    assert.ok(REPL_SOURCE.includes('ModelSummary'));
  });
});
