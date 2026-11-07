/**
 * Provider to WeldMerge: a provider issue or comment (from a webhook, or read
 * by an import) applied to WeldMerge's own records. Provider-agnostic: it works
 * on `NormalizedIssue` / `NormalizedIssueComment`, so the GitLab adapter's
 * events go through the same functions.
 *
 * Rules (docs/plans/weldmerge-phases-2-5.md, phase 2):
 *  - an inbound issue whose checksum equals the stored one is an echo of our own
 *    push and is ignored; one older than the stored `provider_updated_at` is stale;
 *  - closed maps to `done` (`canceled` for `not_planned`), a reopen to `todo`;
 *  - labels by name (missing ones become team labels), assignee by linked account;
 *  - provider comments are stored with `source = provider`.
 *
 * Nothing here publishes: every function returns the entity events it caused and
 * the caller publishes them (`system` source for webhooks).
 */

import { and, eq } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import type { MergeIssueSyncMode } from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  mergeComments,
  mergeExternalIssues,
  type Db,
  type MergeCommentRow,
  type MergeIssueRow,
  type MergeRepositoryRow,
} from '../db';
import { diffFields, type PendingEvent } from '../events';
import * as chat from '../chat/hooks';
import type { HookContext } from '../hooks';
import { createIssue, findIssue, ISSUE_CHANGE_FIELDS, updateIssue } from '../issues';
import { issueEventData } from '../mappers';
import { findTeam } from '../teams';
import type { NormalizedIssue, NormalizedIssueComment } from '../providers/types';
import { checksumOf, providerFields, providerStateToStatus } from './fields';
import { memberForLogin, resolveAssignee, resolveLabelIds } from './people';
import { findLinkByIssue, findLinkByNumber, type SyncTarget } from './targets';

/** What the inbound functions act on. `hooks` runs the chat hooks after a write (leave it out for bulk imports). */
export interface InboundContext {
  db: Db;
  target: SyncTarget;
  /** Who the new issues are created by: `system` for webhooks, the member for an import. */
  userId: string;
  hooks?: HookContext;
  now?: Date;
}

export type InboundOutcome = 'created' | 'updated' | 'unchanged' | 'ignored';

export interface InboundResult {
  outcome: InboundOutcome;
  /** Why the event was dropped (`echo`, `stale`, `unlinked_issue`, `no_team`, `sync_off`, …). */
  reason?: string;
  events: PendingEvent[];
}

const MAX_TITLE = 500;
const MAX_DESCRIPTION = 100_000;
const MAX_LABELS = 20;

const ignored = (reason: string): InboundResult => ({ outcome: 'ignored', reason, events: [] });

/** Sync modes under which provider changes flow in. */
const INBOUND_MODES: readonly MergeIssueSyncMode[] = ['import', 'two_way'];

export function syncsInbound(repository: MergeRepositoryRow): boolean {
  return INBOUND_MODES.includes(repository.issueSync);
}

/** Chat hooks only: the issue sync's own push must not answer a change that came from the provider. */
async function chatAfterCreated(ctx: InboundContext, issue: MergeIssueRow, teamKey: string) {
  if (!ctx.hooks) return;
  try {
    await chat.afterIssueCreated(ctx.hooks, issue, teamKey);
  } catch (err) {
    console.error('[merge-api] hook chat.afterIssueCreated failed:', err);
  }
}

async function chatAfterUpdated(ctx: InboundContext, before: MergeIssueRow, after: MergeIssueRow, teamKey: string) {
  if (!ctx.hooks) return;
  try {
    await chat.afterIssueUpdated(ctx.hooks, before, after, teamKey);
  } catch (err) {
    console.error('[merge-api] hook chat.afterIssueUpdated failed:', err);
  }
}

function linkValues(issue: NormalizedIssue, checksum: string, now: Date) {
  return {
    externalId: issue.externalId,
    number: issue.number,
    url: issue.url,
    state: issue.state,
    checksum,
    lastWriter: 'provider' as const,
    providerUpdatedAt: issue.updatedAt,
    syncedAt: now,
    updatedAt: now,
  };
}

