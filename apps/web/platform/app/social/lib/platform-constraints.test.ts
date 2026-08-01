/**
 * Unit tests for the composer's pre-submit platform constraints.
 *
 * These guard a failure that is invisible until publish time: PostPeer rejects
 * a text-only Instagram post with a 500 AFTER the row is created and the
 * publish slot claimed, so anything that slips past this check costs the user a
 * failed publish rather than a validation message.
 */

import { describe, it, expect } from 'vitest';
import {
  accountsBlockedByMissingMedia,
  platformRequiresMedia,
  PLATFORMS_REQUIRING_MEDIA,
} from './platform-constraints';

const IG = { id: 'sac_ig', platform: 'instagram' };
const IG2 = { id: 'sac_ig2', platform: 'instagram' };
const X = { id: 'sac_x', platform: 'twitter' };
const LI = { id: 'sac_li', platform: 'linkedin' };
const ALL = [IG, IG2, X, LI];

describe('platformRequiresMedia', () => {
  it('is true for Instagram and false for the text-capable platforms', () => {
    expect(platformRequiresMedia('instagram')).toBe(true);
    for (const p of ['twitter', 'linkedin', 'facebook', 'tiktok']) {
      expect(platformRequiresMedia(p)).toBe(false);
    }
  });

  // Platform strings reach us from the DB enum in lower case; an unknown or
  // differently-cased value must not silently become "requires media" and
  // block a publish that would have worked.
  it('does not match on unknown or differently-cased values', () => {
    expect(platformRequiresMedia('Instagram')).toBe(false);
    expect(platformRequiresMedia('')).toBe(false);
    expect(platformRequiresMedia('instagram_business')).toBe(false);
  });

  it('keeps the exported list in sync with the predicate', () => {
    for (const p of PLATFORMS_REQUIRING_MEDIA) expect(platformRequiresMedia(p)).toBe(true);
  });
});

describe('accountsBlockedByMissingMedia', () => {
  it('flags a selected Instagram account when no media is attached', () => {
    expect(accountsBlockedByMissingMedia(ALL, [IG.id], [])).toEqual([IG]);
  });

  // The whole point of returning accounts rather than a boolean: a workspace
  // can have several Instagram channels and the message names them.
  it('returns every offending account, not just the first', () => {
    expect(accountsBlockedByMissingMedia(ALL, [IG.id, IG2.id, X.id], [])).toEqual([IG, IG2]);
  });

  it('clears as soon as any media is attached', () => {
    expect(accountsBlockedByMissingMedia(ALL, [IG.id], ['smd_1'])).toEqual([]);
  });

  it('never blocks a text-only post to platforms that allow it', () => {
    expect(accountsBlockedByMissingMedia(ALL, [X.id, LI.id], [])).toEqual([]);
  });

  // An Instagram account that exists in the workspace but is NOT selected must
  // not block the publish — otherwise connecting Instagram would break posting
  // to every other channel.
  it('ignores unselected Instagram accounts', () => {
    expect(accountsBlockedByMissingMedia(ALL, [X.id], [])).toEqual([]);
  });

  it('returns nothing when no accounts are selected', () => {
    expect(accountsBlockedByMissingMedia(ALL, [], [])).toEqual([]);
  });

  it('ignores selected ids that match no known account', () => {
    expect(accountsBlockedByMissingMedia(ALL, ['sac_missing'], [])).toEqual([]);
  });
});
