import { describe, expect, it } from 'vitest';
import {
  issueStatusForPullRequest,
  pullRequestPhase,
  shouldEvaluateLink,
  statusTimestamps,
} from './automation';

describe('pullRequestPhase', () => {
  it('maps state and draft', () => {
    expect(pullRequestPhase({ state: 'open', draft: true })).toBe('draft');
    expect(pullRequestPhase({ state: 'open', draft: false })).toBe('ready');
    expect(pullRequestPhase({ state: 'merged', draft: false })).toBe('merged');
    expect(pullRequestPhase({ state: 'closed', draft: true })).toBe('closed');
  });
});

describe('shouldEvaluateLink', () => {
  it('runs on a phase change or a new link only', () => {
    expect(shouldEvaluateLink(null, 'ready', false)).toBe(true);
    expect(shouldEvaluateLink('ready', 'ready', false)).toBe(false);
    expect(shouldEvaluateLink('ready', 'ready', true)).toBe(true);
    expect(shouldEvaluateLink('draft', 'ready', false)).toBe(true);
  });
});

describe('issueStatusForPullRequest', () => {
  it('moves forward only', () => {
    expect(issueStatusForPullRequest('backlog', 'draft', true)).toBe('in_progress');
    expect(issueStatusForPullRequest('in_review', 'draft', true)).toBeNull();
    expect(issueStatusForPullRequest('todo', 'ready', true)).toBe('in_review');
    expect(issueStatusForPullRequest('in_progress', 'ready', true)).toBe('in_review');
    expect(issueStatusForPullRequest('in_review', 'ready', true)).toBeNull();
  });

  it('completes on merge only when the link closes', () => {
    expect(issueStatusForPullRequest('in_review', 'merged', true)).toBe('done');
    expect(issueStatusForPullRequest('in_review', 'merged', false)).toBeNull();
  });

  it('never moves done or canceled issues, and ignores closed pull requests', () => {
    expect(issueStatusForPullRequest('done', 'ready', true)).toBeNull();
    expect(issueStatusForPullRequest('canceled', 'merged', true)).toBeNull();
    expect(issueStatusForPullRequest('in_review', 'closed', true)).toBeNull();
  });
});

describe('statusTimestamps', () => {
  const now = new Date('2026-11-05T10:00:00Z');
  const none = { startedAt: null, completedAt: null, canceledAt: null };

  it('sets started once and keeps it', () => {
    const started = statusTimestamps('in_progress', none, now);
    expect(started.startedAt).toEqual(now);
    const later = new Date('2026-11-06T10:00:00Z');
    expect(statusTimestamps('in_review', started, later).startedAt).toEqual(now);
  });

  it('holds completed and canceled only while in that status', () => {
    const done = statusTimestamps('done', none, now);
    expect(done.completedAt).toEqual(now);
    expect(statusTimestamps('in_review', done, now).completedAt).toBeNull();
    const canceled = statusTimestamps('canceled', none, now);
    expect(canceled.canceledAt).toEqual(now);
    expect(canceled.startedAt).toBeNull();
  });
});
