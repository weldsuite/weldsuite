/**
 * Releases: /api/merge/releases.
 *
 *   GET    /                    -> list (teamId, repositoryId, status; cursor)          merge_releases:read
 *   GET    /:id                 -> detail: pull requests, issues, desk tickets          merge_releases:read
 *   POST   /                    -> new draft release                                    merge_releases:manage
 *   PATCH  /:id                 -> edit name, version, refs, notes                      merge_releases:manage
 *   DELETE /:id                 -> soft delete                                          merge_releases:manage
 *   POST   /:id/refresh         -> re-read the merged pull requests (draft only)         merge_releases:manage
 *   POST   /:id/generate-notes  -> notes written by the model, charged to the wallet     merge_releases:manage
 *   POST   /:id/ship            -> status shipped, `merge_release.shipped`, chat post    merge_releases:manage
 *   POST   /:id/publish         -> a WeldKnow page and/or an email with the notes        merge_releases:manage
 *
 * A desk ticket's subject (`tickets[].title`) is the ticket's: null without tickets:read.
 *
 * Events: merge_release created | updated | deleted | shipped.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { SpaceAccessError, SpaceNotFoundError } from '@weldsuite/know-domain/access';
import { InsufficientAiCreditsError, resolveAiMetering } from '@weldsuite/core-domain/ai-billing';
import {
  createMergeReleaseSchema,
  listMergeReleasesQuerySchema,
  publishMergeReleaseSchema,
  updateMergeReleaseSchema,
} from '@weldsuite/app-api-client/schemas/weldmerge-across';
import {
  OUTBOUND_DENIAL_CODES,
  outboundDenialStatus,
  type OutboundDenialCode,
} from '@weldsuite/app-api-client/schemas/outbound-mail';
import type { Env, Variables } from '../../types';
import { hookContext, githubClientFor, githubFailure, titleAccess, unprocessable, type Ctx } from '../shared';
import { diffFields, publishEntityEvents, type PendingEvent } from '../../services/events';
import { afterReleaseShipped } from '../../services/hooks';
import { findConnection } from '../../services/connections';
import {
  RELEASE_CHANGE_FIELDS,
  createRelease,
  deleteRelease,
  findLiveRepository,
  findRelease,
  getReleaseDetail,
  hydrateReleases,
  listReleases,
  markShipped,
  notesSource,
  oneReleaseDto,
  refreshRelease,
  releaseEventData,
  saveKnowledgePage,
  saveNotes,
  shippedEventData,
  updateRelease,
} from '../../services/releases';
import { ReleaseNotesError, generateReleaseNotes } from '../../services/release-notes';
import { MailSendError, publishByEmail, publishToKnowledge } from '../../services/release-publish';
import type { MergeReleaseRow } from '../../services/db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

function releaseEvent(
  release: MergeReleaseRow,
  action: 'created' | 'updated' | 'deleted' | 'shipped',
  extra: Record<string, unknown> = {},
  changes?: PendingEvent['changes'],
): PendingEvent {
  return { entityType: 'merge_release', action, entityId: release.id, data: { ...releaseEventData(release), ...extra }, changes };
}

/** The detail; a desk ticket's subject only for a caller with `tickets:read` (`withVisibleTitles`). */
async function detailOf(c: Ctx, release: MergeReleaseRow) {
  const detail = await getReleaseDetail(c.get('tenantDb'), release);
  const access = titleAccess(c);
  const tickets = [];
  for (const ticket of detail.tickets) {
    tickets.push(ticket.title !== null && !(await access('desk_ticket', ticket.ticketId)) ? { ...ticket, title: null } : ticket);
  }
  return { ...detail, tickets };
}

app.get('/', requirePermission('merge_releases:read'), zValidator('query', listMergeReleasesQuerySchema), async (c) => {
  const page = await listReleases(c.get('tenantDb'), c.req.valid('query'));
  const dtos = await hydrateReleases(c.get('tenantDb'), page.rows);
  return list(c, dtos, cursorPagination(dtos.length, page.hasMore, page.cursor));
});

