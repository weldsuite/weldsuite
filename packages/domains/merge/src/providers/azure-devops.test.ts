import { describe, expect, it } from 'vitest';
import {
  azureChecksStatus,
  azureOrganizationUrl,
  azureReviewDecision,
  mapAzurePullRequest,
  parseAzureWebhook,
  verifyAzureBasicAuth,
  type AzurePullRequest,
} from './azure-devops';

const ORG = 'https://dev.azure.com/acme';
const UPDATED = new Date('2026-11-05T12:00:00Z');

const pr: AzurePullRequest = {
  pullRequestId: 77,
  codeReviewId: 77,
  status: 'active',
  createdBy: { displayName: 'S Vermeer', uniqueName: 'SVermeer@acme.com', imageUrl: 'https://az.example/sv' },
  creationDate: '2026-11-04T09:00:00Z',
  title: 'Restrict tabs',
  description: 'Fixes PLAT-209',
  sourceRefName: 'refs/heads/plat-209-tabs',
  targetRefName: 'refs/heads/main',
  isDraft: false,
  lastMergeSourceCommit: { commitId: 'abc123' },
  repository: { id: 'repo-guid', name: 'web', project: { id: 'proj-guid', name: 'Platform' } },
  reviewers: [
    { displayName: 'T Janssen', uniqueName: 'TJanssen@acme.com', vote: 0, imageUrl: 'https://az.example/tj' },
    { displayName: 'Core team', isContainer: true, vote: 0 },
    { displayName: 'M Peters', uniqueName: 'MPeters@acme.com', vote: 10 },
  ],
  labels: [{ name: 'flow' }],
};

describe('mapAzurePullRequest', () => {
  it('maps an active pull request and builds the web URL', () => {
    expect(mapAzurePullRequest(pr, { organizationUrl: ORG, updatedAt: UPDATED })).toMatchObject({
      externalId: '77',
      number: 77,
      state: 'open',
      url: 'https://dev.azure.com/acme/Platform/_git/web/pullrequest/77',
      authorLogin: 'svermeer@acme.com',
      headRef: 'plat-209-tabs',
      baseRef: 'main',
      headSha: 'abc123',
      requestedReviewers: [
        { kind: 'user', login: 'tjanssen@acme.com', avatarUrl: 'https://az.example/tj' },
        { kind: 'team', login: 'Core team' },
      ],
      labels: [{ name: 'flow', color: null }],
      providerCreatedAt: new Date('2026-11-04T09:00:00Z'),
      providerUpdatedAt: UPDATED,
      mergedAt: null,
      closedAt: null,
    });
  });

  it('maps completed and abandoned', () => {
    expect(
      mapAzurePullRequest({ ...pr, status: 'completed', closedDate: '2026-11-05T10:00:00Z' }, { organizationUrl: ORG, updatedAt: UPDATED }),
    ).toMatchObject({
      state: 'merged',
      mergedAt: new Date('2026-11-05T10:00:00Z'),
      closedAt: new Date('2026-11-05T10:00:00Z'),
    });
    expect(mapAzurePullRequest({ ...pr, status: 'abandoned' }, { organizationUrl: ORG, updatedAt: UPDATED })).toMatchObject({
      state: 'closed',
      mergedAt: null,
      closedAt: UPDATED,
    });
  });

  it('prefers the payload web link', () => {
    const web = { web: { href: 'https://dev.azure.com/acme/x/_git/y/pullrequest/77' } };
    expect(mapAzurePullRequest({ ...pr, _links: web }, { organizationUrl: ORG, updatedAt: UPDATED }).url).toBe(
      'https://dev.azure.com/acme/x/_git/y/pullrequest/77',
    );
  });
});

describe('azureReviewDecision', () => {
  it('rejected and waiting win, then approved, then pending', () => {
    expect(azureReviewDecision([{ vote: 10 }, { vote: -10 }])).toBe('changes_requested');
    expect(azureReviewDecision([{ vote: 10 }, { vote: -5 }])).toBe('changes_requested');
    expect(azureReviewDecision([{ vote: 5 }, { vote: 0 }])).toBe('approved');
    expect(azureReviewDecision([{ vote: 10 }])).toBe('approved');
    expect(azureReviewDecision([{ vote: 0 }])).toBe('review_required');
    expect(azureReviewDecision([{ vote: 0, isContainer: true }])).toBeNull();
    expect(azureReviewDecision([])).toBeNull();
    expect(azureReviewDecision(null)).toBeNull();
  });
});

