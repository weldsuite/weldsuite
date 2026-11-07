/**
 * WeldMerge to provider: pushes an issue change or a comment through the
 * repository's `IssueSyncAdapter`, creates a provider issue from a WeldMerge
 * one, and unlinks. Provider-agnostic: the adapter is picked by the
 * repository's provider (`issueAdapterFor`).
 *
 * Every push runs inside the request that caused it (so conformance sees the
 * calls) and stores the new `merge_external_issues.checksum`, taken from the
 * provider's own answer, before the webhook echo can arrive. Failures throw
 * (`ProviderApiError` and friends): the automatic hooks swallow and log them,
 * the explicit routes answer 502 `provider_error`.
 */

import { eq } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import { mergeComments, mergeExternalIssues, type Db, type MergeCommentRow, type MergeExternalIssueRow, type MergeIssueRow } from '../db';
import type { Env } from '../../types';
import { issueAdapterFor, providerModule } from '../providers/registry';
import type { IssueWriteInput, NormalizedIssue } from '../providers/types';
import { checksumOf, providerFields, statusToProviderState } from './fields';
import { labelNames, loginForMember } from './people';
import { adapterContext, findLinkByIssue, loadTarget, repositoryRef, type SyncTarget } from './targets';

/** The synced fields a WeldMerge edit touches; any other field (priority, cycle, …) is not pushed. */
const SYNCED_ISSUE_FIELDS = ['title', 'description', 'status', 'labelIds', 'assigneeUserId'] as const;

export function syncedFieldsChanged(before: MergeIssueRow, after: MergeIssueRow): boolean {
  return SYNCED_ISSUE_FIELDS.some((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]));
}

/** The link's repository when it syncs two ways and its connection is live; null otherwise. */
async function twoWayTarget(db: Db, link: MergeExternalIssueRow | null): Promise<SyncTarget | null> {
  if (!link) return null;
  const target = await loadTarget(db, link.repositoryId);
  return target && target.repository.issueSync === 'two_way' ? target : null;
}

async function storePushed(db: Db, link: MergeExternalIssueRow, issue: NormalizedIssue, now: Date): Promise<void> {
  await db
    .update(mergeExternalIssues)
    .set({
      url: issue.url || link.url,
      state: issue.state,
      checksum: await checksumOf(providerFields(issue)),
      lastWriter: 'weldmerge',
      providerUpdatedAt: issue.updatedAt,
      syncedAt: now,
      updatedAt: now,
    })
    .where(eq(mergeExternalIssues.id, link.id));
}

/** The provider write for a WeldMerge issue: every synced field, the assignee only when it changed (or on create). */
async function writeInput(db: Db, target: SyncTarget, issue: MergeIssueRow, assignee: 'always' | 'if_set' | 'skip'): Promise<IssueWriteInput & { title: string }> {
  const { repository, connection } = target;
  const input: IssueWriteInput & { title: string } = {
    title: issue.title,
    body: issue.description ?? '',
    labels: await labelNames(db, issue.labelIds ?? []),
    ...statusToProviderState(issue.status),
  };
  if (assignee === 'skip') return input;
  const login = issue.assigneeUserId ? await loginForMember(db, repository.provider, connection.host, issue.assigneeUserId) : null;
  // An assignee without a linked account cannot be named on the provider: leave the provider's alone.
  if (login || (assignee === 'always' && !issue.assigneeUserId)) input.assigneeLogin = login;
  return input;
}

/**
 * A WeldMerge member's edit of a linked issue, pushed when its repository is
 * `two_way`. Does nothing for an unlinked issue, a one-way repository, or an
 * edit that touched no synced field.
 */
export async function pushIssueUpdate(db: Db, env: Env, before: MergeIssueRow, after: MergeIssueRow, now = new Date()): Promise<boolean> {
  if (!syncedFieldsChanged(before, after)) return false;
  const link = await findLinkByIssue(db, after.id);
  const target = await twoWayTarget(db, link);
  if (!link || !target) return false;

  const input = await writeInput(db, target, after, before.assigneeUserId === after.assigneeUserId ? 'skip' : 'always');
  const updated = await issueAdapterFor(target.repository.provider).updateIssue(
    await adapterContext(db, env, target),
    repositoryRef(target.repository),
    link.number,
    input,
  );
  await storePushed(db, link, updated, now);
  return true;
}

/**
 * A comment a member wrote on a linked issue, pushed to the provider (its
 * provider id is stored on the comment, so the webhook echo is recognised).
 * Edits and deletes of an already pushed comment are not pushed.
 */
export async function pushComment(db: Db, env: Env, comment: MergeCommentRow, issue: MergeIssueRow): Promise<boolean> {
  if (comment.source === 'provider' || comment.externalId) return false;
  const link = await findLinkByIssue(db, issue.id);
  const target = await twoWayTarget(db, link);
  if (!link || !target) return false;

  const pushed = await issueAdapterFor(target.repository.provider).createComment(
    await adapterContext(db, env, target),
    repositoryRef(target.repository),
    link.number,
    comment.body,
  );
  await db.update(mergeComments).set({ externalId: pushed.externalId }).where(eq(mergeComments.id, comment.id));
  return true;
}

export type CreateExternalResult =
  | { ok: true; link: MergeExternalIssueRow; repositoryFullName: string }
  | { ok: false; reason: 'already_linked' | 'repository_not_found' | 'unsupported' };

/**
 * Creates the provider issue for a WeldMerge issue (every synced field, closed
 * when the issue is done or canceled) and links it. Throws when the provider
 * refuses.
 */
export async function createExternalIssue(db: Db, env: Env, issue: MergeIssueRow, repositoryId: string, now = new Date()): Promise<CreateExternalResult> {
  if (await findLinkByIssue(db, issue.id)) return { ok: false, reason: 'already_linked' };
  const target = await loadTarget(db, repositoryId);
  if (!target) return { ok: false, reason: 'repository_not_found' };
  const adapter = providerModule(target.repository.provider).issues;
  if (!adapter) return { ok: false, reason: 'unsupported' };

  const input = await writeInput(db, target, issue, 'if_set');
  const created = await adapter.createIssue(await adapterContext(db, env, target), repositoryRef(target.repository), input);
  const [link] = await db
    .insert(mergeExternalIssues)
    .values({
      id: generateId('mxi'),
      issueId: issue.id,
      repositoryId: target.repository.id,
      provider: target.repository.provider,
      externalId: created.externalId,
      number: created.number,
      url: created.url,
      state: created.state,
      checksum: await checksumOf(providerFields(created)),
      lastWriter: 'weldmerge',
      providerUpdatedAt: created.updatedAt,
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { ok: true, link: link!, repositoryFullName: target.repository.fullName };
}

/** Stops syncing an issue; the provider issue stays. False when it was not linked. */
export async function removeExternalIssue(db: Db, issueId: string): Promise<boolean> {
  const link = await findLinkByIssue(db, issueId);
  if (!link) return false;
  await db.delete(mergeExternalIssues).where(eq(mergeExternalIssues.id, link.id));
  return true;
}
