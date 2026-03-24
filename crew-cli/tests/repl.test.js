/**
 * Tests for REPL module (src/repl/index.ts)
 *
 * The REPL only exports `startRepl` which requires full dependency injection
 * and starts an interactive readline loop, so we test the internal logic by
 * reading the source as text and verifying key structures, plus ensuring the
 * module loads without crashing.
 *
 * Run with: node --import tsx --test tests/repl.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPL_SOURCE = readFileSync(join(__dirname, '..', 'src', 'repl', 'index.ts'), 'utf8');

// ---------------------------------------------------------------------------
// 1. Module import
// ---------------------------------------------------------------------------

test('REPL module exports startRepl without crashing', async () => {
  const mod = await import('../src/repl/index.js');
  assert.ok(mod.startRepl, 'startRepl should be exported');
  assert.strictEqual(typeof mod.startRepl, 'function', 'startRepl should be a function');
});

// ---------------------------------------------------------------------------
// 2. Slash command recognition
// ---------------------------------------------------------------------------

test('REPL source recognises core slash commands', () => {
  const requiredCommands = ['/help', '/model', '/mode', '/quit', '/exit', '/status', '/preview', '/apply'];
  for (const cmd of requiredCommands) {
    assert.ok(
      REPL_SOURCE.includes(`'${cmd}'`) || REPL_SOURCE.includes(`"${cmd}"`),
      `Slash command ${cmd} should be handled in the REPL source`
    );
  }
});

test('Unknown slash commands fall through to error message', () => {
  assert.ok(
    REPL_SOURCE.includes('Unknown command'),
    'REPL should print an unknown-command error for unrecognised slash input'
  );
});

// ---------------------------------------------------------------------------
// 3. Mode switching
// ---------------------------------------------------------------------------

test('REPL defines valid mode list: manual, assist, autopilot', () => {
  assert.ok(REPL_SOURCE.includes("'manual'"), 'manual mode should be defined');
  assert.ok(REPL_SOURCE.includes("'assist'"), 'assist mode should be defined');
  assert.ok(REPL_SOURCE.includes("'autopilot'"), 'autopilot mode should be defined');

  // The ordered array REPL_MODE_ORDER drives Shift+Tab cycling and /mode validation
  assert.ok(
    REPL_SOURCE.includes("REPL_MODE_ORDER"),
    'REPL_MODE_ORDER constant should exist for mode cycling'
  );
});

test('Mode switching sets autoApply correctly per mode', () => {
  // In the source, manual sets autoApply = false, autopilot sets autoApply = true
  assert.ok(
    REPL_SOURCE.includes("replState.autoApply = false"),
    'manual mode should disable autoApply'
  );
  assert.ok(
    REPL_SOURCE.includes("replState.autoApply = true"),
    'autopilot mode should enable autoApply'
  );
});

test('Invalid mode names are rejected', () => {
  // The handler checks REPL_MODE_ORDER.includes(requested) and prints an error otherwise
  assert.ok(
    REPL_SOURCE.includes('Mode must be one of'),
    'REPL should reject invalid mode names with a descriptive error'
  );
});

// ---------------------------------------------------------------------------
// 4. Model validation
// ---------------------------------------------------------------------------

test('AVAILABLE_MODELS list contains expected models', () => {
  const modelsMatch = REPL_SOURCE.match(/const AVAILABLE_MODELS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(modelsMatch, 'AVAILABLE_MODELS constant should be defined');

  const modelsBlock = modelsMatch[1];
  const expectedModels = ['deepseek-v3.2', 'gemini-2.5-flash', 'claude-sonnet-4.6'];
  for (const m of expectedModels) {
    assert.ok(
      modelsBlock.includes(m),
      `AVAILABLE_MODELS should include ${m}`
    );
  }
});

test('/model without a name shows usage info', () => {
  // The handler checks if modelName is empty and shows usage or model catalog
  assert.ok(
    REPL_SOURCE.includes('/model <name>') || REPL_SOURCE.includes('Provide a model name'),
    '/model with no argument should show usage guidance'
  );
});

// ---------------------------------------------------------------------------
// 5. Input sanitization
// ---------------------------------------------------------------------------

test('Empty and whitespace-only input is ignored', () => {
  // The rl 'line' handler trims input and short-circuits on empty string
  assert.ok(
    REPL_SOURCE.includes('const trimmed = input.trim()'),
    'Input should be trimmed before processing'
  );
  assert.ok(
    REPL_SOURCE.includes('if (!trimmed)'),
    'Empty trimmed input should be caught and ignored'
  );
});

// ---------------------------------------------------------------------------
// 6. Banner rendering
// ---------------------------------------------------------------------------

test('BANNER constant contains ASCII art box', () => {
  assert.ok(REPL_SOURCE.includes('const BANNER'), 'BANNER constant should be defined');
  assert.ok(REPL_SOURCE.includes('CREW'), 'BANNER should contain CREW branding');
  assert.ok(REPL_SOURCE.includes('╔'), 'BANNER should use box-drawing characters');
  assert.ok(REPL_SOURCE.includes('╚'), 'BANNER should close the box');
});

test('renderBannerAnimated function exists', () => {
  assert.ok(
    REPL_SOURCE.includes('async function renderBannerAnimated'),
    'renderBannerAnimated helper should be defined for animated banner output'
  );
});
