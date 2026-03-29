/**
 * Unit tests for lib/approval/policy-manager.mjs
 *
 * Covers:
 *  - loadApprovalPolicies returns defaults when no config file exists
 *  - getApprovalLevel: exact match (e.g. "git" -> "auto")
 *  - getApprovalLevel: prefix match for @@RUN_CMD (e.g. "rm -rf /tmp" -> "admin")
 *  - getApprovalLevel: falls back to "default" when no specific match
 *  - getApprovalLevel: admin user always gets "auto"
 *  - isAdmin: returns false for unknown users
 *  - getApprovalTimeout: returns correct timeouts for user and admin
 *  - exportPolicies: returns a deep copy of policies
 *  - reloadApprovalPolicies: clears cache and re-loads
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadApprovalPolicies,
  reloadApprovalPolicies,
  getApprovalLevel,
  isAdmin,
  getApprovalTimeout,
  addAdminUser,
  removeAdminUser,
  exportPolicies,
} from '../../lib/approval/policy-manager.mjs';

// Force a fresh load of default policies before each test suite
// (policies are cached module-level, so reload to reset state)

describe('policy-manager — loadApprovalPolicies defaults', () => {
  beforeEach(() => reloadApprovalPolicies());

  it('returns an object with approvalPolicies', () => {
    const policies = loadApprovalPolicies();
    assert.equal(typeof policies.approvalPolicies, 'object');
  });

  it('default policies include @@RUN_CMD', () => {
    const policies = loadApprovalPolicies();
    assert.ok(policies.approvalPolicies['@@RUN_CMD'], '@@RUN_CMD should exist');
  });

  it('default policies include @@DISPATCH', () => {
    const policies = loadApprovalPolicies();
    assert.ok(policies.approvalPolicies['@@DISPATCH'], '@@DISPATCH should exist');
  });

  it('default policies include @@WRITE_FILE and @@READ_FILE', () => {
    const policies = loadApprovalPolicies();
    assert.ok(policies.approvalPolicies['@@WRITE_FILE']);
    assert.ok(policies.approvalPolicies['@@READ_FILE']);
  });

  it('default approvalTimeouts are present', () => {
    const policies = loadApprovalPolicies();
    assert.equal(policies.approvalTimeouts.user, 60000);
    assert.equal(policies.approvalTimeouts.admin, 300000);
  });

  it('default adminUsers is an empty array', () => {
    const policies = loadApprovalPolicies();
    assert.ok(Array.isArray(policies.adminUsers));
    assert.equal(policies.adminUsers.length, 0);
  });
});

describe('policy-manager — getApprovalLevel', () => {
  beforeEach(() => reloadApprovalPolicies());

  it('returns "auto" for git commands', () => {
    const level = getApprovalLevel('@@RUN_CMD', 'git', 'crew-coder');
    assert.equal(level, 'auto');
  });

  it('returns "auto" for ls commands', () => {
    const level = getApprovalLevel('@@RUN_CMD', 'ls', 'crew-coder');
    assert.equal(level, 'auto');
  });

  it('returns "admin" for rm -rf commands', () => {
    const level = getApprovalLevel('@@RUN_CMD', 'rm -rf', 'crew-coder');
    assert.equal(level, 'admin');
  });

  it('returns "admin" for "rm -rf /tmp/foo" via prefix match', () => {
    const level = getApprovalLevel('@@RUN_CMD', 'rm -rf /tmp/foo', 'crew-coder');
    assert.equal(level, 'admin');
  });

  it('returns "admin" for docker commands', () => {
    const level = getApprovalLevel('@@RUN_CMD', 'docker', 'crew-coder');
    assert.equal(level, 'admin');
  });

  it('returns "user" as default for unknown RUN_CMD commands', () => {
    const level = getApprovalLevel('@@RUN_CMD', 'curl https://example.com', 'crew-coder');
    assert.equal(level, 'user');
  });

  it('returns "auto" for dispatching crew-coder', () => {
    const level = getApprovalLevel('@@DISPATCH', 'crew-coder', 'crew-lead');
    assert.equal(level, 'auto');
  });

  it('returns "user" for dispatching crew-github', () => {
    const level = getApprovalLevel('@@DISPATCH', 'crew-github', 'crew-lead');
    assert.equal(level, 'user');
  });

  it('returns "auto" as default for @@DISPATCH of unknown agents', () => {
    const level = getApprovalLevel('@@DISPATCH', 'crew-unknown', 'crew-lead');
    assert.equal(level, 'auto');
  });

  it('returns "auto" for @@WRITE_FILE (default)', () => {
    const level = getApprovalLevel('@@WRITE_FILE', 'anything.txt', 'crew-coder');
    assert.equal(level, 'auto');
  });

  it('returns "auto" for @@READ_FILE (default)', () => {
    const level = getApprovalLevel('@@READ_FILE', 'anything.txt', 'crew-coder');
    assert.equal(level, 'auto');
  });

  it('returns "user" for unknown tool types (fallback)', () => {
    const level = getApprovalLevel('@@UNKNOWN_TOOL', 'anything', 'crew-coder');
    assert.equal(level, 'user');
  });

  it('returns "user" for @@SKILL twitter.post', () => {
    const level = getApprovalLevel('@@SKILL', 'twitter.post', 'crew-coder');
    assert.equal(level, 'user');
  });

  it('returns "admin" for @@SKILL fly.deploy', () => {
    const level = getApprovalLevel('@@SKILL', 'fly.deploy', 'crew-coder');
    assert.equal(level, 'admin');
  });
});

describe('policy-manager — admin bypass', () => {
  beforeEach(() => reloadApprovalPolicies());

  it('admin user always gets "auto" regardless of tool', () => {
    // Add an admin user
    addAdminUser('admin-jeff');
    const level = getApprovalLevel('@@RUN_CMD', 'rm -rf /', 'crew-coder', 'admin-jeff');
    assert.equal(level, 'auto');
    // Clean up
    removeAdminUser('admin-jeff');
  });

  it('non-admin user does not get bypassed', () => {
    const level = getApprovalLevel('@@RUN_CMD', 'rm -rf /', 'crew-coder', 'regular-user');
    assert.equal(level, 'admin');
  });
});

describe('policy-manager — isAdmin', () => {
  beforeEach(() => reloadApprovalPolicies());

  it('returns false for unknown users', () => {
    assert.equal(isAdmin('nobody'), false);
  });

  it('returns true after addAdminUser', () => {
    addAdminUser('test-admin');
    assert.equal(isAdmin('test-admin'), true);
    removeAdminUser('test-admin');
  });
});

describe('policy-manager — getApprovalTimeout', () => {
  beforeEach(() => reloadApprovalPolicies());

  it('returns 60000 for "user" level', () => {
    assert.equal(getApprovalTimeout('user'), 60000);
  });

  it('returns 300000 for "admin" level', () => {
    assert.equal(getApprovalTimeout('admin'), 300000);
  });

  it('returns 60000 for unknown level (fallback)', () => {
    assert.equal(getApprovalTimeout('unknown'), 60000);
  });
});

describe('policy-manager — exportPolicies', () => {
  beforeEach(() => reloadApprovalPolicies());

  it('returns a deep copy (mutations do not affect original)', () => {
    const exported = exportPolicies();
    exported.approvalPolicies['@@NEW'] = { default: 'admin' };
    const original = loadApprovalPolicies();
    assert.equal(original.approvalPolicies['@@NEW'], undefined);
  });
});