async function createFromProvider(ctx: InboundContext, issue: NormalizedIssue, checksum: string): Promise<InboundResult> {
  const { db, target } = ctx;
  const { repository } = target;
  if (!repository.teamId) return ignored('no_team');
  const now = ctx.now ?? new Date();

  const labels = await resolveLabelIds(db, repository.teamId, issue.labels);
  const assigneeUserId = issue.assigneeLogin ? await memberForLogin(db, repository.provider, target.connection.host, issue.assigneeLogin) : null;
  const created = await createIssue(
    db,
    {
      teamId: repository.teamId,
      title: issue.title.trim().slice(0, MAX_TITLE) || 'Untitled',
      description: issue.body.slice(0, MAX_DESCRIPTION),
      status: providerStateToStatus(issue, null),
      labelIds: labels.ids.slice(0, MAX_LABELS),
      assigneeUserId,
    },
    ctx.userId,
  );
  if (!created.ok) return ignored(created.reason);

  await db.insert(mergeExternalIssues).values({
    id: generateId('mxi'),
    issueId: created.issue.id,
    repositoryId: repository.id,
    provider: repository.provider,
    ...linkValues(issue, checksum, now),
    createdAt: now,
  });
  await chatAfterCreated(ctx, created.issue, created.team.key);
  return {
    outcome: 'created',
    events: [
      ...labels.events,
      { entityType: 'merge_issue', action: 'created', entityId: created.issue.id, data: issueEventData(created.issue, created.team.key) },
    ],
  };
}

async function updateFromProvider(
  ctx: InboundContext,
  issue: NormalizedIssue,
  checksum: string,
  before: MergeIssueRow,
): Promise<InboundResult> {
  const { db, target } = ctx;
  const { repository, connection } = target;
  const now = ctx.now ?? new Date();

  const labels = await resolveLabelIds(db, before.teamId, issue.labels);
  const assigneeUserId = await resolveAssignee(db, repository.provider, connection.host, issue.assigneeLogin, before.assigneeUserId);
  const title = issue.title.trim().slice(0, MAX_TITLE) || before.title;
  const description = issue.body.slice(0, MAX_DESCRIPTION);
  const status = providerStateToStatus(issue, before.status);
  const labelIds = labels.ids.slice(0, MAX_LABELS);

  const changedLabels = JSON.stringify([...labelIds].sort()) !== JSON.stringify([...(before.labelIds ?? [])].sort());
  const patch = {
    ...(title === before.title ? {} : { title }),
    ...(description === (before.description ?? '') ? {} : { description }),
    ...(status === before.status ? {} : { status }),
    ...(changedLabels ? { labelIds } : {}),
    ...(assigneeUserId === before.assigneeUserId ? {} : { assigneeUserId }),
  };

  const events: PendingEvent[] = [...labels.events];
  let outcome: InboundOutcome = 'unchanged';
  if (Object.keys(patch).length > 0) {
    const result = await updateIssue(db, before.id, patch);
    if (!result.ok) return ignored(result.reason);
    const changes = diffFields(
      before as unknown as Record<string, unknown>,
      result.issue as unknown as Record<string, unknown>,
      ISSUE_CHANGE_FIELDS,
    );
    events.push({
      entityType: 'merge_issue',
      action: 'updated',
      entityId: result.issue.id,
      data: issueEventData(result.issue, result.teamKey),
      changes,
    });
    await chatAfterUpdated(ctx, before, result.issue, result.teamKey);
    outcome = 'updated';
  }

  await db
    .update(mergeExternalIssues)
    .set(linkValues(issue, checksum, now))
    .where(and(eq(mergeExternalIssues.repositoryId, repository.id), eq(mergeExternalIssues.number, issue.number)));
  return { outcome, events };
}

/**
 * Applies one provider issue. With `create`, an issue WeldMerge does not know
 * becomes a new issue in the repository's team (imports, and an `opened` or
 * `reopened` event); otherwise it is ignored (`unlinked_issue`).
 */
export async function applyInboundIssue(
  ctx: InboundContext,
  issue: NormalizedIssue,
  options: { create: boolean },
): Promise<InboundResult> {
  const { db, target } = ctx;
  if (!syncsInbound(target.repository)) return ignored('issue_sync_off');

  const checksum = await checksumOf(providerFields(issue));
  const link = await findLinkByNumber(db, target.repository.id, issue.number);
  if (!link) return options.create ? createFromProvider(ctx, issue, checksum) : ignored('unlinked_issue');

  if (link.checksum === checksum) return ignored('echo');
  if (link.providerUpdatedAt && issue.updatedAt.getTime() < link.providerUpdatedAt.getTime()) return ignored('stale');

  const before = await findIssue(db, link.issueId);
  if (!before) return ignored('issue_deleted');
  return updateFromProvider(ctx, issue, checksum, before);
}

