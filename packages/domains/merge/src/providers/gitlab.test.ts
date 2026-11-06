import { describe, expect, it } from 'vitest';
import {
  gitlabChecksStatus,
  gitlabPipelineStatus,
  gitlabReviewDecision,
  mapGitlabIssue,
  mapGitlabMergeRequest,
  mapGitlabNote,
  parseGitlabWebhook,
  verifyGitlabToken,
  type GitlabMergeRequest,
} from './gitlab';
import { parseProviderDate } from './shared';

const mr: GitlabMergeRequest = {
  id: 7001,
  iid: 12,
  title: 'Draft: Restrict project tab writes',
  description: 'Fixes PLAT-209',
  state: 'opened',
  draft: true,
  created_at: '2026-11-04T09:00:00.000Z',
  updated_at: '2026-11-05T09:00:00.000Z',
  web_url: 'https://gitlab.com/acme/web/-/merge_requests/12',
  author: { username: 'SVermeer', avatar_url: 'https://gl.example/sv.png' },
  source_branch: 'plat-209-tabs',
  target_branch: 'main',
  sha: 'abc123',
  diff_refs: { head_sha: 'def456' },
  reviewers: [{ username: 'TJanssen', avatar_url: null }],
  labels: ['flow', { title: 'bug', color: '#d73a4a' }],
  changes_count: '6',
};

describe('mapGitlabMergeRequest', () => {
  it('maps an open draft merge request', () => {
    expect(mapGitlabMergeRequest(mr)).toMatchObject({
      externalId: '7001',
      number: 12,
      state: 'open',
      draft: true,
      authorLogin: 'svermeer',
      headRef: 'plat-209-tabs',
      baseRef: 'main',
      headSha: 'def456',
      changedFiles: 6,
      requestedReviewers: [{ kind: 'user', login: 'tjanssen', avatarUrl: null }],
      labels: [
        { name: 'flow', color: null },
        { name: 'bug', color: '#d73a4a' },
      ],
      mergedAt: null,
      closedAt: null,
    });
  });

  it('maps merged, closed and locked', () => {
    const merged = mapGitlabMergeRequest({ ...mr, state: 'merged', merged_at: '2026-11-05T10:00:00Z' });
    expect(merged.state).toBe('merged');
    expect(merged.mergedAt).toEqual(new Date('2026-11-05T10:00:00Z'));
    expect(mapGitlabMergeRequest({ ...mr, state: 'closed', closed_at: '2026-11-05T11:00:00Z' })).toMatchObject({
      state: 'closed',
      mergedAt: null,
      closedAt: new Date('2026-11-05T11:00:00Z'),
    });
    expect(mapGitlabMergeRequest({ ...mr, state: 'locked' }).state).toBe('open');
  });

  it('leaves the size null when the list row has no change count', () => {
    expect(mapGitlabMergeRequest({ ...mr, changes_count: undefined }).changedFiles).toBeNull();
    expect(mapGitlabMergeRequest({ ...mr, changes_count: '1000+' }).changedFiles).toBeNull();
  });
});

describe('review and checks', () => {
  it('approved wins, then unresolved blocking discussions, then pending reviewers', () => {
    const approvals = { approved: true, approved_by: [{ user: { username: 'a' } }], approvals_left: 0 };
    expect(gitlabReviewDecision({ approvals, blockingDiscussionsResolved: false, requestedReviewerCount: 1 })).toBe('approved');
    expect(gitlabReviewDecision({ approvals: null, blockingDiscussionsResolved: false, requestedReviewerCount: 1 })).toBe(
      'changes_requested',
    );
    expect(gitlabReviewDecision({ approvals: null, blockingDiscussionsResolved: true, requestedReviewerCount: 2 })).toBe(
      'review_required',
    );
    expect(gitlabReviewDecision({ approvals: null, blockingDiscussionsResolved: true, requestedReviewerCount: 0 })).toBeNull();
    // An approval that still leaves approvals missing is not enough.
    expect(
      gitlabReviewDecision({
        approvals: { approved: false, approved_by: [{ user: { username: 'a' } }], approvals_left: 1 },
        blockingDiscussionsResolved: true,
        requestedReviewerCount: 0,
      }),
    ).toBeNull();
  });

  it('maps pipeline statuses', () => {
    expect(gitlabPipelineStatus('success')).toBe('success');
    expect(gitlabPipelineStatus('failed')).toBe('failure');
    expect(gitlabPipelineStatus('running')).toBe('pending');
    expect(gitlabPipelineStatus('canceled')).toBe('neutral');
    expect(gitlabPipelineStatus('nonsense')).toBeNull();
    expect(gitlabChecksStatus([])).toBeNull();
    expect(gitlabChecksStatus([{ status: 'failed' }, { status: 'success' }])).toBe('failure');
  });
});

