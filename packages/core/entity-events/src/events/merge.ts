/**
 * WeldMerge entity events (ADR MERGE-001). Connection payloads carry the
 * provider and account login only, never credentials (EVT-005).
 *
 * `merge_pull_request` events come from sync, not from a member: the mirror
 * changed because the provider said so. `merged` and `closed` are published
 * besides `updated` so workflows can trigger on them without diffing.
 *
 * `merge_issue.agent_assigned` is published besides `updated` when an issue is
 * assigned to a WeldAgent agent: agent-api runs that agent with the issue as
 * its task. `merge_release.shipped` carries the pull request, issue and desk
 * ticket ids, so a workflow can reply to the customers behind a fix.
 */
export const MERGE_ENTITY_EVENTS = {
  merge_team: ['created', 'updated', 'deleted'],
  merge_issue: ['created', 'updated', 'deleted', 'agent_assigned'],
  merge_comment: ['created', 'updated', 'deleted'],
  merge_label: ['created', 'updated', 'deleted'],
  merge_cycle: ['created', 'updated', 'deleted'],
  merge_connection: ['created', 'updated', 'deleted'],
  merge_repository: ['created', 'updated', 'deleted'],
  merge_pull_request: ['created', 'updated', 'merged', 'closed'],
  merge_release: ['created', 'updated', 'deleted', 'shipped'],
  merge_record_link: ['created', 'deleted'],
  merge_chat_subscription: ['created', 'updated', 'deleted'],
} as const;
