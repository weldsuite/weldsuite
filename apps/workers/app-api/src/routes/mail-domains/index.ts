/**
 * Mail domain routes — /api/mail-domains/*.
 *
 * Mail domains are the per-workspace zones authorised for inbound (Email
 * Routing) and outbound (Email Sending) via the Cloudflare
 * `[[send_email]]` binding. The service layer owns the Cloudflare API
 * calls — this file only handles HTTP wiring.
 *
 * Endpoints kept from the legacy api-worker surface:
 *   - GET /by-name/:domainName — lookup before create flow
 *   - POST /:id/verify — re-query CF for current state, update flags
 *   - POST /:id/sync — re-assert CF provisioning (self-heal)
 *   - POST /:id/generate-dkim — no-op on Cloudflare, preserved for parity
 *
 * Entity events: `mail_domain:created | updated | deleted | verified`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import * as domains from '../../services/mail/domains';
import { MailDomainError } from '../../services/mail/domains';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const listQuery = z.object({
  isActive: z.coerce.boolean().optional(),
  isPrimary: z.coerce.boolean().optional(),
});

const createBody = z.object({
  domainName: z.string().min(3).max(255).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Invalid domain name'),
  isActive: z.boolean().optional(),
  isPrimary: z.boolean().optional(),
  mailProvider: z.string().max(100).optional(),
  sendProvider: z.string().max(50).optional(),
  receiveProvider: z.string().max(50).optional(),
  maxEmailAccounts: z.number().int().min(1).max(10000).optional(),
});

const updateBody = createBody.omit({ domainName: true }).partial();

function mapDomainError(c: Parameters<typeof error.badRequest>[0], err: MailDomainError) {
  switch (err.code) {
    case 'NOT_FOUND':
      return error.notFound(c, 'Domain');
    case 'DUPLICATE_DOMAIN':
      return error.conflict(c, err.message);
    case 'CLOUDFLARE_PROVISION_FAILED':
    case 'CLOUDFLARE_VERIFY_FAILED':
      return c.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        502,
      );
  }
}

app.get('/', requirePermission('accounts:read'), zValidator('query', listQuery), async (c) => {
  try {
    const rows = await domains.listDomains(c.get('tenantDb'), c.req.valid('query'));
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/mail-domains] list failed:', err);
    return error.internal(c, 'Failed to list domains');
  }
});

// Static path before /:id so it isn't shadowed.
app.get('/by-name/:domainName', requirePermission('accounts:read'), async (c) => {
  const domainName = c.req.param('domainName');
  try {
    const row = await domains.getDomainByName(c.get('tenantDb'), domainName);
    if (!row) return error.notFound(c, 'Domain', domainName);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/mail-domains] by-name failed:', err);
    return error.internal(c, 'Failed to look up domain');
  }
});

app.get('/:id', requirePermission('accounts:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await domains.getDomain(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'Domain', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/mail-domains] get failed:', err);
    return error.internal(c, 'Failed to fetch domain');
  }
});

app.post('/', requirePermission('accounts:create'), zValidator('json', createBody), async (c) => {
  try {
    const row = await domains.createDomain(c.env, c.get('tenantDb'), c.req.valid('json'));
    publishEntityEvent({
      c,
      entityType: 'mail_domain',
      entityId: row.id,
      action: 'created',
      data: {
        id: row.id,
        domainName: row.domainName,
        dnsStatus: row.dnsStatus,
        isPrimary: row.isPrimary,
      },
    });
    return success(c, row, 201);
  } catch (err) {
    if (err instanceof MailDomainError) return mapDomainError(c, err);
    console.error('[app-api/mail-domains] create failed:', err);
    return error.internal(c, 'Failed to create domain');
  }
});

const updateRoute = async (
  c: import('hono').Context<{ Bindings: Env; Variables: Variables }>,
) => {
  const id = c.req.param('id');
  const data = c.req.valid('json' as never) as z.infer<typeof updateBody>;
  try {
    const result = await domains.updateDomain(c.get('tenantDb'), id, data);
    publishEntityEvent({
      c,
      entityType: 'mail_domain',
      entityId: id,
      action: 'updated',
      data: {
        id,
        domainName: result.after.domainName,
        dnsStatus: result.after.dnsStatus,
        isPrimary: result.after.isPrimary,
      },
    });
    return success(c, result.after);
  } catch (err) {
    if (err instanceof MailDomainError) return mapDomainError(c, err);
    console.error('[app-api/mail-domains] update failed:', err);
    return error.internal(c, 'Failed to update domain');
  }
};

app.put('/:id', requirePermission('accounts:update'), zValidator('json', updateBody), updateRoute);
app.patch('/:id', requirePermission('accounts:update'), zValidator('json', updateBody), updateRoute);

app.delete('/:id', requirePermission('accounts:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const deleted = await domains.softDeleteDomain(c.env, c.get('tenantDb'), id);
    if (!deleted) return error.notFound(c, 'Domain', id);
    publishEntityEvent({
      c,
      entityType: 'mail_domain',
      entityId: id,
      action: 'deleted',
      data: {
        id,
        domainName: deleted.domainName,
        dnsStatus: deleted.dnsStatus,
        isPrimary: deleted.isPrimary,
      },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/mail-domains] delete failed:', err);
    return error.internal(c, 'Failed to delete domain');
  }
});

app.post('/:id/verify', requirePermission('accounts:update'), async (c) => {
  const id = c.req.param('id');
  try {
    const result = await domains.verifyDomain(c.env, c.get('tenantDb'), id);
    if (result.verified) {
      publishEntityEvent({
        c,
        entityType: 'mail_domain',
        entityId: id,
        action: 'verified',
        data: {
          id,
          domainName: result.after.domainName,
          dnsStatus: result.after.dnsStatus,
          isPrimary: result.after.isPrimary,
        },
      });
    }
    return success(c, result.after);
  } catch (err) {
    if (err instanceof MailDomainError) return mapDomainError(c, err);
    console.error('[app-api/mail-domains] verify failed:', err);
    return error.internal(c, 'Failed to verify domain');
  }
});

app.post('/:id/sync', requirePermission('accounts:update'), async (c) => {
  const id = c.req.param('id');
  try {
    const after = await domains.syncDomain(c.env, c.get('tenantDb'), id);
    publishEntityEvent({
      c,
      entityType: 'mail_domain',
      entityId: id,
      action: 'updated',
      data: {
        id,
        domainName: after.domainName,
        dnsStatus: after.dnsStatus,
        isPrimary: after.isPrimary,
      },
    });
    return success(c, after);
  } catch (err) {
    if (err instanceof MailDomainError) return mapDomainError(c, err);
    console.error('[app-api/mail-domains] sync failed:', err);
    return error.internal(c, 'Failed to sync domain');
  }
});

app.post('/:id/generate-dkim', requirePermission('accounts:update'), async (c) => {
  const id = c.req.param('id');
  try {
    const result = await domains.generateDkim(c.env, c.get('tenantDb'), id);
    return success(c, result);
  } catch (err) {
    if (err instanceof MailDomainError) return mapDomainError(c, err);
    console.error('[app-api/mail-domains] generate-dkim failed:', err);
    return error.internal(c, 'Failed to generate DKIM record');
  }
});

export const mailDomainsRoutes = app;
