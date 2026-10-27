/**
 * /api/reach/mailboxes: outreach mailboxes (Mailpool inboxes on connected
 * domains). They cost money and carry the sender reputation, so writes are
 * ADMIN by default (permission catalog).
 *
 *   reach_mailboxes:read    GET /, GET /:id
 *   reach_mailboxes:create  POST /                 billed, provisioned, entered in the warmup network (services/mailboxes.ts)
 *   reach_mailboxes:update  PATCH /:id, POST /:id/pause, POST /:id/resume   (pause and resume also stop / restart its warmup)
 *   reach_mailboxes:delete  DELETE /:id
 *
 * Responses never include the mailbox logins or the inbound token; entity
 * events carry rows without the sealed credential columns.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import {
  createReachMailboxSchema,
  reachMailboxStatusSchema,
  updateReachMailboxSchema,
} from '@weldsuite/app-api-client/schemas/reach';
import type { Env, Variables } from '../../types';
import { getMailboxDto, listMailboxes, withoutCredentials, type MailboxReadDeps } from '@weldsuite/reach-domain/mailboxes';
import { createReachBilling } from '../../lib/billing';
import { createMailpoolClient } from '../../lib/mailpool/client';
import { accountContextOf } from '../../services/access';
import { createMailbox, deleteMailbox, pauseMailbox, readDepsOf, resumeMailbox, updateMailbox } from '../../services/mailboxes';
import { reachErrorHandler } from '../../services/reach-errors';
import { getOrCreateReachSettings } from '../../services/settings';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.onError(reachErrorHandler);

const listQuerySchema = z.object({
  domainId: z.string().min(1).max(30).optional(),
  status: reachMailboxStatusSchema.optional(),
});

/** Everything the services need for a write that reaches Mailpool and billing. */
function writeDeps(c: Parameters<typeof accountContextOf>[0]) {
  const ctx = accountContextOf(c);
  return {
    ...ctx,
    env: c.env,
    mailpool: createMailpoolClient(c.env),
    billing: createReachBilling(c),
  };
}

/** Reads show the warmup pool's numbers; master is opened only when there is a mailbox to show them for. */
function readDeps(c: Parameters<typeof accountContextOf>[0]): MailboxReadDeps {
  return { db: c.get('tenantDb'), warmup: { clerkOrgId: c.get('clerkOrgId'), master: () => getMasterDb(c.env) } };
}

app.get('/', requirePermission('reach_mailboxes:read'), zValidator('query', listQuerySchema), async (c) => {
  const mailboxes = await listMailboxes(readDeps(c), c.req.valid('query'));
  return list(c, mailboxes, cursorPagination(mailboxes.length, false, null));
});

app.get('/:id', requirePermission('reach_mailboxes:read'), async (c) => {
  const mailbox = await getMailboxDto(readDeps(c), c.req.param('id'));
  if (!mailbox) return error.notFound(c, 'Mailbox', c.req.param('id'));
  return success(c, mailbox);
});

app.post('/', requirePermission('reach_mailboxes:create'), zValidator('json', createReachMailboxSchema), async (c) => {
  const deps = writeDeps(c);
  const settings = await getOrCreateReachSettings(deps.db);

  const row = await createMailbox(deps, c.req.valid('json'), {
    limits: deps.limits,
    defaultDailyCap: settings.defaultMailboxDailyCap,
    billingStatus: c.get('appAccess').billingStatus,
    timezone: settings.defaultTimezone,
  });

  publishEntityEvent({ c, entityType: 'reach_mailbox', action: 'created', entityId: row.id, data: withoutCredentials(row) });
  const mailbox = await getMailboxDto(readDepsOf(deps), row.id);
  return success(c, mailbox, 201);
});

app.patch('/:id', requirePermission('reach_mailboxes:update'), zValidator('json', updateReachMailboxSchema), async (c) => {
  const deps = writeDeps(c);
  const row = await updateMailbox(deps, c.req.param('id'), c.req.valid('json'));

  publishEntityEvent({ c, entityType: 'reach_mailbox', action: 'updated', entityId: row.id, data: withoutCredentials(row) });
  return success(c, await getMailboxDto(readDepsOf(deps), row.id));
});

app.post('/:id/pause', requirePermission('reach_mailboxes:update'), async (c) => {
  const ctx = accountContextOf(c);
  const row = await pauseMailbox(ctx, c.req.param('id'));

  publishEntityEvent({ c, entityType: 'reach_mailbox', action: 'updated', entityId: row.id, data: withoutCredentials(row) });
  return success(c, await getMailboxDto(readDepsOf(ctx), row.id));
});

app.post('/:id/resume', requirePermission('reach_mailboxes:update'), async (c) => {
  const ctx = accountContextOf(c);
  const row = await resumeMailbox(ctx, c.req.param('id'));

  publishEntityEvent({ c, entityType: 'reach_mailbox', action: 'updated', entityId: row.id, data: withoutCredentials(row) });
  return success(c, await getMailboxDto(readDepsOf(ctx), row.id));
});

app.delete('/:id', requirePermission('reach_mailboxes:delete'), async (c) => {
  const row = await deleteMailbox(writeDeps(c), c.req.param('id'));

  publishEntityEvent({ c, entityType: 'reach_mailbox', action: 'deleted', entityId: row.id, data: withoutCredentials(row) });
  return noContent(c);
});

export default app;
