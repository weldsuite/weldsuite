/** WeldMerge (merge-api) response schemas. Spread into ROUTES by conformance-schemas.ts. */
import {
  connectMergeGithubResultSchema,
  mergeAvailableRepositorySchema,
  mergeCommentDtoSchema,
  mergeConnectionDtoSchema,
  mergeCycleDtoSchema,
  mergeGithubEventAckSchema,
  mergeInboxItemSchema,
  mergeIssueDetailDtoSchema,
  mergeIssueDtoSchema,
  mergeLabelDtoSchema,
  mergeProviderAccountsDtoSchema,
  mergePullRequestDetailDtoSchema,
  mergePullRequestListItemSchema,
  mergeRepositoryDtoSchema,
  mergeRepositorySyncResultSchema,
  mergeTeamDtoSchema,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import type { RouteSchema } from './conformance-schemas';

export const MERGE_ROUTES: RouteSchema[] = [
  // teams, labels, cycles
  { method: 'GET', route: '/api/merge/teams', envelope: 'list', data: mergeTeamDtoSchema },
  { method: 'GET', route: '/api/merge/teams/:id', envelope: 'single', data: mergeTeamDtoSchema },
  { method: 'POST', route: '/api/merge/teams', envelope: 'single', data: mergeTeamDtoSchema },
  { method: 'PATCH', route: '/api/merge/teams/:id', envelope: 'single', data: mergeTeamDtoSchema },
  { method: 'GET', route: '/api/merge/labels', envelope: 'list', data: mergeLabelDtoSchema },
  { method: 'POST', route: '/api/merge/labels', envelope: 'single', data: mergeLabelDtoSchema },
  { method: 'PATCH', route: '/api/merge/labels/:id', envelope: 'single', data: mergeLabelDtoSchema },
  { method: 'GET', route: '/api/merge/cycles', envelope: 'list', data: mergeCycleDtoSchema },
  { method: 'POST', route: '/api/merge/cycles', envelope: 'single', data: mergeCycleDtoSchema },
  { method: 'PATCH', route: '/api/merge/cycles/:id', envelope: 'single', data: mergeCycleDtoSchema },
  // issues, comments, pull request links
  { method: 'GET', route: '/api/merge/issues', envelope: 'list', data: mergeIssueDtoSchema },
  { method: 'GET', route: '/api/merge/issues/:id', envelope: 'single', data: mergeIssueDetailDtoSchema },
  { method: 'POST', route: '/api/merge/issues', envelope: 'single', data: mergeIssueDtoSchema },
  { method: 'PATCH', route: '/api/merge/issues/:id', envelope: 'single', data: mergeIssueDtoSchema },
  { method: 'GET', route: '/api/merge/issues/:id/comments', envelope: 'list', data: mergeCommentDtoSchema },
  { method: 'POST', route: '/api/merge/issues/:id/comments', envelope: 'single', data: mergeCommentDtoSchema },
  { method: 'POST', route: '/api/merge/issues/:id/pull-requests', envelope: 'single', data: mergeIssueDetailDtoSchema },
  { method: 'PATCH', route: '/api/merge/comments/:id', envelope: 'single', data: mergeCommentDtoSchema },
  // pull requests, inbox, the member's logins
  { method: 'GET', route: '/api/merge/pull-requests', envelope: 'list', data: mergePullRequestListItemSchema },
  { method: 'GET', route: '/api/merge/pull-requests/:id', envelope: 'single', data: mergePullRequestDetailDtoSchema },
  { method: 'GET', route: '/api/merge/inbox', envelope: 'list', data: mergeInboxItemSchema },
  { method: 'GET', route: '/api/merge/accounts/me', envelope: 'single', data: mergeProviderAccountsDtoSchema },
  { method: 'PUT', route: '/api/merge/accounts/me', envelope: 'single', data: mergeProviderAccountsDtoSchema },
  // connections and repositories
  { method: 'GET', route: '/api/merge/connections', envelope: 'list', data: mergeConnectionDtoSchema },
  { method: 'POST', route: '/api/merge/connections/github', envelope: 'single', data: connectMergeGithubResultSchema },
  {
    method: 'GET',
    route: '/api/merge/connections/:id/available-repositories',
    envelope: 'list',
    data: mergeAvailableRepositorySchema,
  },
  { method: 'GET', route: '/api/merge/repositories', envelope: 'list', data: mergeRepositoryDtoSchema },
  { method: 'POST', route: '/api/merge/repositories', envelope: 'single', data: mergeRepositorySyncResultSchema },
  { method: 'PATCH', route: '/api/merge/repositories/:id', envelope: 'single', data: mergeRepositoryDtoSchema },
  { method: 'POST', route: '/api/merge/repositories/:id/sync', envelope: 'single', data: mergeRepositorySyncResultSchema },
  // the GitHub event intake (the `MergeInternal` entrypoint)
  { method: 'POST', route: '/internal/github-event', envelope: 'single', data: mergeGithubEventAckSchema },
];