/** The provider issue was deleted or moved away: WeldMerge keeps its issue and drops the link. */
export async function unlinkProviderIssue(ctx: InboundContext, number: number): Promise<InboundResult> {
  const link = await findLinkByNumber(ctx.db, ctx.target.repository.id, number);
  if (!link) return ignored('unlinked_issue');
  await ctx.db.delete(mergeExternalIssues).where(eq(mergeExternalIssues.id, link.id));
  return { outcome: 'updated', events: [] };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function commentEvent(comment: MergeCommentRow, action: 'created' | 'updated' | 'deleted'): PendingEvent {
  return {
    entityType: 'merge_comment',
    action,
    entityId: comment.id,
    data: { id: comment.id, issueId: comment.issueId, authorUserId: comment.authorUserId },
  };
}

async function findByExternalId(db: Db, issueId: string, externalId: string): Promise<MergeCommentRow | null> {
  const [row] = await db
    .select()
    .from(mergeComments)
    .where(and(eq(mergeComments.issueId, issueId), eq(mergeComments.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

/**
 * Applies one provider comment on a linked issue: created (stored with
 * `source = provider`; a comment already stored, such as one we pushed, is
 * ignored), edited (body updated, stored if unknown) or deleted (soft delete).
 */
export async function applyInboundComment(
  ctx: InboundContext,
  action: 'created' | 'edited' | 'deleted',
  comment: NormalizedIssueComment,
): Promise<InboundResult> {
  const { db, target } = ctx;
  if (!syncsInbound(target.repository)) return ignored('issue_sync_off');
  const link = await findLinkByNumber(db, target.repository.id, comment.issueNumber);
  if (!link) return ignored('unlinked_issue');
  if (!(await findIssue(db, link.issueId))) return ignored('issue_deleted');

  const existing = await findByExternalId(db, link.issueId, comment.externalId);
  const now = ctx.now ?? new Date();

  if (action === 'deleted') {
    if (!existing || existing.deletedAt) return ignored('unknown_comment');
    const [row] = await db
      .update(mergeComments)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(mergeComments.id, existing.id))
      .returning();
    return { outcome: 'updated', events: [commentEvent(row!, 'deleted')] };
  }

  if (existing) {
    if (action === 'created' || existing.body === comment.body) return ignored('echo');
    const [row] = await db
      .update(mergeComments)
      .set({ body: comment.body, updatedAt: now })
      .where(eq(mergeComments.id, existing.id))
      .returning();
    return { outcome: 'updated', events: [commentEvent(row!, 'updated')] };
  }

  const authorUserId = comment.authorLogin
    ? await memberForLogin(db, target.repository.provider, target.connection.host, comment.authorLogin)
    : null;
  const [row] = await db
    .insert(mergeComments)
    .values({
      id: generateId('mcm'),
      issueId: link.issueId,
      authorUserId,
      body: comment.body,
      externalId: comment.externalId,
      externalAuthorLogin: comment.authorLogin,
      externalAuthorAvatarUrl: comment.authorAvatarUrl,
      source: 'provider',
      createdAt: comment.createdAt,
      updatedAt: now,
    })
    .returning();
  return { outcome: 'created', events: [commentEvent(row!, 'created')] };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportCounts {
  imported: number;
  updated: number;
  skipped: number;
}

/**
 * Applies a batch of open provider issues (the import): new ones are created,
 * known ones refreshed, echoes and unchanged ones skipped. No chat hooks: a
 * bulk import must not post a message per issue.
 */
export async function importProviderIssues(
  ctx: Omit<InboundContext, 'hooks'>,
  issues: NormalizedIssue[],
): Promise<{ counts: ImportCounts; events: PendingEvent[] }> {
  const counts: ImportCounts = { imported: 0, updated: 0, skipped: 0 };
  const events: PendingEvent[] = [];
  for (const issue of issues) {
    const result = await applyInboundIssue(ctx, issue, { create: true });
    events.push(...result.events);
    if (result.outcome === 'created') counts.imported++;
    else if (result.outcome === 'updated') counts.updated++;
    else counts.skipped++;
  }
  return { counts, events };
}

/** Whether an issue is linked to a provider issue (the DTO's `external`). */
export async function isLinked(db: Db, issueId: string): Promise<boolean> {
  return (await findLinkByIssue(db, issueId)) !== null;
}

/** The team key an issue's events carry. */
export async function teamKeyOf(db: Db, teamId: string): Promise<string> {
  return (await findTeam(db, teamId))?.key ?? '';
}
