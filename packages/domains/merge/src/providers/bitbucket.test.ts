import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bitbucketChecksStatus,
  bitbucketLogin,
  bitbucketReviewDecision,
  mapBitbucketPullRequest,
  parseBitbucketWebhook,
  verifyBitbucketSignature,
  type BitbucketPullRequest,
} from './bitbucket';

const user = (nickname: string) => ({
  uuid: `{${nickname}}`,
  nickname,
  links: { avatar: { href: `https://bb.example/${nickname}.png` } },
});

const pr: BitbucketPullRequest = {
  id: 31,
  title: 'Restrict tabs',
  description: 'Fixes PLAT-209',
  state: 'OPEN',
  created_on: '2026-11-04T09:00:00.000000+00:00',
  updated_on: '2026-11-05T09:00:00.000000+00:00',
  author: user('SVermeer'),
  source: { branch: { name: 'plat-209-tabs' }, commit: { hash: 'abc123' } },
  destination: { branch: { name: 'main' } },
  links: { html: { href: 'https://bitbucket.org/acme/web/pull-requests/31' } },
  reviewers: [user('TJanssen'), user('MPeters')],
  participants: [
    { user: user('TJanssen'), role: 'REVIEWER', approved: true, state: 'approved' },
    { user: user('MPeters'), role: 'REVIEWER', approved: false, state: null },
  ],
};

describe('mapBitbucketPullRequest', () => {
  it('maps an open pull request; approved reviewers are no longer requested', () => {
    expect(mapBitbucketPullRequest(pr)).toMatchObject({
      externalId: '31',
      number: 31,
      state: 'open',
      draft: false,
      url: 'https://bitbucket.org/acme/web/pull-requests/31',
      authorLogin: 'svermeer',
      authorAvatarUrl: 'https://bb.example/SVermeer.png',
      headRef: 'plat-209-tabs',
      baseRef: 'main',
      headSha: 'abc123',
      requestedReviewers: [{ kind: 'user', login: 'mpeters', avatarUrl: 'https://bb.example/MPeters.png' }],
      mergedAt: null,
      closedAt: null,
    });
  });

  it('maps merged, declined and superseded with updated_on as the end time', () => {
    const end = new Date('2026-11-05T09:00:00Z');
    expect(mapBitbucketPullRequest({ ...pr, state: 'MERGED' })).toMatchObject({ state: 'merged', mergedAt: end, closedAt: end });
    expect(mapBitbucketPullRequest({ ...pr, state: 'DECLINED' })).toMatchObject({
      state: 'closed',
      mergedAt: null,
      closedAt: end,
    });
    expect(mapBitbucketPullRequest({ ...pr, state: 'SUPERSEDED' }).state).toBe('closed');
  });

  it('falls back to the account id for a login', () => {
    expect(bitbucketLogin({ account_id: 'ABC' })).toBe('abc');
    expect(bitbucketLogin(null)).toBeNull();
  });
});

describe('review and checks', () => {
  it('changes requested wins, then approved, then pending reviewers', () => {
    expect(bitbucketReviewDecision(pr)).toBe('approved');
    expect(
      bitbucketReviewDecision({
        ...pr,
        participants: [...pr.participants!, { user: user('Z'), role: 'REVIEWER', approved: false, state: 'changes_requested' }],
      }),
    ).toBe('changes_requested');
    expect(
      bitbucketReviewDecision({
        ...pr,
        participants: [{ user: user('MPeters'), role: 'REVIEWER', approved: false, state: null }],
      }),
    ).toBe('review_required');
    expect(bitbucketReviewDecision({ ...pr, reviewers: [], participants: [] })).toBeNull();
  });

  it('only counts reviewers, not participants', () => {
    expect(
      bitbucketReviewDecision({
        ...pr,
        reviewers: [],
        participants: [{ user: user('Q'), role: 'PARTICIPANT', approved: true }],
      }),
    ).toBeNull();
  });

  it('combines build statuses', () => {
    expect(bitbucketChecksStatus([])).toBeNull();
    expect(bitbucketChecksStatus([{ state: 'SUCCESSFUL' }, { state: 'FAILED' }])).toBe('failure');
    expect(bitbucketChecksStatus([{ state: 'SUCCESSFUL' }, { state: 'INPROGRESS' }])).toBe('pending');
    expect(bitbucketChecksStatus([{ state: 'SUCCESSFUL' }])).toBe('success');
    expect(bitbucketChecksStatus([{ state: 'STOPPED' }])).toBe('neutral');
  });
});

