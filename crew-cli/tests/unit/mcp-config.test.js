/**
 * Unit tests for crew-cli/src/mcp/index.ts
 *
 * Covers:
 *  - listMcpServers: returns empty object from non-existent store
 *  - addMcpServer: writes and reads back server config
 *  - addMcpServer: validates required fields
 *  - removeMcpServer: removes a server from the store
 *  - doctorMcpServers: returns "(none)" check when no servers configured
 *  - doctorMcpServers: detects missing URL
 *  - doctorMcpServers: detects invalid URL
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  doctorMcpServers,
} from '../../src/mcp/index.ts';

const TEST_DIR = path.join(os.tmpdir(), `mcp-config-test-${process.pid}`);

describe('MCP config — listMcpServers', () => {
  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns empty object when no store file exists', async () => {
    const servers = await listMcpServers(TEST_DIR);
    assert.deepEqual(servers, {});
  });
});

describe('MCP config — addMcpServer and listMcpServers', () => {
  const dir = path.join(os.tmpdir(), `mcp-add-test-${process.pid}`);

  before(() => {
    fs.mkdirSync(dir, { recursive: true });
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('adds a server and reads it back', async () => {
    await addMcpServer('test-server', { url: 'http://localhost:3000/mcp' }, dir);
    const servers = await listMcpServers(dir);
    assert.ok(servers['test-server'], 'server should be present');
    assert.equal(servers['test-server'].url, 'http://localhost:3000/mcp');
  });

  it('adds a server with bearer token env var', async () => {
    await addMcpServer('auth-server', {
      url: 'http://localhost:4000/mcp',
      bearerTokenEnvVar: 'MY_TOKEN',
    }, dir);
    const servers = await listMcpServers(dir);
    assert.equal(servers['auth-server'].bearerTokenEnvVar, 'MY_TOKEN');
  });

  it('adds a server with custom headers', async () => {
    await addMcpServer('header-server', {
      url: 'http://localhost:5000/mcp',
      headers: { 'X-Custom': 'value' },
    }, dir);
    const servers = await listMcpServers(dir);
    assert.deepEqual(servers['header-server'].headers, { 'X-Custom': 'value' });
  });

  it('throws when name is missing', async () => {
    await assert.rejects(
      () => addMcpServer('', { url: 'http://localhost:3000' }, dir),
      { message: /name and url are required/ }
    );
  });

  it('throws when url is missing', async () => {
    await assert.rejects(
      () => addMcpServer('no-url', { url: '' }, dir),
      { message: /name and url are required/ }
    );
  });
});

describe('MCP config — removeMcpServer', () => {
  const dir = path.join(os.tmpdir(), `mcp-remove-test-${process.pid}`);

  before(async () => {
    fs.mkdirSync(dir, { recursive: true });
    await addMcpServer('to-remove', { url: 'http://localhost:6000/mcp' }, dir);
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('removes a server from the store', async () => {
    const before = await listMcpServers(dir);
    assert.ok(before['to-remove'], 'server should exist before removal');

    await removeMcpServer('to-remove', dir);
    const after = await listMcpServers(dir);
    assert.equal(after['to-remove'], undefined, 'server should be gone');
  });

  it('removing non-existent server does not throw', async () => {
    await removeMcpServer('does-not-exist', dir);
    // Should not throw
  });
});

describe('MCP config — doctorMcpServers', () => {
  it('returns "(none)" when no servers configured', async () => {
    const emptyDir = path.join(os.tmpdir(), `mcp-doctor-empty-${process.pid}`);
    fs.mkdirSync(emptyDir, { recursive: true });
    const checks = await doctorMcpServers(emptyDir);
    assert.equal(checks.length, 1);
    assert.equal(checks[0].server, '(none)');
    assert.equal(checks[0].ok, false);
    assert.match(checks[0].details, /No MCP servers/);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('detects invalid URL', async () => {
    const dir = path.join(os.tmpdir(), `mcp-doctor-invalid-${process.pid}`);
    fs.mkdirSync(dir, { recursive: true });
    // Write a store with an invalid URL directly
    const storePath = path.join(dir, '.crew', 'mcp-servers.json');
    fs.mkdirSync(path.join(dir, '.crew'), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({
      mcpServers: { 'bad-server': { url: 'not-a-valid-url' } }
    }), 'utf8');

    const checks = await doctorMcpServers(dir);
    const badCheck = checks.find(c => c.server === 'bad-server');
    assert.ok(badCheck, 'should check bad-server');
    assert.equal(badCheck.ok, false);
    assert.match(badCheck.details, /Invalid URL/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects missing bearer token env var', async () => {
    const dir = path.join(os.tmpdir(), `mcp-doctor-envvar-${process.pid}`);
    fs.mkdirSync(path.join(dir, '.crew'), { recursive: true });
    const storePath = path.join(dir, '.crew', 'mcp-servers.json');
    // Use an env var name that definitely does not exist
    fs.writeFileSync(storePath, JSON.stringify({
      mcpServers: {
        'env-server': {
          url: 'http://localhost:9999/mcp',
          bearerTokenEnvVar: 'CREWSWARM_TEST_NONEXISTENT_TOKEN_XYZ_42',
        }
      }
    }), 'utf8');

    const checks = await doctorMcpServers(dir);
    const envCheck = checks.find(c => c.server === 'env-server');
    assert.ok(envCheck, 'should check env-server');
    assert.equal(envCheck.ok, false);
    assert.match(envCheck.details, /Missing env var/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
