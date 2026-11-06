/**
 * Issue writes made on behalf of another surface: a WeldConnect action
 * (`merge.create_issue` ...) or a WeldAgent tool. They do exactly what the
 * member routes in routes/issues do (same services, same entity events, same
 * hook points), but publish the events as the acting member, with the run's
 * chain depth (workflows) or the agent's id (agents) so what they cause cannot
 * trigger itself forever.
 *
 * Failures are tagged results, never thrown: the internal routes answer them
 * as `{ ok: false, error }` and the caller decides whether to retry.
 */

import { publishEntityEventRaw } from '@weldsuite/entity-events';
import type {
  CreateMergeIssueInput,
  MergeCommentDto,
  MergeIssueDto,
  UpdateMergeIssueInput,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Ctx } from '../routes/shared';
import { hookContext } from '../routes/shared';
import { createComment } from './comments';
import type { MergeIssueRow } from './db';
import { diffFields, type PendingEvent } from './events';
import { afterCommentChanged, afterIssueCreated, afterIssueUpdated } from './hooks';
import {
  createIssue,
  findIssueByIdOrKey,
  hydrateIssues,
  ISSUE_CHANGE_FIELDS,
  updateIssue,
  type IssueRefFailure,
} from './issues';
import { commentDto, issueEventData, recordLinkEventData } from './mappers';
import { getTeam } from './teams';
import { memberAgentAssigner } from './across-access';

/** The key entity-event `data` carries when an agent caused the event: agents do not run for their own events (agent-api dispatch). */
export const AGENT_ORIGIN_KEY = 'triggeredByAgentId';

export interface Actor {
  userId: string;
  /** WeldConnect run depth. */
  workflowDepth?: number;
  /** The agent acting through the member. */
  agentId?: string | null;
}

export type Failure = { ok: false; code: 'not_found' | 'invalid'; message: string };
export type Outcome<T> = ({ ok: true } & T) | Failure;

const fail = (code: Failure['code'], message: string): Failure => ({ ok: false, code, message });

function refMessage(reason: IssueRefFailure | 'team_not_found' | 'agent_invalid'): string {
  switch (reason) {
    case 'team_not_found':
      return 'The team does not exist';
    case 'agent_invalid':
      return 'The agent does not exist, is not active, or the member this call acts for cannot use it';
    case 'cycle_invalid':
      return 'The cycle does not exist or belongs to another team';
    case 'parent_invalid':
      return 'The parent issue must be another issue of the same team, and not one of its own sub-issues';
    case 'labels_invalid':
      return 'A label does not exist or belongs to another team';
  }
}

/** Awaited, so the hub send is done before the internal call answers (the entrypoint has no request to waitUntil on). */
async function publish(c: Ctx, actor: Actor, events: PendingEvent[]): Promise<void> {
  for (const event of events) {
    await publishEntityEventRaw({
      env: c.env,
      workspaceId: c.get('clerkOrgId') ?? c.get('workspaceId') ?? '',
      userId: actor.userId,
      entityType: event.entityType as 'merge_team',
      action: event.action as never,
      entityId: event.entityId,
      data: { ...event.data, ...(actor.agentId ? { [AGENT_ORIGIN_KEY]: actor.agentId } : {}) },
      changes: event.changes ?? undefined,
      source: 'api',
      workflowDepth: actor.workflowDepth,
    });
  }
}

const issueEvent = (
  issue: MergeIssueRow,
  teamKey: string,
  action: 'created' | 'updated' | 'agent_assigned',
  changes?: PendingEvent['changes'],
): PendingEvent => ({ entityType: 'merge_issue', action, entityId: issue.id, data: issueEventData(issue, teamKey), changes });

async function dto(c: Ctx, issue: MergeIssueRow): Promise<MergeIssueDto> {
  const [row] = await hydrateIssues(c.get('tenantDb'), [issue]);
  return row!;
}

export async function createIssueAs(c: Ctx, actor: Actor, input: CreateMergeIssueInput): Promise<Outcome<{ issue: MergeIssueDto }>> {
  const db = c.get('tenantDb');
  const result = await createIssue(db, input, actor.userId);
  if (!result.ok) return fail(result.reason === 'team_not_found' ? 'not_found' : 'invalid', refMessage(result.reason));
  await publish(c, actor, [
    issueEvent(result.issue, result.team.key, 'created'),
    ...result.links.map(
      (link): PendingEvent => ({
        entityType: 'merge_record_link',
        action: 'created',
        entityId: link.id,
        data: recordLinkEventData(link),
      }),
    ),
  ]);
  await afterIssueCreated(hookContext(c), result.issue, result.team.key);
  return { ok: true, issue: await dto(c, result.issue) };
}

/** `issueRef` is an id or a key (`PLAT-209`). */
export async function updateIssueAs(
  c: Ctx,
  actor: Actor,
  issueRef: string,
  input: UpdateMergeIssueInput,
): Promise<Outcome<{ issue: MergeIssueDto }>> {
  const db = c.get('tenantDb');
  const existing = await findIssueByIdOrKey(db, issueRef);
  if (!existing) return fail('not_found', `Issue ${issueRef} was not found`);
  // A new agent must be one the acting member could use (the run it starts acts for them).
  const assigner = input.agentId ? await memberAgentAssigner(db, actor.userId) : undefined;
  const result = await updateIssue(db, existing.id, input, assigner);
  if (!result.ok) return fail(result.reason === 'not_found' ? 'not_found' : 'invalid', result.reason === 'not_found' ? `Issue ${issueRef} was not found` : refMessage(result.reason));
  const changes = diffFields(
    result.before as unknown as Record<string, unknown>,
    result.issue as unknown as Record<string, unknown>,
    ISSUE_CHANGE_FIELDS,
  );
  const events = [issueEvent(result.issue, result.teamKey, 'updated', changes)];
  if (result.issue.agentId && result.issue.agentId !== result.before.agentId) {
    events.push(issueEvent(result.issue, result.teamKey, 'agent_assigned', changes));
  }
  await publish(c, actor, events);
  await afterIssueUpdated(hookContext(c), result.before, result.issue, result.teamKey);
  return { ok: true, issue: await dto(c, result.issue) };
}

export async function commentOnIssueAs(
  c: Ctx,
  actor: Actor,
  issueRef: string,
  body: string,
): Promise<Outcome<{ issue: MergeIssueRow; teamKey: string; comment: MergeCommentDto }>> {
  const db = c.get('tenantDb');
  const issue = await findIssueByIdOrKey(db, issueRef);
  if (!issue) return fail('not_found', `Issue ${issueRef} was not found`);
  const comment = await createComment(db, issue.id, actor.userId, body);
  await publish(c, actor, [
    {
      entityType: 'merge_comment',
      action: 'created',
      entityId: comment.id,
      data: { id: comment.id, issueId: comment.issueId, authorUserId: comment.authorUserId },
    },
  ]);
  const team = await getTeam(db, issue.teamId);
  const teamKey = team?.row.key ?? '';
  await afterCommentChanged(hookContext(c), 'created', comment, issue, teamKey);
  return { ok: true, issue, teamKey, comment: commentDto(comment) };
}

/** A zod failure as one readable line (`path: message; ...`). */
export function describeIssues(issues: Array<{ path: Array<string | number>; message: string }>): string {
  return issues
    .map((issue) => {
      const field = issue.path.join('.');
      return field ? `${field}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
