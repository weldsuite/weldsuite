/**
 * /api/reach/domains: WeldHost domains connected to Mailpool.
 *
 *   reach_mailboxes:read    GET /, GET /candidates, GET /:id
 *   reach_mailboxes:create  POST /                 connect a WeldHost domain
 *   reach_mailboxes:update  POST /:id/refresh-dns  re-read Mailpool + DNS health
 *   reach_mailboxes:delete  DELETE /:id            disconnect (409 while it has mailboxes)
 *
 * The domain to connect is always resolved from `hostDomainId` in THIS
 * workspace's tenant DB and every guard is re-run here (services/domains.ts);
 * a name from the client is never trusted.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, list, noContent, success } from '@weldsuite/worker-kit/response';
import { connectReachDomainSchema } from '@weldsuite/app-api-client/schemas/reach';
import type { Env, Variables } from '../../types';
import { createMailpoolClient } from '../../lib/mailpool/client';
import { accountContextOf } from '../../services/access';
import { getDomainDto, listDomains, toDomainDto } from '@weldsuite/reach-domain/domains';
import { connectDomain, disconnectDomain, listCandidates, refreshDomainDns } from '../../services/domains';
import { reachErrorHandler } from '../../services/reach-errors';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.onError(reachErrorHandler);

app.get('/', requirePermission('reach_mailboxes:read'), async (c) => {
  const domains = await listDomains(c.get('tenantDb'));
  return list(c, domains, cursorPagination(domains.length, false, null));
});

// Registered before '/:id' so "candidates" is not read as an id.
app.get('/candidates', requirePermission('reach_mailboxes:read'), async (c) => {
  const { db, limits } = accountContextOf(c);
  const candidates = await listCandidates({ db, limits });
  return list(c, candidates, cursorPagination(candidates.length, false, null));
});

app.get('/:id', requirePermission('reach_mailboxes:read'), async (c) => {
  return success(c, await getDomainDto(c.get('tenantDb'), c.req.param('id')));
});

app.post('/', requirePermission('reach_mailboxes:create'), zValidator('json', connectReachDomainSchema), async (c) => {
  const ctx = accountContextOf(c);
  const { hostDomainId } = c.req.valid('json');

  const row = await connectDomain({ ...ctx, mailpool: createMailpoolClient(c.env) }, hostDomainId);

  publishEntityEvent({ c, entityType: 'reach_domain', action: 'connected', entityId: row.id, data: row });
  return success(c, toDomainDto(row, 0), 201);
});

app.post('/:id/refresh-dns', requirePermission('reach_mailboxes:update'), async (c) => {
  const ctx = accountContextOf(c);
  const row = await refreshDomainDns({ ...ctx, mailpool: createMailpoolClient(c.env) }, c.req.param('id'));

  publishEntityEvent({ c, entityType: 'reach_domain', action: 'updated', entityId: row.id, data: row });
  return success(c, await getDomainDto(ctx.db, row.id));
});

app.delete('/:id', requirePermission('reach_mailboxes:delete'), async (c) => {
  const ctx = accountContextOf(c);
  const row = await disconnectDomain({ ...ctx, mailpool: createMailpoolClient(c.env) }, c.req.param('id'));

  publishEntityEvent({ c, entityType: 'reach_domain', action: 'disconnected', entityId: row.id, data: row });
  return noContent(c);
});

export default app;