describe('azureChecksStatus', () => {
  it('combines PR statuses and blocking policy evaluations', () => {
    expect(azureChecksStatus([], [])).toBeNull();
    expect(azureChecksStatus([{ state: 'succeeded' }], [{ status: 'rejected', configuration: { isBlocking: true } }])).toBe(
      'failure',
    );
    expect(azureChecksStatus([{ state: 'error' }], [])).toBe('failure');
    expect(azureChecksStatus([{ state: 'succeeded' }], [{ status: 'running' }])).toBe('pending');
    expect(azureChecksStatus([], [{ status: 'queued' }])).toBe('pending');
    expect(azureChecksStatus([{ state: 'succeeded' }], [{ status: 'approved' }])).toBe('success');
    expect(azureChecksStatus([{ state: 'notSet' }], [{ status: 'notApplicable' }])).toBeNull();
    // A non-blocking policy that failed does not fail the checks.
    expect(azureChecksStatus([], [{ status: 'rejected', configuration: { isBlocking: false } }])).toBeNull();
  });
});

describe('parseAzureWebhook', () => {
  const delivery = (eventType: string, resource: Record<string, unknown> = pr as unknown as Record<string, unknown>) => ({
    eventType,
    createdDate: '2026-11-05T11:00:00.000Z',
    resource: { ...resource, url: 'https://dev.azure.com/acme/proj-guid/_apis/git/repositories/repo-guid/pullRequests/77' },
    resourceContainers: { collection: { baseUrl: 'https://dev.azure.com/acme/' } },
  });

  it('maps a created pull request with a review and a checks re-read (the receiver reads the votes back)', () => {
    const events = parseAzureWebhook({}, delivery('git.pullrequest.created'));
    expect(events.map((e) => e.kind)).toEqual(['pull_request', 'review', 'checks']);
    expect(events[0]).toMatchObject({
      repositoryExternalId: 'repo-guid',
      action: 'opened',
      pullRequest: {
        number: 77,
        providerUpdatedAt: new Date('2026-11-05T11:00:00Z'),
        url: 'https://dev.azure.com/acme/Platform/_git/web/pullrequest/77',
      },
    });
    // Deliveries arrive out of order: the votes in this one may be older than the stored decision.
    expect(events[1]).toMatchObject({ number: 77, decision: null });
    expect(events[2]).toMatchObject({ headSha: 'abc123', status: null, numbers: [77] });
  });

  it('maps merged without a checks event', () => {
    const events = parseAzureWebhook(
      {},
      delivery('git.pullrequest.merged', { ...pr, status: 'completed', closedDate: '2026-11-05T10:00:00Z' }),
    );
    expect(events.map((e) => e.kind)).toEqual(['pull_request', 'review']);
    expect(events[0]).toMatchObject({ action: 'merged', pullRequest: { state: 'merged' } });
  });

  it('ignores other event types and malformed bodies', () => {
    expect(parseAzureWebhook({}, delivery('build.complete'))).toEqual([]);
    expect(parseAzureWebhook({}, null)).toEqual([]);
    expect(parseAzureWebhook({}, { eventType: 'git.pullrequest.created', resource: {} })).toEqual([]);
  });

  it('finds the organisation URL', () => {
    expect(azureOrganizationUrl(delivery('git.pullrequest.created'))).toBe('https://dev.azure.com/acme');
    expect(azureOrganizationUrl({ resource: { url: 'https://dev.azure.com/acme/p/_apis/x' } })).toBe('https://dev.azure.com/acme');
  });
});

describe('verifyAzureBasicAuth', () => {
  const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;

  it('checks the password only', () => {
    expect(verifyAzureBasicAuth({ authorization: basic('weldmerge', 's3cret') }, 's3cret')).toBe(true);
    expect(verifyAzureBasicAuth({ authorization: basic('anyone', 's3cret') }, 's3cret')).toBe(true);
    expect(verifyAzureBasicAuth({ authorization: basic('weldmerge', 'nope') }, 's3cret')).toBe(false);
    expect(verifyAzureBasicAuth({ authorization: 'Bearer abc' }, 's3cret')).toBe(false);
    expect(verifyAzureBasicAuth({ authorization: 'Basic !!!' }, 's3cret')).toBe(false);
    expect(verifyAzureBasicAuth({}, 's3cret')).toBe(false);
  });
});
