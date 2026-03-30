import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadPrivacyControls, applyPrivacyToCorrection } from '../../src/team/index.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('team', () => {
  it('loadPrivacyControls returns defaults for fresh dir', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'team-'));
    try {
      const privacy = await loadPrivacyControls(tmp);
      assert.equal(privacy.sharePrompt, true);
      assert.equal(privacy.shareOriginal, true);
      assert.equal(privacy.shareCorrected, true);
      assert.equal(privacy.shareTags, true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('applyPrivacyToCorrection respects sharePrompt=false', () => {
    const entry = { timestamp: 't', prompt: 'p', original: 'o', corrected: 'c', tags: ['a'] };
    const privacy = { sharePrompt: false, shareOriginal: true, shareCorrected: true, shareTags: true };
    const result = applyPrivacyToCorrection(entry, privacy);
    assert.equal(result.prompt, undefined);
    assert.equal(result.original, 'o');
  });

  it('applyPrivacyToCorrection includes all when all true', () => {
    const entry = { timestamp: 't', prompt: 'p', original: 'o', corrected: 'c', tags: ['a'] };
    const privacy = { sharePrompt: true, shareOriginal: true, shareCorrected: true, shareTags: true };
    const result = applyPrivacyToCorrection(entry, privacy);
    assert.equal(result.prompt, 'p');
    assert.equal(result.corrected, 'c');
  });
});
