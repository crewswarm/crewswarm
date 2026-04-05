import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let getPersona, listPersonas, buildSummonPrompt, filterToolsForPersona;

describe('Summon', async () => {
  before(async () => {
    const mod = await import('../../src/engine/summon.ts');
    getPersona = mod.getPersona;
    listPersonas = mod.listPersonas;
    buildSummonPrompt = mod.buildSummonPrompt;
    filterToolsForPersona = mod.filterToolsForPersona;
  });

  it('lists all personas', () => {
    const personas = listPersonas();
    assert.ok(personas.length >= 6);
    assert.ok(personas.some(p => p.id === 'crew-qa'));
    assert.ok(personas.some(p => p.id === 'crew-coder-back'));
    assert.ok(personas.some(p => p.id === 'crew-security'));
  });

  it('gets persona by id', () => {
    const qa = getPersona('crew-qa');
    assert.ok(qa);
    assert.equal(qa.id, 'crew-qa');
    assert.ok(qa.systemPromptAddition.includes('test'));
  });

  it('returns undefined for unknown persona', () => {
    const p = getPersona('crew-nonexistent');
    assert.equal(p, undefined);
  });

  it('builds summon prompt with persona', () => {
    const qa = getPersona('crew-qa');
    const prompt = buildSummonPrompt('Base prompt.', qa, 'Previous context here');
    assert.ok(prompt.includes('Base prompt'));
    assert.ok(prompt.includes('QA specialist'));
    assert.ok(prompt.includes('Previous context'));
  });

  it('filters tools for persona', () => {
    const tools = [
      { name: 'read_file' }, { name: 'write_file' }, { name: 'replace' },
      { name: 'run_shell_command' }, { name: 'google_web_search' },
      { name: 'git' }, { name: 'lsp' }, { name: 'spawn_agent' }
    ];
    const qa = getPersona('crew-qa');
    const filtered = filterToolsForPersona(tools, qa);
    assert.ok(filtered.some(t => t.name === 'read_file'));
    assert.ok(filtered.some(t => t.name === 'run_shell_command'));
  });
});
