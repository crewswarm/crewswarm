import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DOMAINS, detectDomain, buildDomainContext, logDomainRouting } from '../../lib/domain-planning/detector.mjs';

describe('DOMAINS', () => {
  it('exports an object with known domain keys', () => {
    assert.ok(typeof DOMAINS === 'object');
    assert.ok('crew-cli' in DOMAINS);
    assert.ok('frontend' in DOMAINS);
    assert.ok('core' in DOMAINS);
    assert.ok('integrations' in DOMAINS);
    assert.ok('docs' in DOMAINS);
  });

  it('each domain has pmAgent, keywords, description, subdirs', () => {
    for (const [id, domain] of Object.entries(DOMAINS)) {
      assert.ok(typeof domain.pmAgent === 'string', `${id}.pmAgent should be string`);
      assert.ok(Array.isArray(domain.keywords), `${id}.keywords should be array`);
      assert.ok(typeof domain.description === 'string', `${id}.description should be string`);
      assert.ok(Array.isArray(domain.subdirs), `${id}.subdirs should be array`);
    }
  });
});

describe('detectDomain', () => {
  it('detects crew-cli domain from CLI keywords', () => {
    const result = detectDomain('Add new CLI command for crew exec with pipeline support');
    assert.equal(result.domain, 'crew-cli');
    assert.equal(result.pmAgent, 'crew-pm-cli');
    assert.ok(result.confidence > 0);
  });

  it('detects frontend domain from dashboard keywords', () => {
    const result = detectDomain('Fix the dashboard UI tab navigation and CSS styles');
    assert.equal(result.domain, 'frontend');
    assert.equal(result.pmAgent, 'crew-pm-frontend');
  });

  it('detects core domain from orchestration keywords', () => {
    const result = detectDomain('Fix gateway-bridge WebSocket reconnect in crew-lead dispatch');
    assert.equal(result.domain, 'core');
    assert.equal(result.pmAgent, 'crew-pm-core');
  });

  it('detects integrations domain from Telegram keyword', () => {
    const result = detectDomain('Add Telegram bot command for status bridge integration');
    assert.equal(result.domain, 'integrations');
  });

  it('detects docs domain from documentation keywords', () => {
    const result = detectDomain('Update README documentation and markdown guide for tutorial');
    assert.equal(result.domain, 'docs');
  });

  it('returns null domain with default PM when no strong match', () => {
    const result = detectDomain('fix a typo');
    assert.equal(result.domain, null);
    assert.equal(result.pmAgent, 'crew-pm');
    assert.equal(result.confidence, 0);
  });

  it('returns null domain when score is below threshold', () => {
    // Single very short keyword match should score < 2
    const result = detectDomain('CLI');
    // 'CLI' scores 1 for crew-cli; threshold is 2, so domain should be null
    assert.equal(result.domain, null);
  });

  it('confidence is between 0 and 1', () => {
    const result = detectDomain('Add new crew-cli command with TypeScript executor support');
    if (result.domain !== null) {
      assert.ok(result.confidence >= 0 && result.confidence <= 1);
    }
  });

  it('is case-insensitive', () => {
    const lower = detectDomain('update the dashboard ui and frontend css styles.css');
    const upper = detectDomain('Update The Dashboard UI And Frontend CSS Styles.css');
    assert.equal(lower.domain, upper.domain);
  });

  it('longer keyword matches score higher than shorter ones', () => {
    // 'orchestrator' (12 chars, score 3) > 'CLI' (3 chars, score 1)
    const result = detectDomain('refactor the orchestrator coordinator for WebSocket message bus');
    assert.equal(result.domain, 'core');
  });
});

describe('buildDomainContext', () => {
  it('returns empty string for null domain', () => {
    assert.equal(buildDomainContext(null, 'some task'), '');
  });

  it('returns empty string for unknown domain', () => {
    assert.equal(buildDomainContext('unknown-domain', 'some task'), '');
  });

  it('returns a non-empty string for valid domain', () => {
    const ctx = buildDomainContext('crew-cli', 'add executor command');
    assert.ok(ctx.length > 0);
    assert.ok(ctx.includes('crew-cli'));
  });

  it('includes domain description in context', () => {
    const ctx = buildDomainContext('frontend', 'fix dashboard tab');
    assert.ok(ctx.includes('frontend'));
  });

  it('includes subdirs in context', () => {
    const ctx = buildDomainContext('core', 'fix gateway');
    assert.ok(ctx.includes('lib/') || ctx.includes('engines/'));
  });

  it('builds context for all known domains without throwing', () => {
    for (const domainId of Object.keys(DOMAINS)) {
      assert.doesNotThrow(() => buildDomainContext(domainId, 'test task'));
    }
  });
});

describe('logDomainRouting', () => {
  it('logs without throwing for matched domain', () => {
    const detection = { domain: 'crew-cli', pmAgent: 'crew-pm-cli', confidence: 0.75 };
    assert.doesNotThrow(() => logDomainRouting('fix CLI executor', detection));
  });

  it('logs without throwing for unmatched domain', () => {
    const detection = { domain: null, pmAgent: 'crew-pm', confidence: 0 };
    assert.doesNotThrow(() => logDomainRouting('general task', detection));
  });
});
