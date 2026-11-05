/**
 * Issue sync entry points. Called from `../hooks.ts` (a WeldMerge change to
 * push) and from `../github-events.ts` (a GitHub webhook to apply).
 *
 * Push (WeldMerge to provider) runs for repositories whose `issue_sync` is
 * `two_way`, inside the request, and stores the new
 * `merge_external_issues.checksum` before the webhook echo arrives. A failing
 * push throws; `../hooks.ts` logs and swallows it, so the member's own change
 * is never undone by a provider outage. Intake (provider to WeldMerge) is
 * `handleGithubIssueSyncEvent`, for `import` and `two_way`.
 */

import { getMasterDb } from '@weldsuite/worker-kit/db';
import {
  findGithubConnections,
  removeGithubInstallationIndex,
  setGithubInstallationStatus,
} from '@weldsuite/merge-domain/installations';
import type { MergeGithubEventEnvelope } from '@weldsuite/app-api-client/schemas/weldmerge';
import type { Db, MergeCommentRow, MergeIssueRow } from '../db';
import type { PendingEvent } from '../events';
import type { GithubEventResult } from '../github-events';
import type { CommentChange, HookContext } from '../hooks';
import { connectionEventData } from '../repositories';
import {
  isGithubPullRequest,
  normalizeGithubComment,
  normalizeGithubIssue,
  type GithubCommentPayload,
  type GithubIssuePayload,
} from '../providers/github/issues';
import { applyInboundComment, applyInboundIssue, unlinkProviderIssue, type InboundContext, type InboundResult } from './inbound';
import { pushComment, pushIssueUpdate } from './outbound';
import { loadTargetByExternalId } from './targets';

export async function afterIssueCreated(_ctx: HookContext, _issue: MergeIssueRow, _teamKey: string): Promise<void> {}

/** A member's edit (or a pull request moving the issue), pushed when the issue is linked to a `two_way` repository. */
export async function afterIssueUpdated(ctx: HookContext, before: MergeIssueRow, after: MergeIssueRow, _teamKey: string): Promise<void> {
  await pushIssueUpdate(ctx.db, ctx.env, before, after);
}

/** A comment a member wrote, pushed to the linked provider issue. */
export async function afterCommentChanged(
  ctx: HookContext,
  change: CommentChange,
  comment: MergeCommentRow,
  issue: MergeIssueRow,
  _teamKey: string,
): Promise<void> {
  if (change !== 'created') return;
  await pushComment(ctx.db, ctx.env, comment, issue);
}

// ---------------------------------------------------------------------------
// GitHub webhook intake
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

const ignored = (reason: string): GithubEventResult => ({ outcome: 'ignored', reason, events: [] });

function resultOf(result: InboundResult): GithubEventResult {
  return result.outcome === 'ignored' || result.outcome === 'unchanged'
    ? { outcome: 'ignored', reason: result.reason ?? result.outcome, events: result.events }
    : { outcome: 'applied', events: result.events };
}

/** `issues` actions that change an issue we already know; `opened` and `reopened` also bring an unknown one in. */
const ISSUE_UPDATE_ACTIONS = new Set(['edited', 'closed', 'labeled', 'unlabeled', 'assigned', 'unassigned']);
const ISSUE_CREATE_ACTIONS = new Set(['opened', 'reopened']);
const ISSUE_UNLINK_ACTIONS = new Set(['deleted', 'transferred']);

async function inboundContext(db: Db, payload: Json, hooks?: HookContext): Promise<InboundContext | null> {
  const repoId = obj(payload.repository)?.id;
  if (typeof repoId !== 'number' && typeof repoId !== 'string') return null;
  const target = await loadTargetByExternalId(db, 'github', String(repoId));
  return target ? { db, target, userId: hooks?.userId ?? 'system', hooks } : null;
}

async function issuesEvent(db: Db, payload: Json, hooks?: HookContext): Promise<GithubEventResult> {
  const raw = obj(payload.issue) as unknown as GithubIssuePayload | null;
  if (!raw) return ignored('no_payload');
  if (isGithubPullRequest(raw)) return ignored('pull_request');
  const ctx = await inboundContext(db, payload, hooks);
  if (!ctx) return ignored('untracked_repository');

  const action = String(payload.action);
  if (ISSUE_UNLINK_ACTIONS.has(action)) return resultOf(await unlinkProviderIssue(ctx, raw.number));
  if (!ISSUE_CREATE_ACTIONS.has(action) && !ISSUE_UPDATE_ACTIONS.has(action)) return ignored('unsupported_action');
  return resultOf(await applyInboundIssue(ctx, normalizeGithubIssue(raw), { create: ISSUE_CREATE_ACTIONS.has(action) }));
}

async function issueCommentEvent(db: Db, payload: Json, hooks?: HookContext): Promise<GithubEventResult> {
  const issue = obj(payload.issue) as unknown as GithubIssuePayload | null;
  const comment = obj(payload.comment) as unknown as GithubCommentPayload | null;
  if (!issue || !comment) return ignored('no_payload');
  if (isGithubPullRequest(issue)) return ignored('pull_request');
  const action = String(payload.action);
  if (action !== 'created' && action !== 'edited' && action !== 'deleted') return ignored('unsupported_action');
  const ctx = await inboundContext(db, payload, hooks);
  if (!ctx) return ignored('untracked_repository');
  return resultOf(await applyInboundComment(ctx, action, normalizeGithubComment(comment, issue.number)));
}

const INSTALLATION_STATUS = { deleted: 'revoked', suspend: 'suspended', unsuspend: 'active' } as const;

/** `installation` deleted / suspend / unsuspend: the connection's status follows; a removed installation also leaves the master index. */
async function installationEvent(db: Db, payload: Json, hooks?: HookContext): Promise<GithubEventResult> {
  const id = obj(payload.installation)?.id;
  if (typeof id !== 'number' && typeof id !== 'string') return ignored('no_installation');
  const action = String(payload.action) as keyof typeof INSTALLATION_STATUS;
  const status = INSTALLATION_STATUS[action];
  if (!status) return ignored('unsupported_action');

  const previous = new Map((await findGithubConnections(db, id)).map((row) => [row.id, row.status]));
  const rows = await setGithubInstallationStatus(db, id, status);
  if (status === 'revoked' && hooks) {
    try {
      await removeGithubInstallationIndex(getMasterDb(hooks.env), id);
    } catch (err) {
      console.error('[merge-api] could not remove the installation from the master index:', err);
    }
  }
  if (rows.length === 0) return ignored('untracked_installation');
  const events: PendingEvent[] = rows.map((row) => ({
    entityType: 'merge_connection',
    action: 'updated',
    entityId: row.id,
    data: connectionEventData(row),
    changes: previous.get(row.id) === row.status ? null : { status: { old: previous.get(row.id) ?? null, new: row.status } },
  }));
  return { outcome: 'applied', events };
}

/** GitHub `issues`, `issue_comment` and `installation` events (integration-webhook-worker forwards them). */
export async function handleGithubIssueSyncEvent(
  db: Db,
  envelope: MergeGithubEventEnvelope,
  hooks?: HookContext,
): Promise<GithubEventResult> {
  const payload = envelope.payload as Json;
  switch (envelope.event) {
    case 'issues':
      return issuesEvent(db, payload, hooks);
    case 'issue_comment':
      return issueCommentEvent(db, payload, hooks);
    case 'installation':
      return installationEvent(db, payload, hooks);
    default:
      return ignored('unsupported_event');
  }
}