app.get('/:id', requirePermission('merge_releases:read'), async (c) => {
  const id = c.req.param('id');
  const release = await findRelease(c.get('tenantDb'), id);
  if (!release) return error.notFound(c, 'Release', id);
  return success(c, await detailOf(c, release));
});

app.post('/', requirePermission('merge_releases:manage'), zValidator('json', createMergeReleaseSchema), async (c) => {
  const result = await createRelease(c.get('tenantDb'), c.req.valid('json'), c.get('userId'));
  if (!result.ok) {
    return error.notFound(c, result.reason === 'team_not_found' ? 'Team' : 'Repository');
  }
  publishEntityEvents(c, [releaseEvent(result.release, 'created')]);
  return success(c, await detailOf(c, result.release), 201);
});

app.patch('/:id', requirePermission('merge_releases:manage'), zValidator('json', updateMergeReleaseSchema), async (c) => {
  const id = c.req.param('id');
  const result = await updateRelease(c.get('tenantDb'), id, c.req.valid('json'));
  if (!result) return error.notFound(c, 'Release', id);
  const changes = diffFields(result.before, result.release, RELEASE_CHANGE_FIELDS);
  publishEntityEvents(c, [releaseEvent(result.release, 'updated', {}, changes)]);
  return success(c, await detailOf(c, result.release));
});

app.delete('/:id', requirePermission('merge_releases:manage'), async (c) => {
  const id = c.req.param('id');
  const release = await deleteRelease(c.get('tenantDb'), id);
  if (!release) return error.notFound(c, 'Release', id);
  publishEntityEvents(c, [releaseEvent(release, 'deleted')]);
  return noContent(c);
});

app.post('/:id/refresh', requirePermission('merge_releases:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const release = await findRelease(db, id);
  if (!release) return error.notFound(c, 'Release', id);
  if (release.status === 'shipped') return error.conflict(c, 'A shipped release keeps the pull requests it shipped with');
  const repository = await findLiveRepository(db, release.repositoryId);
  if (!repository) return unprocessable(c, "The release's repository is no longer connected");

  try {
    const connection = repository.provider === 'github' ? await findConnection(db, repository.connectionId) : null;
    const client = connection?.status === 'active' ? githubClientFor(c)(connection.externalAccountId) : null;
    const outcome = await refreshRelease(db, release, repository, client);
    publishEntityEvents(c, [releaseEvent(outcome.release, 'updated', { pullRequestIds: outcome.pullRequestIds })]);
    return success(c, await detailOf(c, outcome.release));
  } catch (err) {
    const response = githubFailure(c, err);
    if (response) return response;
    throw err;
  }
});

app.post('/:id/generate-notes', requirePermission('merge_releases:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const release = await findRelease(db, id);
  if (!release) return error.notFound(c, 'Release', id);
  try {
    const metering = await resolveAiMetering(c.env, c.get('workspaceId'), c.get('userId'));
    const notes = await generateReleaseNotes(c.env, await notesSource(db, release), metering);
    const saved = await saveNotes(db, id, notes);
    publishEntityEvents(c, [releaseEvent(saved, 'updated', {}, { notes: { old: release.notes, new: saved.notes } })]);
    return success(c, { release: await oneReleaseDto(db, saved) });
  } catch (err) {
    if (err instanceof InsufficientAiCreditsError) {
      return error.insufficientCredits(c, {
        currentBalance: err.currentBalance,
        required: err.required,
        shortfall: err.shortfall,
      });
    }
    if (err instanceof ReleaseNotesError) {
      if (err.code === 'NOTHING_TO_WRITE') return unprocessable(c, err.message);
      if (err.code === 'AI_NOT_CONFIGURED') return error.unavailable(c, 'AI is not configured for WeldMerge');
      return error.badGateway(c, 'The AI request failed');
    }
    throw err;
  }
});

