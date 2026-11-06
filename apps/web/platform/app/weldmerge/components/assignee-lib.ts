import type { UpdateMergeIssueInput } from '@weldsuite/app-api-client/schemas/weldmerge';

export const NO_ASSIGNEE = '__none__';

/** The select value of an issue's current assignee: a member, an agent, or none. */
export function assigneeValue(issue: { assigneeUserId: string | null; agentId: string | null }): string {
  if (issue.agentId) return `agent:${issue.agentId}`;
  if (issue.assigneeUserId) return `user:${issue.assigneeUserId}`;
  return NO_ASSIGNEE;
}

/**
 * The PATCH body for a picked assignee. A member and an agent exclude each other:
 * choosing one clears the other, so the issue has a single owner.
 */
export function assigneePatch(value: string): UpdateMergeIssueInput {
  if (value.startsWith('agent:')) return { agentId: value.slice('agent:'.length), assigneeUserId: null };
  if (value.startsWith('user:')) return { assigneeUserId: value.slice('user:'.length), agentId: null };
  return { assigneeUserId: null, agentId: null };
}
