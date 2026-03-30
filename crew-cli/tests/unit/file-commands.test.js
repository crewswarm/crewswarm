import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDirectFileCommands,
  parseWriteSyntax,
  stripDirectCommands,
  hasDirectCommands
} from '../../src/cli/file-commands.ts';

describe('file-commands', () => {
  it('parseDirectFileCommands parses @@WRITE_FILE blocks', () => {
    const input = '@@WRITE_FILE hello.txt\nworld\n@@END_FILE';
    const cmds = parseDirectFileCommands(input);
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].type, 'write');
    assert.equal(cmds[0].path, 'hello.txt');
    assert.equal(cmds[0].content, 'world\n');
  });

  it('parseDirectFileCommands parses @@MKDIR', () => {
    const input = '@@MKDIR src/new-dir';
    const cmds = parseDirectFileCommands(input);
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].type, 'mkdir');
    assert.equal(cmds[0].path, 'src/new-dir');
  });

  it('parseWriteSyntax parses write: syntax', () => {
    const input = 'write: foo.ts\nconst x = 1;\n';
    const cmds = parseWriteSyntax(input);
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].path, 'foo.ts');
    assert.ok(cmds[0].content.includes('const x = 1'));
  });

  it('hasDirectCommands detects @@WRITE_FILE', () => {
    assert.equal(hasDirectCommands('@@WRITE_FILE x.txt\n'), true);
    assert.equal(hasDirectCommands('just a chat message'), false);
  });

  it('stripDirectCommands removes @@WRITE_FILE blocks', () => {
    const input = 'before\n@@WRITE_FILE x.txt\ncontent\n@@END_FILE\nafter';
    const stripped = stripDirectCommands(input);
    assert.ok(!stripped.includes('@@WRITE_FILE'));
    assert.ok(stripped.includes('before'));
    assert.ok(stripped.includes('after'));
  });
});