describe('parseBitbucketWebhook', () => {
  const body = { pullrequest: pr, repository: { uuid: '{repo-1}', full_name: 'acme/web' }, actor: user('SVermeer') };

  it('maps created and updated pull requests', () => {
    expect(parseBitbucketWebhook({ 'x-event-key': 'pullrequest:created' }, body)).toMatchObject([
      { kind: 'pull_request', repositoryExternalId: '{repo-1}', action: 'opened', pullRequest: { number: 31 } },
    ]);
    expect(parseBitbucketWebhook({ 'x-event-key': 'pullrequest:updated' }, body)[0]).toMatchObject({ action: 'edited' });
  });

  it('maps fulfilled and rejected', () => {
    const merged = parseBitbucketWebhook(
      { 'x-event-key': 'pullrequest:fulfilled' },
      { ...body, pullrequest: { ...pr, state: 'MERGED' } },
    );
    expect(merged[0]).toMatchObject({ action: 'merged', pullRequest: { state: 'merged' } });
    expect(
      parseBitbucketWebhook({ 'x-event-key': 'pullrequest:rejected' }, { ...body, pullrequest: { ...pr, state: 'DECLINED' } })[0],
    ).toMatchObject({ action: 'closed' });
  });

  it('adds a review event for approvals and change requests', () => {
    const keys = [
      'pullrequest:approved',
      'pullrequest:unapproved',
      'pullrequest:changes_request_created',
      'pullrequest:changes_request_removed',
    ];
    for (const key of keys) {
      expect(parseBitbucketWebhook({ 'x-event-key': key }, body).map((e) => e.kind)).toEqual(['pull_request', 'review']);
    }
  });

  it('maps a commit status to a checks event', () => {
    expect(
      parseBitbucketWebhook(
        { 'x-event-key': 'repo:commit_status_updated' },
        { repository: { uuid: '{repo-1}' }, commit_status: { state: 'FAILED', commit: { hash: 'abc123' } } },
      ),
    ).toEqual([{ kind: 'checks', repositoryExternalId: '{repo-1}', headSha: 'abc123', status: null, numbers: [] }]);
  });

  it('ignores comments, other keys and malformed bodies', () => {
    expect(parseBitbucketWebhook({ 'x-event-key': 'pullrequest:comment_created' }, body)).toEqual([]);
    expect(parseBitbucketWebhook({ 'x-event-key': 'repo:push' }, body)).toEqual([]);
    expect(parseBitbucketWebhook({}, body)).toEqual([]);
    expect(parseBitbucketWebhook({ 'x-event-key': 'pullrequest:created' }, { pullrequest: pr })).toEqual([]);
  });
});

describe('verifyBitbucketSignature', () => {
  const secret = 'hook-secret';
  const raw = JSON.stringify({ a: 1 });
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

  it('accepts the HMAC of the exact body', async () => {
    expect(await verifyBitbucketSignature({ 'x-hub-signature': signature }, raw, secret)).toBe(true);
    expect(await verifyBitbucketSignature({ 'X-Hub-Signature': signature }, raw, secret)).toBe(true);
  });

  it('rejects a changed body, a wrong secret, and a missing header', async () => {
    expect(await verifyBitbucketSignature({ 'x-hub-signature': signature }, `${raw} `, secret)).toBe(false);
    expect(await verifyBitbucketSignature({ 'x-hub-signature': signature }, raw, 'other')).toBe(false);
    expect(await verifyBitbucketSignature({}, raw, secret)).toBe(false);
  });
});
