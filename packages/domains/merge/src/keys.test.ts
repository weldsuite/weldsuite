import { describe, expect, it } from 'vitest';
import { findIssueKeyMentions, parseIssueKey } from './keys';

describe('findIssueKeyMentions', () => {
  it('finds a key in a branch name, case-insensitively', () => {
    expect(findIssueKeyMentions({ headRef: 'gert/plat-209-fix-tab-writes' })).toEqual([
      { teamKey: 'PLAT', number: 209, key: 'PLAT-209', closes: true },
    ]);
  });

  it('collects branch, title and body in first-seen order without duplicates', () => {
    const found = findIssueKeyMentions({
      headRef: 'plat-209-tabs',
      title: 'PLAT-209: restrict tab writes (API-97)',
      body: 'Also touches MOB-12.',
    });
    expect(found.map((m) => m.key)).toEqual(['PLAT-209', 'API-97', 'MOB-12']);
  });

  it('does not close after reference words', () => {
    const found = findIssueKeyMentions({
      title: 'Refactor tabs',
      body: 'Refs PLAT-1\nPart of: PLAT-2\nrelated to PLAT-3\nFixes PLAT-4',
    });
    expect(Object.fromEntries(found.map((m) => [m.key, m.closes]))).toEqual({
      'PLAT-1': false,
      'PLAT-2': false,
      'PLAT-3': false,
      'PLAT-4': true,
    });
  });

  it('closes when any mention closes', () => {
    const found = findIssueKeyMentions({ title: 'PLAT-5 tabs', body: 'refs PLAT-5' });
    expect(found).toEqual([{ teamKey: 'PLAT', number: 5, key: 'PLAT-5', closes: true }]);
  });

  it('ignores digits-first tokens, zero numbers and keys glued to other characters', () => {
    expect(findIssueKeyMentions({ title: '2024-11 release, PLAT-0, PLAT-3x, PLAT_3, sha256-abc' })).toEqual([]);
  });

  it('ignores GitHub issue references', () => {
    expect(findIssueKeyMentions({ body: 'Fixes #1460' })).toEqual([]);
  });
});

describe('parseIssueKey', () => {
  it('parses and upper-cases a key', () => {
    expect(parseIssueKey(' plat-209 ')).toEqual({ teamKey: 'PLAT', number: 209, key: 'PLAT-209' });
  });

  it('rejects ids and malformed values', () => {
    expect(parseIssueKey('mis_abc123')).toBeNull();
    expect(parseIssueKey('PLAT-')).toBeNull();
    expect(parseIssueKey('P-1')).toBeNull();
  });
});
