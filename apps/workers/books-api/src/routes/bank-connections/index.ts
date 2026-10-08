/**
 * Bank feed connections (@weldsuite/bank-feeds): link a bank through an
 * aggregator, map its accounts to WeldBooks bank accounts, sync, disconnect.
 *
 * GET    /                    connections with their accounts and status
 * GET    /providers           providers offered for a country, with capabilities
 * GET    /institutions        banks a provider can link (Enable Banking)
 * POST   /link-session        start a link (Plaid Link token, Stripe FC client secret, or a redirect URL)
 * POST   /complete            finish a link: stores the connection, returns accounts with suggested matches
 * POST   /:id/map-accounts    attach feed accounts to existing bank accounts or create new ones
 * POST   /:id/sync            sync now (optionally asking the provider to refresh first)
 * POST   /:id/disconnect      revoke at the provider, keep every synced transaction
 * DELETE /:id                 disconnect and remove the connection
 * GET    /:id/pending         pending transactions the bank has reported
 * GET    /:id                 one connection
 *
 * Responses never carry provider tokens or full account numbers, and neither do
 * the entity events. Permissions: banking:read | create | update | manage.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { enabledProviders } from '@weldsuite/bank-feeds';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { schema } from '@weldsuite/worker-kit/db';
import type { Env, Variables } from '../../types';
import { resolveEntityId } from '../../lib/entity-context';
import {
  completeLink,
  connectionViewById,
  createLinkSession,
  deleteConnection,
  disconnectConnection,
  listConnectionViews,
  listPendingTransactions,
  mapAccounts,
  requireConnection,
} from '../../services/bank-feeds/connections';
import { FeedServiceError, translateProviderError } from '../../services/bank-feeds/errors';
import { feedProviders, createFeedContext } from '../../services/bank-feeds/runtime';
import { syncConnection } from '../../services/bank-feeds/sync';
import type { ConnectionView } from '../../services/bank-feeds/types';

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const accountTypes = ['checking', 'savings', 'credit_card', 'money_market', 'line_of_credit'] as const;

const linkSessionSchema = z.object({
  provider: z.string().min(1).max(30),
  mode: z.enum(['create', 'reauth', 'add_accounts']).default('create'),
  connectionId: z.string().max(30).optional(),
  redirectUrl: z.string().url().max(2048),
  institution: z
    .object({ id: z.string().max(100).optional(), name: z.string().min(1).max(255), country: z.string().length(2) })
    .optional(),
  psuType: z.enum(['business', 'personal']).optional(),
});

const completeSchema = z.object({
  provider: z.string().min(1).max(30),
  /** What the client launcher returned (Plaid public_token, Stripe FC session id, redirect code). */
  payload: z.record(z.unknown()),
  connectionId: z.string().max(30).optional(),
});

