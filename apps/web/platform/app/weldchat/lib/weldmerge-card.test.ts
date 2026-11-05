import { describe, expect, it } from 'vitest';
import {
  cardPullRequestId,
  cardSubject,
  offersReviewActions,
  parseIssueCommand,
  parseMergeSearch,
  readWeldMergeCard,
  shareMessage,
} from './weldmerge-card';

describe('readWeldMergeCard', () => {
  it('reads a card off a message', () => {
    expect(readWeldMergeCard({ weldmerge: { kind: 'review_requested', pullRequestId: 'mpr_1', itemKey: 'review_requested:mpr_1' } })).toEqual({
      kind: 'review_requested',
      pullRequestId: 'mpr_1',
      itemKey: 'review_requested:mpr_1',
    });
  });

  it('ignores messages without a card or with an unknown kind', () => {
    expect(readWeldMergeCard(null)).toBeNull();
    expect(readWeldMergeCard({})).toBeNull();
    expect(readWeldMergeCard({ approvals: [] })).toBeNull();
    expect(readWeldMergeCard({ weldmerge: { kind: 'something_else' } })).toBeNull();
    expect(readWeldMergeCard({ weldmerge: 'nope' })).toBeNull();
  });
});

describe('cardSubject', () => {
  it('maps each kind to the record it loads', () => {
    expect(cardSubject({ kind: 'issue_done', issueId: 'mis_1' })).toEqual({ type: 'issue', id: 'mis_1' });
    expect(cardSubject({ kind: 'checks_failed', pullRequestId: 'mpr_1' })).toEqual({ type: 'pull_request', id: 'mpr_1' });
    expect(cardSubject({ kind: 'release_shipped', releaseId: 'mrl_1' })).toEqual({ type: 'release', id: 'mrl_1' });
    expect(cardSubject({ kind: 'daily_digest' })).toEqual({ type: 'digest' });
  });

  it('has no subject when the id its kind needs is missing', () => {
    expect(cardSubject({ kind: 'issue_created' })).toBeNull();
    expect(cardSubject({ kind: 'review_requested' })).toBeNull();
  });
});

describe('cards and threads', () => {
  it('offers approve and snooze on review requests only', () => {
    expect(offersReviewActions('review_requested')).toBe(true);
    expect(offersReviewActions('checks_failed')).toBe(false);
  });

  it('finds the pull request a thread reply can also be posted on', () => {
    expect(cardPullRequestId({ kind: 'review_requested', pullRequestId: 'mpr_1' })).toBe('mpr_1');
    expect(cardPullRequestId({ kind: 'issue_created', issueId: 'mis_1' })).toBeNull();
    expect(cardPullRequestId(null)).toBeNull();
  });
});

describe('/merge', () => {
  it('takes the search term after the command', () => {
    expect(parseMergeSearch('/merge payment bug')).toBe('payment bug');
    expect(parseMergeSearch('/merge')).toBeNull();
    expect(parseMergeSearch('/merge   ')).toBeNull();
    expect(parseMergeSearch('hello /merge x')).toBeNull();
  });

  it('shares an item as text plus a card', () => {
    expect(shareMessage({ type: 'issue', id: 'mis_1', key: 'PLAT-209', title: 'Login is slow' })).toEqual({
      content: 'PLAT-209 Login is slow',
      metadata: { weldmerge: { kind: 'shared_issue', issueId: 'mis_1' } },
    });
    expect(shareMessage({ type: 'pull_request', id: 'mpr_1', key: 'acme/api #12', title: 'Fix it' }).metadata).toEqual({
      weldmerge: { kind: 'shared_pull_request', pullRequestId: 'mpr_1' },
    });
  });
});

describe('/issue', () => {
  const teams = ['PLAT', 'WEB'];

  it('uses the whole text as the title', () => {
    expect(parseIssueCommand('/issue Fix login', teams)).toEqual({ teamKey: null, title: 'Fix login' });
  });

  it('takes a leading team key', () => {
    expect(parseIssueCommand('/issue web Fix login', teams)).toEqual({ teamKey: 'WEB', title: 'Fix login' });
  });

  it('keeps a lone team key as the title', () => {
    expect(parseIssueCommand('/issue PLAT', teams)).toEqual({ teamKey: null, title: 'PLAT' });
  });

  it('needs a title', () => {
    expect(parseIssueCommand('/issue', teams)).toBeNull();
    expect(parseIssueCommand('/issue   ', teams)).toBeNull();
  });
});
