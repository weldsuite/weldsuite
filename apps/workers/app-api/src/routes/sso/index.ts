/**
 * Enterprise single sign-on — /api/sso (services/sso.ts).
 *
 *   GET    /                        the configuration (domain, connection, entitlement)
 *   PUT    /domain                  claim a domain                      sso:manage
 *   DELETE /domain                                                      sso:manage
 *   POST   /domain/verify           check the TXT record                sso:manage
 *   PUT    /connection              create/update the Clerk connection  sso:manage
 *   DELETE /connection                                                  sso:manage
 *   POST   /connection/activate     switch SSO on                       sso:manage
 *   POST   /connection/deactivate                                       sso:manage
 *   GET    /billing                 the add-on, priced for the workspace
 *   POST   /billing/subscribe       start the add-on                    billing:manage
 *   POST   /billing/cancel          end it at period end                billing:manage
 *   POST   /billing/resume          undo the cancel                     billing:manage
 *
 * Reads take `sso:read`. The `/billing` paths are forwarded to billing-worker
 * (`/api/billing/sso/*`, which owns the Stripe subscription) with the caller's
 * Clerk JWT. Every configuration write answers with the configuration after it.
 *
 * State is master-DB only (`workspace_sso`) plus Clerk. Every configuration
 * change publishes `workspace_settings.updated` with `field: 'sso'`, what
 * changed, the domain, the provider and whether SSO is switched on, so it
 * reaches the workspace's audit log. IdP details (metadata, certificate,
 * entity id, URLs) never go on the event bus.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createClerkClient } from '@clerk/backend';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { success } from '@weldsuite/worker-kit/response';
import { lookupTxt } from '@weldsuite/worker-kit/dns-lookup';
import { callBillingWorker } from '@weldsuite/worker-kit/billing-worker';
import {
  ssoConnectionInputSchema,
  ssoDomainInputSchema,
  type SsoConfigView,
} from '@weldsuite/app-api-client/schemas/sso';
import type { SsoClerkClient, SsoContext } from '@weldsuite/core-domain/sso';
import type { Env, Variables } from '../../types';
import {
  SsoError,
  buildSsoView,
  loadContext,
  removeSsoConnection,
  removeSsoDomain,
  saveSsoConnection,
  setSsoDomain,
  setSsoEnabled,
  verifySsoDomain,
} from '../../services/sso';

type AppEnv = { Bindings: Env; Variables: Variables };
type AppContext = Context<AppEnv>;

const app = new Hono<AppEnv>();

const canRead = requirePermission('sso:read');
const canManage = requirePermission('sso:manage');
/** Starting or ending the paid add-on spends money: the billing write grant, as for plans. */
const canManageBilling = requirePermission('billing:manage');

function clerkOf(c: AppContext): SsoClerkClient {
  return createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });
}

function orgIdOf(c: AppContext): string {
  return c.get('workspaceId');
}

function fail(c: AppContext, err: unknown) {
  if (err instanceof SsoError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  throw err;
}

async function currentView(c: AppContext): Promise<{ ctx: SsoContext; view: SsoConfigView }> {
  const ctx = await loadContext(getMasterDb(c.env), orgIdOf(c));
  return { ctx, view: await buildSsoView(clerkOf(c), ctx, await hasContextPermission(c, 'sso:manage')) };
}

/** What a configuration write changed, for the audit trail. */
type SsoChange =
  | 'domain_claimed'
  | 'domain_removed'
  | 'domain_verified'
  | 'connection_saved'
  | 'connection_removed'
  | 'enabled'
  | 'disabled';

/** Load, change, record it, answer with the configuration after the change. */
async function change(c: AppContext, kind: SsoChange, run: (ctx: SsoContext, actor: string) => Promise<void>) {
  try {
    const before = await loadContext(getMasterDb(c.env), orgIdOf(c));
    await run(before, c.get('userId'));
    const { ctx, view } = await currentView(c);
    publishEntityEvent({
      c,
      entityType: 'workspace_settings',
      entityId: ctx.workspace.id,
      action: 'updated',
      data: {
        id: ctx.workspace.id,
        field: 'sso',
        change: kind,
        domain: view.domain?.name ?? null,
        domainVerified: view.domain?.verified ?? false,
        provider: view.connection?.provider ?? null,
        enabled: view.connection?.enabled ?? false,
      },
    });
    return success(c, view);
  } catch (err) {
    return fail(c, err);
  }
}

app.get('/', canRead, async (c) => {
  try {
    return success(c, (await currentView(c)).view);
  } catch (err) {
    return fail(c, err);
  }
});

app.put('/domain', canManage, zValidator('json', ssoDomainInputSchema), (c) =>
  change(c, 'domain_claimed', (ctx, actor) => setSsoDomain(getMasterDb(c.env), ctx, c.req.valid('json').domain, actor)),
);

app.delete('/domain', canManage, (c) =>
  change(c, 'domain_removed', (ctx, actor) => removeSsoDomain(getMasterDb(c.env), ctx, actor)),
);

app.post('/domain/verify', canManage, (c) =>
  change(c, 'domain_verified', (ctx, actor) => verifySsoDomain(getMasterDb(c.env), ctx, lookupTxt, actor)),
);

app.put('/connection', canManage, zValidator('json', ssoConnectionInputSchema), (c) =>
  change(c, 'connection_saved', (ctx, actor) =>
    saveSsoConnection(getMasterDb(c.env), clerkOf(c), ctx, c.req.valid('json'), actor),
  ),
);

app.delete('/connection', canManage, (c) =>
  change(c, 'connection_removed', (ctx, actor) => removeSsoConnection(getMasterDb(c.env), clerkOf(c), ctx, actor)),
);

app.post('/connection/activate', canManage, (c) =>
  change(c, 'enabled', (ctx, actor) => setSsoEnabled(getMasterDb(c.env), clerkOf(c), ctx, true, actor)),
);

app.post('/connection/deactivate', canManage, (c) =>
  change(c, 'disabled', (ctx, actor) => setSsoEnabled(getMasterDb(c.env), clerkOf(c), ctx, false, actor)),
);

// ============================================================================
// Add-on billing (billing-worker)
// ============================================================================

/** Pass billing-worker's answer through; it already speaks the `{ data }` / `{ error }` envelope. */
async function forward(c: AppContext, method: 'GET' | 'POST', path: string) {
  let resp: Response;
  try {
    resp = await callBillingWorker(c, `/api/billing/sso${path}`, { method, body: method === 'POST' ? {} : undefined });
  } catch (err) {
    console.error(`[SSO] billing-worker ${method} ${path} failed:`, err);
    return c.json({ error: { code: 'BILLING_UNAVAILABLE', message: 'Billing is unavailable right now. Try again later.' } }, 502);
  }
  const payload = await resp.json().catch(() => null);
  if (payload && typeof payload === 'object' && ('data' in payload || 'error' in payload)) {
    return c.json(payload, resp.status as 200);
  }
  return c.json({ error: { code: 'BILLING_UNAVAILABLE', message: 'Billing is unavailable right now. Try again later.' } }, 502);
}

app.get('/billing', canRead, (c) => forward(c, 'GET', '/status'));
app.post('/billing/subscribe', canManageBilling, (c) => forward(c, 'POST', '/subscribe'));
app.post('/billing/cancel', canManageBilling, (c) => forward(c, 'POST', '/cancel'));
app.post('/billing/resume', canManageBilling, (c) => forward(c, 'POST', '/resume'));

export { app as ssoRoutes };