describe('issues and notes', () => {
  it('maps an issue', () => {
    expect(
      mapGitlabIssue({
        id: 1,
        iid: 4,
        title: 'Bug',
        description: null,
        state: 'closed',
        labels: ['bug'],
        assignees: [{ username: 'Alice' }],
        author: { username: 'Bob', avatar_url: 'x' },
        web_url: 'https://gitlab.com/acme/web/-/issues/4',
        updated_at: '2026-11-05T09:00:00Z',
      }),
    ).toMatchObject({
      number: 4,
      body: '',
      state: 'closed',
      stateReason: null,
      assigneeLogin: 'alice',
      authorLogin: 'bob',
      labels: ['bug'],
    });
  });

  it('maps a note', () => {
    expect(
      mapGitlabNote({ id: 9, body: 'hi', author: { username: 'Al' }, created_at: '2026-11-05T09:00:00Z' }, 4),
    ).toMatchObject({
      externalId: '9',
      issueNumber: 4,
      authorLogin: 'al',
      updatedAt: new Date('2026-11-05T09:00:00Z'),
    });
  });
});

describe('parseProviderDate', () => {
  it('reads GitLab webhook dates and ISO dates', () => {
    expect(parseProviderDate('2026-11-05 10:00:00 UTC')).toEqual(new Date('2026-11-05T10:00:00Z'));
    expect(parseProviderDate('2026-11-05 10:00:00 +0100')).toEqual(new Date('2026-11-05T09:00:00Z'));
    expect(parseProviderDate('2026-11-05T10:00:00Z')).toEqual(new Date('2026-11-05T10:00:00Z'));
    expect(parseProviderDate('garbage')).toEqual(new Date(0));
    expect(parseProviderDate(null)).toEqual(new Date(0));
  });
});

const mrHook = (action: string, extra: Record<string, unknown> = {}) => ({
  object_kind: 'merge_request',
  user: { username: 'SVermeer', avatar_url: 'https://gl.example/sv.png' },
  project: { id: 55, path_with_namespace: 'acme/web' },
  object_attributes: {
    id: 7001,
    iid: 12,
    title: 'Restrict tabs',
    description: 'Fixes PLAT-209',
    state: 'opened',
    action,
    url: 'https://gitlab.com/acme/web/-/merge_requests/12',
    source_branch: 'plat-209-tabs',
    target_branch: 'main',
    created_at: '2026-11-04 09:00:00 UTC',
    updated_at: '2026-11-05 09:00:00 UTC',
    last_commit: { id: 'abc123' },
    ...extra,
  },
  labels: [{ title: 'flow', color: '#6e56cf' }],
  reviewers: [{ username: 'TJanssen' }],
});

