import { describe, expect, it } from 'vitest';
import {
  combineCheckSuites,
  isNotOlder,
  mapGithubPullRequest,
  mergeMirrorUpdate,
  reviewDecisionFromReviews,
  type GithubPullRequest,
} from './github';

const base: GithubPullRequest = {
  id: 9001,
  number: 1466,
  title: 'Restrict project tab writes',
  body: 'Fixes PLAT-209',
  state: 'open',
  draft: false,
  merged: false,
  merged_at: null,
  closed_at: null,
  created_at: '2026-11-04T09:00:00Z',
  updated_at: '2026-11-05T09:00:00Z',
  html_url: 'https://github.com/weldsuite/weldsuite/pull/1466',
  user: { login: 'SVermeer', avatar_url: 'https://avatars.example/sv' },
  head: { ref: 'plat-209-tabs', sha: 'abc123' },
  base: { ref: 'develop' },
  additions: 120,
  deletions: 14,
  changed_files: 6,
  requested_reviewers: [{ login: 'TJanssen' }],
  requested_teams: [{ slug: 'platform' }],
  labels: [{ name: 'flow', color: '6e56cf' }],
};

describe('mapGithubPullRequest', () => {
  it('maps an open pull request', () => {
    const m = mapGithubPullRequest(base);
    expect(m).toMatchObject({
      externalId: '9001',
      state: 'open',
      authorLogin: 'svermeer',
      headRef: 'plat-209-tabs',
      requestedReviewers: [
        { kind: 'user', login: 'tjanssen', avatarUrl: null },
        { kind: 'team', login: 'platform' },
      ],
      labels: [{ name: 'flow', color: '#6e56cf' }],
      mergedAt: null,
    });
  });

  it('maps merged and closed', () => {
    expect(mapGithubPullRequest({ ...base, state: 'closed', merged: true, merged_at: '2026-11-05T10:00:00Z' }).state).toBe(
      'merged',
    );
    expect(mapGithubPullRequest({ ...base, state: 'closed', merged_at: '2026-11-05T10:00:00Z', merged: undefined }).state).toBe(
      'merged',
    );
    expect(mapGithubPullRequest({ ...base, state: 'closed', closed_at: '2026-11-05T10:00:00Z' }).state).toBe('closed');
  });

  it('keeps stored size numbers when a list row lacks them', () => {
    const row = mapGithubPullRequest({ ...base, additions: undefined, deletions: undefined, changed_files: undefined });
    expect(mergeMirrorUpdate(row, { additions: 1, deletions: 2, changedFiles: 3 })).toMatchObject({
      additions: 1,
      deletions: 2,
      changedFiles: 3,
    });
  });
});

describe('isNotOlder', () => {
  it('accepts newer and equal copies only', () => {
    const t = new Date('2026-11-05T09:00:00Z');
    expect(isNotOlder(t, null)).toBe(true);
    expect(isNotOlder(t, t)).toBe(true);
    expect(isNotOlder(new Date('2026-11-05T08:00:00Z'), t)).toBe(false);
  });
});

describe('combineCheckSuites', () => {
  it('lets failure win, then pending', () => {
    expect(
      combineCheckSuites([
        { status: 'completed', conclusion: 'success' },
        { status: 'in_progress', conclusion: null },
        { status: 'completed', conclusion: 'failure' },
      ]),
    ).toBe('failure');
    expect(combineCheckSuites([{ status: 'completed', conclusion: 'success' }, { status: 'queued', conclusion: null }])).toBe(
      'pending',
    );
    expect(combineCheckSuites([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }])).toBe(
      'success',
    );
  });

  it('ignores empty suites and returns null when none ran', () => {
    expect(combineCheckSuites([{ status: 'queued', conclusion: null, latest_check_runs_count: 0 }])).toBeNull();
    expect(combineCheckSuites([])).toBeNull();
  });
});

describe('reviewDecisionFromReviews', () => {
  it('uses each reviewer’s latest decisive review', () => {
    expect(
      reviewDecisionFromReviews(
        [
          { user: { login: 'tj' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-11-05T08:00:00Z' },
          { user: { login: 'tj' }, state: 'COMMENTED', submitted_at: '2026-11-05T08:30:00Z' },
          { user: { login: 'tj' }, state: 'APPROVED', submitted_at: '2026-11-05T09:00:00Z' },
        ],
        0,
      ),
    ).toBe('approved');
  });

  it('lets changes requested win and falls back to review required', () => {
    expect(
      reviewDecisionFromReviews(
        [
          { user: { login: 'a' }, state: 'APPROVED', submitted_at: '2026-11-05T08:00:00Z' },
          { user: { login: 'b' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-11-05T08:10:00Z' },
        ],
        1,
      ),
    ).toBe('changes_requested');
    expect(reviewDecisionFromReviews([], 2)).toBe('review_required');
    expect(reviewDecisionFromReviews([], 0)).toBeNull();
  });
});