const mapAccountsSchema = z.object({
  mappings: z
    .array(
      z.object({
        feedAccountId: z.string().min(1).max(255),
        bankAccountId: z.string().max(30).optional(),
        create: z
          .object({
            name: z.string().min(1).max(255),
            accountType: z.enum(accountTypes).optional(),
            ledgerAccountId: z.string().max(30).optional(),
          })
          .optional(),
        /** Feed transactions before this date are skipped (a file import covers them). */
        syncFrom: dateOnly.nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
  syncFrom: dateOnly.nullable().optional(),
  /** Start the first sync right away (default true). */
  sync: z.boolean().optional(),
});

function failure(c: AppContext, raw: unknown, fallback: string) {
  const err = translateProviderError(raw) ?? raw;
  if (err instanceof FeedServiceError) {
    switch (err.code) {
      case 'not_found':
        return c.json({ error: { code: 'NOT_FOUND', message: err.message } }, 404);
      case 'bad_request':
        return error.badRequest(c, err.message);
      case 'conflict':
        return error.conflict(c, err.message);
      case 'unavailable':
        return error.unavailable(c, err.message);
      default:
        return error.badGateway(c, err.message);
    }
  }
  console.error(`[books-api/bank-connections] ${fallback}:`, err);
  return error.internal(c, fallback);
}

/** Event payload: identifiers and status only, never tokens, account numbers or transaction data. */
function eventData(view: ConnectionView): Record<string, unknown> {
  return {
    id: view.id,
    entityId: view.entityId,
    provider: view.provider,
    institutionName: view.institutionName,
    status: view.status,
    accountCount: view.accounts.length,
  };
}

// GET / — connections of the resolved entity
app.get('/', requirePermission('banking:read'), async (c) => {
  try {
    const entityId = await resolveEntityId(c, c.get('tenantDb'));
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const views = await listConnectionViews(createFeedContext(c), entityId);
    return list(c, views, cursorPagination(views.length, false, null));
  } catch (err) {
    return failure(c, err, 'Failed to list bank connections');
  }
});

// GET /providers?country=US — what the connect button can offer
app.get('/providers', requirePermission('banking:read'), async (c) => {
  try {
    let country = c.req.query('country')?.toUpperCase();
    if (!country) {
      const entityId = await resolveEntityId(c, c.get('tenantDb'));
      if (entityId) {
        const [entity] = await c
          .get('tenantDb')
          .select({ jurisdictionCode: schema.entities.jurisdictionCode })
          .from(schema.entities)
          .where(eq(schema.entities.id, entityId))
          .limit(1);
        country = entity?.jurisdictionCode?.toUpperCase();
      }
    }
    country ??= 'US';
    const providers = enabledProviders(country, feedProviders(c.env).config).map((p) => ({
      id: p.id,
      kind: p.id === 'plaid' ? 'plaid_link' : p.id === 'stripe_fc' ? 'stripe_fc' : 'redirect',
      requiresInstitution: p.id === 'enable_banking',
      capabilities: p.capabilities,
    }));
    return success(c, { country, providers });
  } catch (err) {
    return failure(c, err, 'Failed to list providers');
  }
});

// GET /institutions?provider=enable_banking&country=NL
app.get('/institutions', requirePermission('banking:read'), async (c) => {
  try {
    const providerId = c.req.query('provider');
    const country = c.req.query('country');
    if (!providerId || !country) return error.badRequest(c, 'provider and country are required');
    const provider = feedProviders(c.env).get(providerId);
    if (!provider.listInstitutions) return error.badRequest(c, `Provider '${providerId}' has no institution list`);
    const institutions = await provider.listInstitutions(country);
    return list(c, institutions, cursorPagination(institutions.length, false, null));
  } catch (err) {
    return failure(c, err, 'Failed to list institutions');
  }
});

// POST /link-session
app.post('/link-session', requirePermission('banking:create'), zValidator('json', linkSessionSchema), async (c) => {
  const body = c.req.valid('json');
  try {
    const session = await createLinkSession(createFeedContext(c), {
      providerId: body.provider,
      mode: body.mode,
      connectionId: body.connectionId,
      workspaceId: c.get('workspaceId'),
      redirectUrl: body.redirectUrl,
      institution: body.institution,
      psuType: body.psuType,
    });
    return success(c, session, 201);
  } catch (err) {
    return failure(c, err, 'Failed to start the bank link');
  }
});

// POST /complete
app.post('/complete', requirePermission('banking:create'), zValidator('json', completeSchema), async (c) => {
  const body = c.req.valid('json');
  try {
    const entityId = await resolveEntityId(c, c.get('tenantDb'));
    if (!entityId) return error.badRequest(c, 'No accounting entity resolved');
    const { view, created } = await completeLink(createFeedContext(c), {
      providerId: body.provider,
      payload: body.payload,
      connectionId: body.connectionId,
      entityId,
      userId: c.get('userId') ?? null,
    });
    publishEntityEvent({
      c,
      entityType: 'bank_connection',
      entityId: view.id,
      action: created ? 'created' : 'updated',
      data: eventData(view),
    });
    return success(c, { connection: view, accounts: view.accounts }, created ? 201 : 200);
  } catch (err) {
    return failure(c, err, 'Failed to complete the bank link');
  }
});

// POST /:id/map-accounts
app.post('/:id/map-accounts', requirePermission('banking:update'), zValidator('json', mapAccountsSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');
  try {
    const entityId = await resolveEntityId(c, c.get('tenantDb'));
    const ctx = createFeedContext(c);
    const result = await mapAccounts(ctx, id, body, entityId);
    publishEntityEvent({ c, entityType: 'bank_connection', entityId: id, action: 'updated', data: eventData(result.view) });

    let syncStarted = false;
    if (result.needsSync && body.sync !== false) {
      syncStarted = true;
      c.executionCtx.waitUntil(
        syncConnection(ctx, id).catch((err) => console.error('[books-api/bank-connections] first sync failed:', err)),
      );
    }
    return success(c, { connection: result.view, mapped: result.mapped, syncStarted });
  } catch (err) {
    return failure(c, err, 'Failed to map the accounts');
  }
});

// POST /:id/sync — on demand; { refresh: true } asks the provider to fetch fresh data first
app.post('/:id/sync', requirePermission('banking:update'), async (c) => {
  const id = c.req.param('id');
  try {
    const body = (await c.req.json().catch(() => ({}))) as { refresh?: unknown };
    const entityId = await resolveEntityId(c, c.get('tenantDb'));
    const ctx = createFeedContext(c);
    await requireConnection(ctx.db, id, entityId);
    const outcome = await syncConnection(ctx, id, { refresh: body.refresh === true });
    const view = await connectionViewById(ctx, id);
    if (!outcome.skipped && !outcome.error) {
      publishEntityEvent({ c, entityType: 'bank_connection', entityId: id, action: 'synced', data: { ...eventData(view), added: outcome.added, updated: outcome.updated, removed: outcome.removed } });
    }
    return success(c, { outcome, connection: view });
  } catch (err) {
    return failure(c, err, 'Failed to sync the bank connection');
  }
});

// POST /:id/disconnect
app.post('/:id/disconnect', requirePermission('banking:manage'), async (c) => {
  const id = c.req.param('id');
  try {
    const entityId = await resolveEntityId(c, c.get('tenantDb'));
    const view = await disconnectConnection(createFeedContext(c), id, entityId);
    publishEntityEvent({ c, entityType: 'bank_connection', entityId: id, action: 'updated', data: eventData(view) });
    return success(c, view);
  } catch (err) {
    return failure(c, err, 'Failed to disconnect the bank connection');
  }
});

// DELETE /:id — disconnect and remove; synced transactions stay on their bank accounts
app.delete('/:id', requirePermission('banking:manage'), async (c) => {
  const id = c.req.param('id');
  try {
    const entityId = await resolveEntityId(c, c.get('tenantDb'));
    const removed = await deleteConnection(createFeedContext(c), id, entityId);
    publishEntityEvent({
      c,
      entityType: 'bank_connection',
      entityId: id,
      action: 'deleted',
      data: { id, entityId: removed.entityId, provider: removed.provider, institutionName: removed.institutionName },
    });
    return noContent(c);
  } catch (err) {
    return failure(c, err, 'Failed to delete the bank connection');
  }
});

// GET /:id/pending
app.get('/:id/pending', requirePermission('banking:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const entityId = await resolveEntityId(c, c.get('tenantDb'));
    await requireConnection(c.get('tenantDb'), id, entityId);
    const rows = await listPendingTransactions(c.get('tenantDb'), id, c.req.query('bankAccountId'));
    return list(c, rows, cursorPagination(rows.length, false, null));
  } catch (err) {
    return failure(c, err, 'Failed to list pending transactions');
  }
});

// GET /:id
app.get('/:id', requirePermission('banking:read'), async (c) => {
  const id = c.req.param('id');
  try {
    const entityId = await resolveEntityId(c, c.get('tenantDb'));
    await requireConnection(c.get('tenantDb'), id, entityId);
    return success(c, await connectionViewById(createFeedContext(c), id));
  } catch (err) {
    return failure(c, err, 'Failed to fetch the bank connection');
  }
});

export const bankConnectionsRoutes = app;
