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
 * State is master-DB only (`workspace_sso`) plus Clerk, keyed by the workspace,
 * so there is no tenant entity and no entity event: SSO is not a business
 * record, and the domain and IdP details do not belong on the event bus.
 */

import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createClerkClient } from '@clerk/backend';
import { hasContextPermission, requirePermission } from '@weldsuite/permissions/server';
import { getMasterDb } from '@weldsuite/worker-kit/db';
import { success } from '@weldsuite/worker-kit/response';
import { lookupTxt } from '@weldsuite/worker-kit/dns-lookup';
import { callBillingWorker } from '@weldsuite/worker-kit/billing-worker';
import { ssoConnectionInputSchema, ssoDomainInputSchema } from '@weldsuite/app-api-client/schemas/sso';
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

async function view(c: AppContext) {
  const ctx = await loadContext(getMasterDb(c.env), orgIdOf(c));
  return success(c, await buildSsoView(clerkOf(c), ctx, await hasContextPermission(c, 'sso:manage')));
}

/** Load, change, answer with the configuration after the change. */
async function change(c: AppContext, run: (ctx: SsoContext, actor: string) => Promise<void>) {
  try {
    const ctx = await loadContext(getMasterDb(c.env), orgIdOf(c));
    await run(ctx, c.get('userId'));
    return await view(c);
  } catch (err) {
    return fail(c, err);
  }
}

app.get('/', canRead, async (c) => {
  try {
    return await view(c);
  } catch (err) {
    return fail(c, err);
  }
});

app.put('/domain', canManage, zValidator('json', ssoDomainInputSchema), (c) =>
  change(c, (ctx, actor) => setSsoDomain(getMasterDb(c.env), ctx, c.req.valid('json').domain, actor)),
);

app.delete('/domain', canManage, (c) => change(c, (ctx, actor) => removeSsoDomain(getMasterDb(c.env), ctx, actor)));

app.post('/domain/verify', canManage, (c) =>
  change(c, (ctx, actor) => verifySsoDomain(getMasterDb(c.env), ctx, lookupTxt, actor)),
);

app.put('/connection', canManage, zValidator('json', ssoConnectionInputSchema), (c) =>
  change(c, (ctx, actor) => saveSsoConnection(getMasterDb(c.env), clerkOf(c), ctx, c.req.valid('json'), actor)),
);

app.delete('/connection', canManage, (c) =>
  change(c, (ctx, actor) => removeSsoConnection(getMasterDb(c.env), clerkOf(c), ctx, actor)),
);

app.post('/connection/activate', canManage, (c) =>
  change(c, (ctx, actor) => setSsoEnabled(getMasterDb(c.env), clerkOf(c), ctx, true, actor)),
);

app.post('/connection/deactivate', canManage, (c) =>
  change(c, (ctx, actor) => setSsoEnabled(getMasterDb(c.env), clerkOf(c), ctx, false, actor)),
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
