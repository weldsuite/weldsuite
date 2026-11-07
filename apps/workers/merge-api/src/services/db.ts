import { schema, type Database } from '@weldsuite/worker-kit/db';

export type Db = Database;

export const {
  mergeTeams,
  mergeCycles,
  mergeLabels,
  mergeIssues,
  mergeComments,
  mergeConnections,
  mergeRepositories,
  mergePullRequests,
  mergeIssuePullRequests,
  mergeProviderAccounts,
  mergeExternalIssues,
  mergeInboxStates,
  mergeReleases,
  mergeReleasePullRequests,
  mergeRecordLinks,
  mergeChatSubscriptions,
  githubConnections,
} = schema;

export type MergeTeamRow = typeof mergeTeams.$inferSelect;
export type MergeCycleRow = typeof mergeCycles.$inferSelect;
export type MergeLabelRow = typeof mergeLabels.$inferSelect;
export type MergeIssueRow = typeof mergeIssues.$inferSelect;
export type MergeCommentRow = typeof mergeComments.$inferSelect;
export type MergeConnectionRow = typeof mergeConnections.$inferSelect;
export type MergeRepositoryRow = typeof mergeRepositories.$inferSelect;
export type MergePullRequestRow = typeof mergePullRequests.$inferSelect;
export type MergeIssuePullRequestRow = typeof mergeIssuePullRequests.$inferSelect;
export type MergeProviderAccountRow = typeof mergeProviderAccounts.$inferSelect;
export type MergeExternalIssueRow = typeof mergeExternalIssues.$inferSelect;
export type MergeInboxStateRow = typeof mergeInboxStates.$inferSelect;
export type MergeReleaseRow = typeof mergeReleases.$inferSelect;
export type MergeReleasePullRequestRow = typeof mergeReleasePullRequests.$inferSelect;
export type MergeRecordLinkRow = typeof mergeRecordLinks.$inferSelect;
export type MergeChatSubscriptionRow = typeof mergeChatSubscriptions.$inferSelect;

/** Rows of a `db.execute()` result, whichever driver ran it (neon-http and pglite differ in shape). */
export function executeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: T[] } | null)?.rows;
  return rows ?? [];
}

/** Escapes `%`, `_` and `\` for use inside an ILIKE pattern. */
export function likePattern(text: string): string {
  const escaped = text.replace(/[\\%_]/g, (m) => `\\${m}`);
  return `%${escaped}%`;
}

export const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;
