/**
 * Domains routes — /api/domains/*.
 *
 * Canonical surface for WeldHost domain management. Successor to:
 *   - apps/api-worker/src/routes/host/* (legacy `/host/domains/*`)
 *   - apps/core-api/src/routes/weldhost/domains.ts (legacy `/api/weldhost/domains/*`)
 *
 * Permissions: `domains:read | domains:create | domains:update | domains:delete`.
 * Entity events: `domain:created | updated | deleted | use_external`.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  listDomainsQuery,
  domainSearchQuery,
  domainCheckInput,
  createDomainSchema,
  updateDomainSchema,
  externalDomainSchema,
  checkoutInput,
  toggleAutoRenewInput,
  togglePrivacyInput,
  toggleLockInput,
  completeRegistrationInput,
} from '@weldsuite/core-api-client/schemas/domains';
import type { Env, Variables } from '../../types';
import { error, list, noContent, success } from '../../lib/response';
import * as domainsService from '../../services/domains';
import { getMasterDb } from '../../db';
import { CloudflareRegistrar } from '@weldsuite/cloudflare-registrar';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ============================================================================
// CF Registrar client — only when both env vars are present. The handlers
// branch on this so workspaces with external-only domains keep working in
// environments where the registrar is not configured.
// ============================================================================

function getRegistrar(env: Env): CloudflareRegistrar | null {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? env.CF_ACCOUNT_ID;
  if (!apiToken || !accountId) return null;
  return new CloudflareRegistrar({ accountId, apiToken });
}

// ============================================================================
// Dashboard — mounted BEFORE `:id` routes so `dashboard` is not claimed
// ============================================================================

app.get('/dashboard', requirePermission('domains:read'), async (c) => {
  try {
    const stats = await domainsService.getDashboardStats(c.get('tenantDb'));
    return success(c, stats);
  } catch (err) {
    console.error('[app-api/domains] dashboard failed:', err);
    return error.internal(c, 'Failed to fetch dashboard stats');
  }
});

app.get('/dashboard/chart', requirePermission('domains:read'), async (c) => {
  const days = Math.min(Math.max(parseInt(c.req.query('days') ?? '90', 10) || 90, 1), 365);
  try {
    const data = await domainsService.getDashboardChart(c.get('tenantDb'), days);
    return success(c, data);
  } catch (err) {
    console.error('[app-api/domains] dashboard chart failed:', err);
    return error.internal(c, 'Failed to fetch chart data');
  }
});

app.get('/dashboard/recent', requirePermission('domains:read'), async (c) => {
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '10', 10) || 10, 1), 100);
  try {
    const rows = await domainsService.getDashboardRecent(c.get('tenantDb'), limit);
    return success(c, rows);
  } catch (err) {
    console.error('[app-api/domains] dashboard recent failed:', err);
    return error.internal(c, 'Failed to fetch recent domains');
  }
});

// ============================================================================
// Search / availability / checkout (placed before `:id` for routing precedence)
// ============================================================================

app.get(
  '/search',
  requirePermission('domains:read'),
  zValidator('query', domainSearchQuery),
  async (c) => {
    const cf = getRegistrar(c.env);
    if (!cf) return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Cloudflare Registrar is not configured' } }, 503);
    try {
      const masterDb = getMasterDb(c.env);
      const { q, limit } = c.req.valid('query');
      const results = await domainsService.searchDomains(cf, masterDb, { query: q, limit });
      return success(c, results);
    } catch (err) {
      console.error('[app-api/domains] search failed:', err);
      return error.internal(c, 'Domain search failed');
    }
  },
);

app.post(
  '/check',
  requirePermission('domains:read'),
  zValidator('json', domainCheckInput),
  async (c) => {
    const cf = getRegistrar(c.env);
    if (!cf) return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Cloudflare Registrar is not configured' } }, 503);
    try {
      const masterDb = getMasterDb(c.env);
      const results = await domainsService.checkDomains(cf, masterDb, c.req.valid('json'));
      return success(c, results);
    } catch (err) {
      console.error('[app-api/domains] check failed:', err);
      return error.internal(c, 'Domain availability check failed');
    }
  },
);

app.post(
  '/checkout',
  requirePermission('domains:create'),
  zValidator('json', checkoutInput),
  async (c) => {
    const workspaceId = c.get('workspaceId');
    if (!workspaceId) return error.orgRequired(c);
    const cf = getRegistrar(c.env);
    if (!cf) return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Cloudflare Registrar is not configured' } }, 503);
    if (!c.env.STRIPE_SECRET_KEY) return error.internal(c, 'Stripe is not configured');

    const origin = c.req.header('origin') ?? 'https://app.weldsuite.org';
    try {
      const result = await domainsService.createCheckout(c.get('tenantDb'), cf, getMasterDb(c.env), {
        workspaceId,
        stripeSecretKey: c.env.STRIPE_SECRET_KEY,
        origin,
        input: c.req.valid('json'),
      });
      if (!result.ok) {
        if (result.reason === 'unavailable') {
          return error.badRequest(c, `Domain ${result.domain} is not available for registration`);
        }
        if (result.reason === 'no_price') {
          return error.internal(c, `No price available for .${result.tld}`);
        }
        if (result.reason === 'no_stripe_customer') {
          return error.badRequest(c, 'Workspace has no Stripe customer — complete billing setup first');
        }
      } else {
        publishEntityEvent({
          c,
          entityType: 'domain',
          entityId: result.registrationIds[0]!,
          action: 'created',
          data: { id: result.registrationIds[0]!, name: c.req.valid('json').domain, status: 'pending' },
        });
        return success(
          c,
          {
            checkoutSessionId: result.sessionId,
            checkoutUrl: result.url,
            registrationIds: result.registrationIds,
          },
          201,
        );
      }
    } catch (err) {
      console.error('[app-api/domains] checkout failed:', err);
      return error.internal(c, 'Failed to initiate checkout');
    }
  },
);

// ============================================================================
// External / verify-ownership (also placed before `:id` routes)
// ============================================================================

app.post(
  '/external',
  requirePermission('domains:create'),
  zValidator('json', externalDomainSchema),
  async (c) => {
    const db = c.get('tenantDb');
    try {
      const result = await domainsService.addExternalDomain(db, c.req.valid('json'));
      if (!result.ok) {
        return error.conflict(c, 'This domain is already being managed in your workspace.');
      }
      publishEntityEvent({
        c,
        entityType: 'domain',
        entityId: result.result.domain.id,
        action: 'use_external',
        data: {
          id: result.result.domain.id,
          name: result.result.domain.fullDomain,
          status: result.result.domain.status,
        },
      });
      return success(
        c,
        {
          ...result.result.domain,
          verificationRecord: result.result.verificationRecord,
        },
        201,
      );
    } catch (err) {
      console.error('[app-api/domains] add external failed:', err);
      return error.internal(c, 'Failed to add external domain');
    }
  },
);

// ============================================================================
// List — paginated, filterable
// ============================================================================

app.get('/', requirePermission('domains:read'), zValidator('query', listDomainsQuery), async (c) => {
  try {
    const result = await domainsService.listDomains(c.get('tenantDb'), c.req.valid('query'));
    return c.json(result);
  } catch (err) {
    console.error('[app-api/domains] list failed:', err);
    return error.internal(c, 'Failed to fetch domains');
  }
});

// ============================================================================
// Single domain — must come AFTER any sibling `/:id`-shaped paths above
// ============================================================================

app.get('/:id', requirePermission('domains:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const got = await domainsService.getDomainWithZone(c.get('tenantDb'), id);
    if (!got) return error.notFound(c, 'Domain', id);
    return success(c, {
      ...got.domain,
      dnsZone: got.zone ?? null,
    });
  } catch (err) {
    console.error('[app-api/domains] get failed:', err);
    return error.internal(c, 'Failed to fetch domain');
  }
});

app.post(
  '/',
  requirePermission('domains:create'),
  zValidator('json', createDomainSchema),
  async (c) => {
    try {
      const row = await domainsService.createDomain(c.get('tenantDb'), c.req.valid('json'));
      publishEntityEvent({
        c,
        entityType: 'domain',
        entityId: row.id,
        action: 'created',
        data: { id: row.id, name: row.fullDomain, status: row.status },
      });
      return success(c, row, 201);
    } catch (err) {
      console.error('[app-api/domains] create failed:', err);
      return error.internal(c, 'Failed to create domain');
    }
  },
);

app.patch(
  '/:id',
  requirePermission('domains:update'),
  zValidator('json', updateDomainSchema),
  async (c) => {
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const res = await domainsService.updateDomain(c.get('tenantDb'), id, data as Record<string, unknown>);
      if (!res) return error.notFound(c, 'Domain', id);
      publishEntityEvent({
        c,
        entityType: 'domain',
        entityId: id,
        action: 'updated',
        data: { id, name: res.row.fullDomain, status: res.row.status },
      });
      return success(c, res.row);
    } catch (err) {
      console.error('[app-api/domains] update failed:', err);
      return error.internal(c, 'Failed to update domain');
    }
  },
);

app.delete('/:id', requirePermission('domains:delete'), async (c) => {
  const id = c.req.param('id');
  try {
    const deleted = await domainsService.deleteDomain(c.get('tenantDb'), id);
    if (!deleted) return error.notFound(c, 'Domain', id);
    publishEntityEvent({
      c,
      entityType: 'domain',
      entityId: id,
      action: 'deleted',
      data: { id, name: deleted.fullDomain, status: deleted.status },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/domains] delete failed:', err);
    return error.internal(c, 'Failed to delete domain');
  }
});

// ============================================================================
// Per-domain toggles + sync + verify
// ============================================================================

app.post(
  '/:id/toggle-auto-renew',
  requirePermission('domains:update'),
  zValidator('json', toggleAutoRenewInput),
  async (c) => {
    const id = c.req.param('id');
    const { enabled } = c.req.valid('json');
    try {
      const updated = await domainsService.toggleAutoRenew(c.get('tenantDb'), getRegistrar(c.env), {
        domainId: id,
        enabled,
      });
      if (!updated) return error.notFound(c, 'Domain', id);
      publishEntityEvent({
        c,
        entityType: 'domain',
        entityId: id,
        action: 'updated',
        data: { id, name: updated.fullDomain, status: updated.status },
      });
      return success(c, updated);
    } catch (err) {
      console.error('[app-api/domains] toggle-auto-renew failed:', err);
      return error.internal(c, 'Failed to toggle auto-renew');
    }
  },
);

app.post(
  '/:id/toggle-privacy',
  requirePermission('domains:update'),
  zValidator('json', togglePrivacyInput),
  async (c) => {
    const id = c.req.param('id');
    const { enabled } = c.req.valid('json');
    try {
      const updated = await domainsService.togglePrivacy(c.get('tenantDb'), { domainId: id, enabled });
      if (!updated) return error.notFound(c, 'Domain', id);
      publishEntityEvent({
        c,
        entityType: 'domain',
        entityId: id,
        action: 'updated',
        data: { id, name: updated.fullDomain, status: updated.status },
      });
      return success(c, updated);
    } catch (err) {
      console.error('[app-api/domains] toggle-privacy failed:', err);
      return error.internal(c, 'Failed to toggle privacy protection');
    }
  },
);

app.post(
  '/:id/toggle-lock',
  requirePermission('domains:update'),
  zValidator('json', toggleLockInput),
  async (c) => {
    const id = c.req.param('id');
    const { locked } = c.req.valid('json');
    try {
      const updated = await domainsService.toggleLock(c.get('tenantDb'), getRegistrar(c.env), {
        domainId: id,
        locked,
      });
      if (!updated) return error.notFound(c, 'Domain', id);
      publishEntityEvent({
        c,
        entityType: 'domain',
        entityId: id,
        action: 'updated',
        data: { id, name: updated.fullDomain, status: updated.status },
      });
      return success(c, updated);
    } catch (err) {
      console.error('[app-api/domains] toggle-lock failed:', err);
      return error.internal(c, 'Failed to toggle transfer lock');
    }
  },
);

app.post('/:id/sync', requirePermission('domains:update'), async (c) => {
  const id = c.req.param('id');
  const cf = getRegistrar(c.env);
  if (!cf) {
    // No registrar configured — just touch the syncedAt timestamp.
    const db = c.get('tenantDb');
    const existing = await domainsService.getDomain(db, id);
    if (!existing) return error.notFound(c, 'Domain', id);
    await domainsService.updateDomain(db, id, { registrarSyncedAt: new Date().toISOString() });
    return success(c, { id, syncedAt: new Date().toISOString() });
  }
  try {
    const updated = await domainsService.syncDomainStatus(c.get('tenantDb'), cf, id);
    if (!updated) return error.notFound(c, 'Domain', id);
    publishEntityEvent({
      c,
      entityType: 'domain',
      entityId: id,
      action: 'updated',
      data: { id, name: updated.fullDomain, status: updated.status },
    });
    return success(c, updated);
  } catch (err) {
    console.error('[app-api/domains] sync failed:', err);
    return error.internal(c, 'Domain sync failed');
  }
});

app.post('/:id/verify-nameservers', requirePermission('domains:update'), async (c) => {
  const id = c.req.param('id');
  try {
    const domain = await domainsService.markNameserverVerificationPending(c.get('tenantDb'), id);
    if (!domain) return error.notFound(c, 'Domain', id);
    const requiredNameservers = ['ns1.weldhost.com', 'ns2.weldhost.com', 'ns3.weldhost.com', 'ns4.weldhost.com'];
    return c.json({
      success: true,
      verified: false,
      requiredNameservers,
      currentNameservers: (domain.nameservers as string[]) || [],
      message: 'Nameserver verification initiated. DNS propagation can take up to 48 hours.',
    });
  } catch (err) {
    console.error('[app-api/domains] verify-nameservers failed:', err);
    return error.internal(c, 'Failed to verify nameservers');
  }
});

app.post('/:id/verify-ownership', requirePermission('domains:create'), async (c) => {
  const id = c.req.param('id');
  try {
    const result = await domainsService.verifyOwnershipAndCreateZone(c.get('tenantDb'), {
      domainId: id,
      apiToken: c.env.CLOUDFLARE_API_TOKEN,
      accountId: c.env.CLOUDFLARE_ACCOUNT_ID ?? c.env.CF_ACCOUNT_ID,
    });

    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          return error.notFound(c, 'Domain', id);
        case 'missing_token':
          return error.badRequest(c, 'This domain has no verification token. Re-add the domain.');
        case 'dns_failed':
          return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'DNS lookup failed. Try again in a minute.' } }, 503);
        case 'txt_not_found':
          return c.json(
            {
              success: false,
              error: {
                code: 'VERIFICATION_FAILED',
                message:
                  `TXT record not found at ${result.details.expected.name}. ` +
                  'DNS propagation can take a few minutes after you add the record.',
                details: result.details,
              },
            },
            400,
          );
        case 'cf_misconfigured':
          return error.internal(c, 'Cloudflare integration is not configured.');
        case 'cf_domain_taken':
          return c.json(
            {
              success: false,
              error: {
                code: 'DOMAIN_IN_ANOTHER_CF_ACCOUNT',
                message:
                  'This domain is already registered on another Cloudflare account. ' +
                  'Remove it there before adding it to WeldHost.',
              },
            },
            409,
          );
        case 'cf_auth_failed':
          return error.internal(c, 'Cloudflare authentication failed.');
        case 'cf_invalid_domain':
          return error.badRequest(c, result.message);
        case 'cf_unknown':
          return error.internal(c, 'Failed to create Cloudflare zone.');
        case 'persist_failed':
          return error.internal(c, 'Failed to persist zone. The Cloudflare zone was rolled back.');
      }
    }

    if (!result.idempotent) {
      publishEntityEvent({
        c,
        entityType: 'dns_zone',
        entityId: result.zone.id,
        action: 'created',
        data: {
          id: result.zone.id,
          name: result.zone.name,
          status: result.zone.status,
        },
      });
    }

    return success(c, {
      ...result.domain,
      nameservers: result.nameservers,
      dnsZone: result.zone,
    });
  } catch (err) {
    console.error('[app-api/domains] verify-ownership failed:', err);
    return error.internal(c, 'Failed to verify ownership');
  }
});

app.post('/:id/refresh-zone-status', requirePermission('domains:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const result = await domainsService.refreshZoneStatus(c.get('tenantDb'), {
      domainId: id,
      apiToken: c.env.CLOUDFLARE_API_TOKEN,
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          return error.notFound(c, 'Domain', id);
        case 'no_cf_zone':
          return error.badRequest(c, 'This domain does not have a Cloudflare zone yet.');
        case 'cf_misconfigured':
          return error.internal(c, 'Cloudflare integration is not configured.');
        case 'cf_unreachable':
          return c.json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Could not reach Cloudflare. Try again in a moment.' } }, 503);
      }
    }
    return success(c, {
      zoneStatus: result.zoneStatus,
      domainStatus: result.domainStatus,
      cloudflareStatus: result.cloudflareStatus,
      nameservers: result.nameservers,
    });
  } catch (err) {
    console.error('[app-api/domains] refresh-zone-status failed:', err);
    return error.internal(c, 'Failed to refresh zone status');
  }
});

app.post('/:id/auth-code', requirePermission('domains:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const result = await domainsService.issueAuthCode(c.get('tenantDb'), id);
    if (!result) return error.notFound(c, 'Domain', id);
    return c.json({
      success: true,
      authCode: result.authCode,
      expiresAt: result.expiresAt.toISOString(),
    });
  } catch (err) {
    console.error('[app-api/domains] auth-code failed:', err);
    return error.internal(c, 'Failed to get auth code');
  }
});

// ============================================================================
// Registration polling & completion
// ============================================================================

app.get('/registrations/:id/status', requirePermission('domains:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const row = await domainsService.getRegistrationStatus(c.get('tenantDb'), id);
    if (!row) return error.notFound(c, 'Domain registration', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/domains] registration status failed:', err);
    return error.internal(c, 'Failed to fetch registration status');
  }
});

app.post(
  '/registrations/:id/complete',
  requirePermission('domains:update'),
  zValidator('json', completeRegistrationInput),
  async (c) => {
    const id = c.req.param('id');
    const body = c.req.valid('json');
    try {
      const row = await domainsService.completeRegistration(c.get('tenantDb'), id, body.contactInfo);
      if (!row) return error.notFound(c, 'Domain registration', id);
      publishEntityEvent({
        c,
        entityType: 'domain',
        entityId: id,
        action: 'updated',
        data: { id, name: row.fullDomain, status: row.status },
      });
      return success(c, { success: true, domainId: id, domain: row });
    } catch (err) {
      console.error('[app-api/domains] complete-registration failed:', err);
      return error.internal(c, 'Failed to complete registration');
    }
  },
);

export const domainsRoutes = app;