app.post('/:id/ship', requirePermission('merge_releases:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const release = await findRelease(db, id);
  if (!release) return error.notFound(c, 'Release', id);
  if (release.status === 'shipped') return error.conflict(c, 'The release is already shipped');

  const shipped = await markShipped(db, id);
  // Shipped (or deleted) by another request since it was read.
  if (!shipped) return error.conflict(c, 'The release is already shipped');
  const data = await shippedEventData(db, shipped);
  publishEntityEvents(c, [
    releaseEvent(shipped, 'shipped', {
      pullRequestIds: data.pullRequestIds,
      issueIds: data.issueIds,
      deskTicketIds: data.deskTicketIds,
    }),
  ]);
  await afterReleaseShipped(hookContext(c), shipped, data);
  return success(c, await detailOf(c, shipped));
});

const DENIAL_CODES: ReadonlySet<string> = new Set(OUTBOUND_DENIAL_CODES);

/** A refused or failed send as a response: the guard's own codes keep their code in the body. */
function sendFailure(c: Ctx, err: MailSendError) {
  const body = { error: { code: err.code, message: err.message, ...(err.details === undefined ? {} : { details: err.details }) } };
  if (DENIAL_CODES.has(err.code)) return c.json(body, outboundDenialStatus(err.code as OutboundDenialCode));
  switch (err.code) {
    case 'ACCOUNT_NOT_FOUND':
      return error.notFound(c, 'Mail account');
    case 'FORBIDDEN':
      return error.forbidden(c, err.message);
    case 'SENDER_DOMAIN_NOT_VERIFIED':
      return c.json(body, 422);
    case 'DAILY_LIMIT_REACHED':
    case 'PROVIDER_RATE_LIMITED':
      return c.json(body, 429);
    case 'PARTIALLY_SENT':
      return c.json(body, 502);
    case 'PROVIDER_DAILY_LIMIT':
    case 'STORAGE_BINDING_MISSING':
    case 'SEND_BINDING_MISSING':
      return c.json(body, 503);
    default:
      return error.badRequest(c, err.message, err.details);
  }
}

app.post('/:id/publish', requirePermission('merge_releases:manage'), zValidator('json', publishMergeReleaseSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const input = c.req.valid('json');
  const release = await findRelease(db, id);
  if (!release) return error.notFound(c, 'Release', id);
  if (!release.notes?.trim()) return unprocessable(c, 'Write the release notes first');
  // Publishing writes into other modules: the member needs their permissions there too.
  if (input.knowledgeSpaceId && !(await hasContextPermission(c, 'knowledge:create'))) {
    return error.forbidden(c, 'Publishing to WeldKnow needs permission to create pages');
  }
  if (input.email && !(await hasContextPermission(c, 'messages:create'))) {
    return error.forbidden(c, 'Publishing by email needs permission to send mail');
  }

  let current = release;
  let knowledgePageId: string | null = null;
  try {
    if (input.knowledgeSpaceId) {
      const page = await publishToKnowledge(
        db,
        c.get('userId'),
        release,
        input.knowledgeSpaceId,
        await hasContextPermission(c, 'knowledge:manage'),
      );
      knowledgePageId = page.id;
      current = await saveKnowledgePage(db, id, page.id);
      publishEntityEvent({
        c,
        entityType: 'knowledge_page',
        entityId: page.id,
        action: 'created',
        data: { id: page.id, spaceId: page.spaceId, parentId: null, title: page.title },
      });
      publishEntityEvents(c, [releaseEvent(current, 'updated', {}, { knowledgePageId: { old: release.knowledgePageId, new: page.id } })]);
    }
    if (input.email) {
      const sent = await publishByEmail(c.env, db, { ...hookContext(c), waitUntil: c.executionCtx.waitUntil.bind(c.executionCtx) }, current, input.email);
      publishEntityEvent({
        c,
        entityType: 'email',
        entityId: sent.messageId,
        action: 'email_sent',
        // The recipients and subject stay out of the event, as for a private mailbox.
        data: { id: sent.messageId, accountId: sent.accountId, subject: null, from: null, to: null },
      });
    }
  } catch (err) {
    if (err instanceof SpaceNotFoundError) return error.notFound(c, err.resource, err.id);
    if (err instanceof SpaceAccessError) return error.forbidden(c, err.message);
    if (err instanceof MailSendError) return sendFailure(c, err);
    throw err;
  }
  return success(c, { release: await oneReleaseDto(db, current), knowledgePageId, emailSent: input.email !== undefined });
});

export default app;
