/** Row to DTO mappers: the output shapes are the Zod DTOs in @weldsuite/app-api-client/schemas/weldmerge. */

import type {
  MergeCommentDto,
  MergeConnectionDto,
  MergeCycleDto,
  MergeIssueDto,
  MergeLabelDto,
  MergeProviderAccountDto,
  MergePullRequestSummary,
  MergeRecordLinkDto,
  MergeRepositoryDto,
  MergeTeamDto,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  iso,
  type MergeCommentRow,
  type MergeConnectionRow,
  type MergeCycleRow,
  type MergeIssueRow,
  type MergeLabelRow,
  type MergeProviderAccountRow,
  type MergePullRequestRow,
  type MergeRecordLinkRow,
  type MergeRepositoryRow,
  type MergeTeamRow,
} from './db';

export function teamDto(row: MergeTeamRow, openIssueCount: number): MergeTeamDto {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    color: row.color,
    openIssueCount,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

export function labelDto(row: MergeLabelRow): MergeLabelDto {
  return { id: row.id, teamId: row.teamId, name: row.name, color: row.color };
}

export function cycleDto(row: MergeCycleRow, issueCount: number, completedIssueCount: number): MergeCycleDto {
  return {
    id: row.id,
    teamId: row.teamId,
    number: row.number,
    name: row.name,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    issueCount,
    completedIssueCount,
  };
}

export function issueDto(row: MergeIssueRow, teamKey: string, pullRequestCount: number): MergeIssueDto {
  return {
    id: row.id,
    teamId: row.teamId,
    teamKey,
    number: row.number,
    key: `${teamKey}-${row.number}`,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeUserId: row.assigneeUserId,
    creatorUserId: row.creatorUserId,
    cycleId: row.cycleId,
    parentIssueId: row.parentIssueId,
    labelIds: row.labelIds ?? [],
    estimate: row.estimate,
    dueDate: row.dueDate,
    flowProjectId: row.flowProjectId,
    agentId: row.agentId,
    sortOrder: row.sortOrder,
    pullRequestCount,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    canceledAt: iso(row.canceledAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

export function commentDto(row: MergeCommentRow): MergeCommentDto {
  return {
    id: row.id,
    issueId: row.issueId,
    authorUserId: row.authorUserId,
    body: row.body,
    source: row.source,
    externalAuthorLogin: row.externalAuthorLogin,
    externalAuthorAvatarUrl: row.externalAuthorAvatarUrl,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

export function connectionDto(row: MergeConnectionRow, repositoryCount: number): MergeConnectionDto {
  return {
    id: row.id,
    provider: row.provider,
    externalAccountId: row.externalAccountId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    host: row.host,
    status: row.status,
    credentialsExpireAt: iso(row.credentialsExpireAt),
    oauthUserLogin: row.oauthUserLogin,
    repositoryCount,
    createdAt: iso(row.createdAt)!,
  };
}

export function repositoryDto(row: MergeRepositoryRow, openPullRequestCount: number): MergeRepositoryDto {
  return {
    id: row.id,
    connectionId: row.connectionId,
    provider: row.provider,
    externalId: row.externalId,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    private: row.private,
    url: row.url,
    teamId: row.teamId,
    issueSync: row.issueSync,
    prSync: row.prSync,
    externalProject: row.externalProject,
    openPullRequestCount,
    lastSyncedAt: iso(row.lastSyncedAt),
    createdAt: iso(row.createdAt)!,
  };
}

export function pullRequestSummary(row: MergePullRequestRow, repositoryFullName: string): MergePullRequestSummary {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    repositoryFullName,
    provider: row.provider,
    number: row.number,
    title: row.title,
    state: row.state,
    draft: row.draft,
    url: row.url,
    authorLogin: row.authorLogin,
    authorAvatarUrl: row.authorAvatarUrl,
    authorUserId: row.authorUserId,
    headRef: row.headRef,
    baseRef: row.baseRef,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changedFiles,
    checksStatus: row.checksStatus,
    reviewDecision: row.reviewDecision,
    requestedReviewers: row.requestedReviewers ?? [],
    labels: row.labels ?? [],
    providerCreatedAt: iso(row.providerCreatedAt)!,
    providerUpdatedAt: iso(row.providerUpdatedAt)!,
    mergedAt: iso(row.mergedAt),
    closedAt: iso(row.closedAt),
  };
}

/** What an issue's entity event carries. */
export function issueEventData(row: MergeIssueRow, teamKey: string, movedByPullRequestId?: string | null) {
  return {
    id: row.id,
    teamId: row.teamId,
    key: `${teamKey}-${row.number}`,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeUserId: row.assigneeUserId,
    ...(row.agentId ? { agentId: row.agentId } : {}),
    ...(movedByPullRequestId ? { movedByPullRequestId } : {}),
  };
}

export function recordLinkDto(row: MergeRecordLinkRow): MergeRecordLinkDto {
  return {
    id: row.id,
    issueId: row.issueId,
    recordType: row.recordType,
    recordId: row.recordId,
    title: row.title,
    createdAt: iso(row.createdAt)!,
  };
}

/** What a record link's entity event carries. */
export function recordLinkEventData(row: MergeRecordLinkRow) {
  return { id: row.id, issueId: row.issueId, recordType: row.recordType, recordId: row.recordId };
}

/** A linked account for the member; the token and its expiry never leave the backend. */
export function providerAccountDto(row: MergeProviderAccountRow): MergeProviderAccountDto {
  return {
    id: row.id,
    provider: row.provider,
    host: row.host,
    login: row.login,
    verified: row.verifiedAt !== null,
    avatarUrl: row.avatarUrl,
    displayName: row.displayName,
  };
}
