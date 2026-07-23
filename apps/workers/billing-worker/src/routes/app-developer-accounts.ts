/**
 * WeldApps Marketplace — Developer Payout Accounts (Stripe Connect)
 *
 * One `appDeveloperAccounts` row per authoring workspace. A workspace admin
 * onboards via a Stripe Connect Express account; once onboarding completes
 * (`account.updated` webhook, charges_enabled && payouts_enabled) the
 * workspace can receive destination-charge payouts on its paid apps'
 * subscriptions, minus each app's `platformFeePercent`.
 */

import { Hono, type Context } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env } from '../index';
import { clerkJwtAuth, requireOrgAdmin } from '../middleware/auth';
import { getMasterDb, masterSchema } from '../lib/db';
import { generateId } from '../lib/id';
import { createConnectExpressAccount, createConnectAccountLink } from '../lib/stripe';

const { workspaces, appDeveloperAccounts } = masterSchema;

type DeveloperAccountsEnv = {
  Bindings: Env;
  Variables: { userId: string; orgId: string | null; orgRole: string | null };
};

export const appDeveloperAccountsRoutes = new Hono<DeveloperAccountsEnv>();

appDeveloperAccountsRoutes.use('*', clerkJwtAuth());

function billingNotConfigured(c: Context<DeveloperAccountsEnv>) {
  return c.json(
    { error: { code: 'BILLING_NOT_CONFIGURED', message: 'Billing is not configured for this environment.' } },
    503,
  );
}

/**
 * Resolve the caller's own workspace via their Clerk org and require it to
 * match `workspaceId` — a workspace can only manage its own payout account.
 */
async function resolveOwnWorkspace(
  masterDb: ReturnType<typeof getMasterDb>,
  orgId: string,
  workspaceId: string,
) {
  const [workspace] = await masterDb
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, orgId))
    .limit(1);

  if (!workspace || workspace.id !== workspaceId) return null;
  return workspace;
}

// ============================================================================
// POST /onboard — create-or-continue Stripe Connect onboarding
// ============================================================================
// Body: { workspaceId, returnUrl, refreshUrl } → { data: { url } }

appDeveloperAccountsRoutes.post('/onboard', requireOrgAdmin(), async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return billingNotConfigured(c);
  }

  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'NO_ORGANIZATION', message: 'No organization selected.' } }, 400);
  }

  type OnboardBody = { workspaceId?: string; returnUrl?: string; refreshUrl?: string };
  const body: OnboardBody = await c.req.json<OnboardBody>().catch(() => ({}));
  const { workspaceId, returnUrl, refreshUrl } = body;

  if (!workspaceId || !returnUrl || !refreshUrl) {
    return c.json(
      { error: { code: 'INVALID_REQUEST', message: 'workspaceId, returnUrl and refreshUrl are required.' } },
      400,
    );
  }

  const masterDb = getMasterDb(c.env);

  const workspace = await resolveOwnWorkspace(masterDb, orgId, workspaceId);
  if (!workspace) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'workspaceId does not match the authenticated workspace.' } }, 403);
  }

  // Create-or-get the developer account row.
  let [account] = await masterDb
    .select()
    .from(appDeveloperAccounts)
    .where(eq(appDeveloperAccounts.workspaceId, workspaceId))
    .limit(1);

  if (!account) {
    const [created] = await masterDb
      .insert(appDeveloperAccounts)
      .values({
        id: generateId('adev'),
        workspaceId,
      })
      .onConflictDoNothing({ target: appDeveloperAccounts.workspaceId })
      .returning();

    account = created;
    if (!account) {
      // Lost the insert race — read back the row the other request created.
      const [raced] = await masterDb
        .select()
        .from(appDeveloperAccounts)
        .where(eq(appDeveloperAccounts.workspaceId, workspaceId))
        .limit(1);
      if (!raced) throw new Error('Failed to create or find developer account row');
      account = raced;
    }
  }

  // Create the Stripe Connect Express account if it doesn't exist yet.
  let stripeConnectAccountId = account.stripeConnectAccountId;
  if (!stripeConnectAccountId) {
    const connectAccount = await createConnectExpressAccount(c.env.STRIPE_SECRET_KEY, {
      metadata: { workspaceId },
    });
    stripeConnectAccountId = connectAccount.id as string;

    await masterDb
      .update(appDeveloperAccounts)
      .set({ stripeConnectAccountId, updatedAt: new Date() })
      .where(eq(appDeveloperAccounts.id, account.id));
  }

  const accountLink = await createConnectAccountLink(c.env.STRIPE_SECRET_KEY, {
    accountId: stripeConnectAccountId,
    returnUrl,
    refreshUrl,
  });

  return c.json({ data: { url: accountLink.url } });
});

// ============================================================================
// GET /:workspaceId — current developer payout account, or null
// ============================================================================

appDeveloperAccountsRoutes.get('/:workspaceId', requireOrgAdmin(), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'NO_ORGANIZATION', message: 'No organization selected.' } }, 400);
  }

  const workspaceId = c.req.param('workspaceId');
  const masterDb = getMasterDb(c.env);

  const workspace = await resolveOwnWorkspace(masterDb, orgId, workspaceId);
  if (!workspace) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'workspaceId does not match the authenticated workspace.' } }, 403);
  }

  const [account] = await masterDb
    .select()
    .from(appDeveloperAccounts)
    .where(eq(appDeveloperAccounts.workspaceId, workspaceId))
    .limit(1);

  return c.json({ data: account ?? null });
});
