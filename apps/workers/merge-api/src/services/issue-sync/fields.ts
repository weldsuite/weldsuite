/**
 * The synced fields of an issue and the loop guard over them.
 *
 * Both sides are reduced to the same six canonical fields
 * (`MergeSyncedIssueFields`): title, body, open/closed, the close reason,
 * labels by name, and the assignee's provider login. `merge_external_issues
 * .checksum` is the sha-256 (hex) of their canonical JSON, always taken from the
 * provider's side of the last exchange (an inbound issue, or the answer to an
 * outbound call), so the webhook echo of our own push carries the same checksum
 * and is ignored.
 *
 * Canonical form, which a port must reproduce byte for byte:
 *   title: trimmed; body: CRLF -> LF; labels: lower-cased, de-duplicated,
 *   sorted; assignee: lower-cased login or null; stateReason null while open.
 *   JSON.stringify of `{ title, body, state, stateReason, labels, assignee }`
 *   in that key order.
 */

import type { MergeSyncedIssueFields } from '@weldsuite/app-api-client/schemas/weldmerge-sync';
import type { MergeIssueRow } from '../db';
import type { NormalizedIssue } from '../providers/types';

type IssueStatus = MergeIssueRow['status'];

export function canonicalFields(input: {
  title: string;
  body: string | null | undefined;
  state: 'open' | 'closed';
  stateReason: 'completed' | 'not_planned' | null;
  labels: readonly string[];
  assignee: string | null | undefined;
}): MergeSyncedIssueFields {
  return {
    title: input.title.trim(),
    body: (input.body ?? '').replaceAll('\r\n', '\n'),
    state: input.state,
    stateReason: input.state === 'closed' ? input.stateReason : null,
    labels: [...new Set(input.labels.map((l) => l.toLowerCase()))].sort(),
    assignee: input.assignee ? input.assignee.toLowerCase() : null,
  };
}

/** What the provider says an issue is. */
export function providerFields(issue: NormalizedIssue): MergeSyncedIssueFields {
  return canonicalFields({
    title: issue.title,
    body: issue.body,
    state: issue.state,
    stateReason: issue.stateReason,
    labels: issue.labels,
    assignee: issue.assigneeLogin,
  });
}

/** sha-256 (hex) of the canonical JSON. */
export async function checksumOf(fields: MergeSyncedIssueFields): Promise<string> {
  const json = JSON.stringify({
    title: fields.title,
    body: fields.body,
    state: fields.state,
    stateReason: fields.stateReason,
    labels: fields.labels,
    assignee: fields.assignee,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** WeldMerge `done` / `canceled` close the provider issue (with that reason); every other status keeps it open. */
export function statusToProviderState(status: IssueStatus): { state: 'open' | 'closed'; stateReason: 'completed' | 'not_planned' | null } {
  if (status === 'done') return { state: 'closed', stateReason: 'completed' };
  if (status === 'canceled') return { state: 'closed', stateReason: 'not_planned' };
  return { state: 'open', stateReason: null };
}

/**
 * The WeldMerge status a provider issue maps to. Closed -> `done`, or
 * `canceled` for `not_planned`; open keeps an open status the issue already has
 * (in_progress stays in_progress) and reopens a done or canceled one to `todo`.
 */
export function providerStateToStatus(
  issue: Pick<NormalizedIssue, 'state' | 'stateReason'>,
  current: IssueStatus | null,
): IssueStatus {
  if (issue.state === 'closed') return issue.stateReason === 'not_planned' ? 'canceled' : 'done';
  if (current === null || current === 'done' || current === 'canceled') return 'todo';
  return current;
}
