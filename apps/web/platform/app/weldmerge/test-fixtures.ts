/** Builders for the WeldMerge tests: inbox items and their pull requests as the API returns them. */

import type { MergeInboxItem, MergeIssueDto, MergePullRequestListItem } from '@weldsuite/app-api-client/schemas/weldmerge';

export function makePullRequest(overrides: Partial<MergePullRequestListItem> = {}): MergePullRequestListItem {
  return {
    id: 'mpr_1',
    repositoryId: 'mrp_1',
    repositoryFullName: 'weldsuite/weldsuite',
    provider: 'github',
    number: 1466,
    title: 'feat(weldflow): tab visibility per project',
    state: 'open',
    draft: false,
    url: 'https://github.com/weldsuite/weldsuite/pull/1466',
    authorLogin: 'sanne',
    authorAvatarUrl: null,
    authorUserId: null,
    headRef: 'claude/weldflow-tab-visibility',
    baseRef: 'develop',
    additions: 412,
    deletions: 86,
    changedFiles: 9,
    checksStatus: 'success',
    reviewDecision: 'review_required',
    requestedReviewers: [],
    labels: [],
    providerCreatedAt: '2026-11-05T09:00:00.000Z',
    providerUpdatedAt: '2026-11-05T11:00:00.000Z',
    mergedAt: null,
    closedAt: null,
    teamId: 'mtm_1',
    issues: [{ id: 'mis_1', key: 'PLAT-209', title: 'Tab visibility', status: 'in_review', source: 'auto', closes: true }],
    ...overrides,
  };
}

export function makeIssue(overrides: Partial<MergeIssueDto> = {}): MergeIssueDto {
  return {
    id: 'mis_1',
    teamId: 'mtm_1',
    teamKey: 'PLAT',
    number: 209,
    key: 'PLAT-209',
    title: 'Tab visibility per project',
    description: null,
    status: 'in_review',
    priority: 2,
    assigneeUserId: null,
    creatorUserId: 'user_1',
    cycleId: null,
    parentIssueId: null,
    labelIds: [],
    estimate: null,
    dueDate: null,
    flowProjectId: null,
    agentId: null,
    sortOrder: 0,
    pullRequestCount: 1,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-05T11:00:00.000Z',
    ...overrides,
  };
}

export function makeReviewRequest(overrides: Partial<MergeInboxItem> = {}): MergeInboxItem {
  return {
    id: 'review_requested:mpr_1',
    kind: 'review_requested',
    at: '2026-11-05T11:00:00.000Z',
    pullRequest: makePullRequest(),
    issue: null,
    read: false,
    snoozedUntil: null,
    ...overrides,
  };
}

export function makeAssignedIssue(overrides: Partial<MergeInboxItem> = {}): MergeInboxItem {
  return {
    id: 'assigned:mis_2',
    kind: 'assigned',
    at: '2026-11-05T10:00:00.000Z',
    pullRequest: null,
    issue: makeIssue({ id: 'mis_2', key: 'API-97', title: 'Webhook retries drop events' }),
    read: false,
    snoozedUntil: null,
    ...overrides,
  };
}