describe('parseGitlabWebhook', () => {
  it('maps an opened merge request, with the author from the actor', () => {
    const [event] = parseGitlabWebhook({}, mrHook('open'));
    expect(event).toMatchObject({
      kind: 'pull_request',
      repositoryExternalId: '55',
      action: 'opened',
      pullRequest: {
        number: 12,
        state: 'open',
        authorLogin: 'svermeer',
        headSha: 'abc123',
        providerUpdatedAt: new Date('2026-11-05T09:00:00Z'),
        labels: [{ name: 'flow', color: '#6e56cf' }],
        requestedReviewers: [{ kind: 'user', login: 'tjanssen', avatarUrl: null }],
      },
    });
  });

  it('does not take the actor for the author of an update', () => {
    const [event] = parseGitlabWebhook({}, mrHook('update'));
    expect(event).toMatchObject({ action: 'edited', pullRequest: { authorLogin: null } });
  });

  it('maps a merge', () => {
    const [event] = parseGitlabWebhook({}, mrHook('merge', { state: 'merged' }));
    expect(event).toMatchObject({ action: 'merged', pullRequest: { state: 'merged' } });
  });

  it('adds a review event for an approval', () => {
    const events = parseGitlabWebhook({}, mrHook('approved'));
    expect(events.map((e) => e.kind)).toEqual(['pull_request', 'review']);
    expect(events[1]).toMatchObject({ number: 12, decision: null });
  });

  it('maps a pipeline to a checks event the receiver re-reads (hooks arrive out of order)', () => {
    expect(
      parseGitlabWebhook(
        {},
        {
          object_kind: 'pipeline',
          project: { id: 55 },
          object_attributes: { id: 1, sha: 'abc123', status: 'failed' },
          merge_request: { iid: 12 },
        },
      ),
    ).toEqual([{ kind: 'checks', repositoryExternalId: '55', headSha: 'abc123', status: null, numbers: [12] }]);
  });

  it('maps an issue and an issue note, and skips merge request and system notes', () => {
    const issue = parseGitlabWebhook(
      {},
      {
        object_kind: 'issue',
        user: { username: 'Bob' },
        project: { id: 55 },
        object_attributes: {
          id: 3,
          iid: 4,
          title: 'Bug',
          description: 'x',
          state: 'opened',
          action: 'open',
          url: 'https://gl/i/4',
          updated_at: '2026-11-05 09:00:00 UTC',
        },
        labels: [{ title: 'bug' }],
        assignees: [{ username: 'Alice' }],
      },
    );
    expect(issue).toMatchObject([
      {
        kind: 'issue',
        action: 'opened',
        issue: { number: 4, labels: ['bug'], assigneeLogin: 'alice', authorLogin: 'bob', state: 'open' },
      },
    ]);

    const note = (noteableType: string, system = false) =>
      parseGitlabWebhook(
        {},
        {
          object_kind: 'note',
          user: { username: 'Al', avatar_url: 'a' },
          project: { id: 55 },
          issue: { iid: 4 },
          object_attributes: {
            id: 9,
            note: 'hello',
            noteable_type: noteableType,
            system,
            created_at: '2026-11-05 09:00:00 UTC',
            updated_at: '2026-11-05 09:00:00 UTC',
          },
        },
      );
    expect(note('Issue')).toMatchObject([
      { kind: 'issue_comment', action: 'created', comment: { externalId: '9', issueNumber: 4, body: 'hello', authorLogin: 'al' } },
    ]);
    expect(note('MergeRequest')).toEqual([]);
    expect(note('Issue', true)).toEqual([]);
  });

  it('ignores other kinds and malformed bodies', () => {
    expect(parseGitlabWebhook({}, { object_kind: 'push', project: { id: 1 } })).toEqual([]);
    expect(parseGitlabWebhook({}, null)).toEqual([]);
    expect(parseGitlabWebhook({}, { object_kind: 'merge_request' })).toEqual([]);
  });
});

describe('verifyGitlabToken', () => {
  it('compares the token with the secret', () => {
    expect(verifyGitlabToken({ 'x-gitlab-token': 's3cret' }, 's3cret')).toBe(true);
    expect(verifyGitlabToken({ 'x-gitlab-token': 'other' }, 's3cret')).toBe(false);
    expect(verifyGitlabToken({}, 's3cret')).toBe(false);
    expect(verifyGitlabToken({ 'x-gitlab-token': '' }, '')).toBe(false);
  });
});
