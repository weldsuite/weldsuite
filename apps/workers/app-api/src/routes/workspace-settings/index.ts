/**
 * Workspace settings routes — /api/workspace-settings/*.
 *
 *   - GET  /                 — read the `workspace_settings` business blob.
 *   - PUT  /                 — upsert it (+ master digest + Stripe mirror).
 *   - PUT  /name             — rename the workspace. Owner OR admin.
 *   - POST /slug             — change the workspace slug. Owner only.
 *   - GET  /deletion-status  — what deletion would destroy. Owner only.
 *   - POST /delete           — delete the workspace. Owner only.
 *
 * GET/PUT `/` are ported from api-worker `GET|PUT /settings/workspace` and
 * carry `general:read` / `general:update` — the same gate the legacy route
 * used. The blob logic lives in ../../services/workspace-settings.ts.
 *
 * The name/slug half is ported from core-api's `routes/settings/workspace-
 * name.ts` + `routes/settings/workspace-slug.ts` (and their services). BOTH
 * sync the change to the Clerk organization. The slug change also rewrites the
 * help-center subdomain (master + tenant DB) and invalidates the
 * WORKSPACE_CACHE KV entry so the next request re-resolves the tenant DB.
 *
 * There is no `POST /` create or `/:id` lifecycle here — this is a singleton
 * settings surface, so the route is registered as EXEMPT in
 * `_event-coverage.test.ts`. Each mutation still publishes a
 * `workspace_settings` entity event.
 *
 * Authorization on name/slug/delete is role-based (OWNER / ADMIN on the tenant
 * membership row), NOT a `requirePermission(<entity>:<action>)` gate — Clerk's
 * `org:admin` role is broader than WeldSuite's OWNER, so these checks read the
 * canonical role from the tenant `workspaceMembers` table.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createClerkClient } from '@clerk/backend';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  updateWorkspaceNameInput,
  updateWorkspaceSlugInput,
  updateWorkspaceSettingsInput,
  deleteWorkspaceInput,
} from '@weldsuite/app-api-client/schemas/workspace-settings';
import type { WorkspaceDeletionStatus } from '@weldsuite/app-api-client/schemas/workspace-settings';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import { cancelSubscriptionImmediately } from '../../lib/stripe';
import { getMasterDb, masterSchema, schema, type Database, type MasterDatabase } from '../../db';
import * as settingsService from '../../services/workspace-settings';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const HELPCENTER_DOMAIN_SUFFIX = '.welddesk.org';

// ============================================================================
// Errors (ported from core-api services)
// ============================================================================

class WorkspaceNotFoundError extends Error {
  constructor() {
    super('Workspace not found');
    this.name = 'WorkspaceNotFoundError';
  }
}

class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`Slug '${slug}' is already taken`);
    this.name = 'SlugTakenError';
  }
}

class SlugUnchangedError extends Error {
  constructor() {
    super('New slug is identical to the current slug');
    this.name = 'SlugUnchangedError';
  }
}

class ClerkSyncError extends Error {
  constructor(
    public clerkStatus: number,
    public details: unknown,
    public reasonCode: 'taken' | 'format' | 'unknown' = 'unknown',
  ) {
    super(`Failed to sync organization (status ${clerkStatus})`);
    this.name = 'ClerkSyncError';
  }
}

// ============================================================================
// Service logic (ported from core-api/src/services/workspace-name.ts +
// workspace-slug.ts). Pure functions — no Hono context.
// ============================================================================

interface UpdateWorkspaceNameParams {
  masterDb: MasterDatabase;
  clerkOrgId: string;
  newName: string;
  clerkSecretKey: string;
}

async function updateWorkspaceName({
  masterDb,
  clerkOrgId,
  newName,
  clerkSecretKey,
}: UpdateWorkspaceNameParams): Promise<{ id: string; name: string }> {
  const [workspace] = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      name: masterSchema.workspaces.name,
    })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.clerkOrgId, clerkOrgId))
    .limit(1);

  if (!workspace) throw new WorkspaceNotFoundError();
  const previousName = workspace.name;

  if (previousName === newName) {
    return { id: workspace.id, name: previousName };
  }

  await masterDb
    .update(masterSchema.workspaces)
    .set({ name: newName, updatedAt: new Date() })
    .where(eq(masterSchema.workspaces.id, workspace.id));

  try {
    const resp = await fetch(`https://api.clerk.com/v1/organizations/${clerkOrgId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${clerkSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: newName }),
    });

    if (!resp.ok) {
      const details = await resp.json().catch(() => ({}));
      throw new ClerkSyncError(resp.status, details);
    }
  } catch (err) {
    // Compensating write — restore the previous name.
    await masterDb
      .update(masterSchema.workspaces)
      .set({ name: previousName, updatedAt: new Date() })
      .where(eq(masterSchema.workspaces.id, workspace.id));
    throw err;
  }

  return { id: workspace.id, name: newName };
}

interface UpdateWorkspaceSlugParams {
  masterDb: MasterDatabase;
  tenantDb: Database;
  clerkOrgId: string;
  newSlug: string;
  clerkSecretKey: string;
}

async function updateWorkspaceSlug({
  masterDb,
  tenantDb,
  clerkOrgId,
  newSlug,
  clerkSecretKey,
}: UpdateWorkspaceSlugParams): Promise<{ id: string; slug: string; previousSlug: string }> {
  // 1) Fetch current workspace.
  const [workspace] = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      slug: masterSchema.workspaces.slug,
    })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.clerkOrgId, clerkOrgId))
    .limit(1);

  if (!workspace) throw new WorkspaceNotFoundError();
  const previousSlug = workspace.slug;

  if (previousSlug === newSlug) throw new SlugUnchangedError();

  // 2) Uniqueness check — fast-fail before we mutate anything.
  const [conflict] = await masterDb
    .select({ id: masterSchema.workspaces.id })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.slug, newSlug))
    .limit(1);

  if (conflict) throw new SlugTakenError(newSlug);

  const oldHelpcenterDomain = `${previousSlug}${HELPCENTER_DOMAIN_SUFFIX}`;
  const newHelpcenterDomain = `${newSlug}${HELPCENTER_DOMAIN_SUFFIX}`;

  // 3) Update workspaces.slug.
  await masterDb
    .update(masterSchema.workspaces)
    .set({ slug: newSlug, updatedAt: new Date() })
    .where(eq(masterSchema.workspaces.id, workspace.id));

  // 4) Update helpcenter_domain_registry rows scoped to this workspace whose
  //    domain still matches the old `{slug}.welddesk.org` shape. Custom domains
  //    and rows already on the new slug are left untouched.
  await masterDb
    .update(masterSchema.helpcenterDomainRegistry)
    .set({ domain: newHelpcenterDomain, updatedAt: new Date() })
    .where(
      and(
        eq(masterSchema.helpcenterDomainRegistry.workspaceId, workspace.id),
        eq(masterSchema.helpcenterDomainRegistry.domain, oldHelpcenterDomain),
      ),
    );

  // 5) Update tenant DB helpcenter_settings.defaultSubdomain.
  await tenantDb
    .update(schema.helpcenterSettings)
    .set({ defaultSubdomain: newHelpcenterDomain, updatedAt: new Date() })
    .where(eq(schema.helpcenterSettings.defaultSubdomain, oldHelpcenterDomain));

  // 6) Sync Clerk org slug. If this fails, roll back the DB writes above.
  try {
    const resp = await fetch(`https://api.clerk.com/v1/organizations/${clerkOrgId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${clerkSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ slug: newSlug }),
    });

    if (!resp.ok) {
      const details = (await resp.json().catch(() => ({}))) as {
        errors?: Array<{ code?: string; meta?: { param_name?: string } }>;
      };
      const code = details?.errors?.[0]?.code ?? '';
      const reasonCode: 'taken' | 'format' | 'unknown' =
        code.includes('exists') || code.includes('unique') || code.includes('taken')
          ? 'taken'
          : code.includes('format') || code.includes('invalid')
            ? 'format'
            : 'unknown';
      throw new ClerkSyncError(resp.status, details, reasonCode);
    }
  } catch (err) {
    // Compensating writes — restore to previous state.
    await masterDb
      .update(masterSchema.workspaces)
      .set({ slug: previousSlug, updatedAt: new Date() })
      .where(eq(masterSchema.workspaces.id, workspace.id));

    await masterDb
      .update(masterSchema.helpcenterDomainRegistry)
      .set({ domain: oldHelpcenterDomain, updatedAt: new Date() })
      .where(
        and(
          eq(masterSchema.helpcenterDomainRegistry.workspaceId, workspace.id),
          eq(masterSchema.helpcenterDomainRegistry.domain, newHelpcenterDomain),
        ),
      );

    await tenantDb
      .update(schema.helpcenterSettings)
      .set({ defaultSubdomain: oldHelpcenterDomain, updatedAt: new Date() })
      .where(eq(schema.helpcenterSettings.defaultSubdomain, newHelpcenterDomain));

    throw err;
  }

  return { id: workspace.id, slug: newSlug, previousSlug };
}

// ============================================================================
// Routes — workspace settings blob (the `workspace_settings` business record)
// ============================================================================

/**
 * GET / — read the singleton `workspace_settings` row. `null` when the tenant
 * has never saved one (the legacy route answered the same way, and the
 * business-settings form relies on it to fall back to its defaults).
 *
 * `general:read` matches the legacy gate — MEMBER and VIEWER both carry it, so
 * the workspace timezone/language defaults stay readable by everyone (the
 * PreferencesSync component reads this on every app boot).
 */
app.get('/', requirePermission('general:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const row = await settingsService.getWorkspaceSettings(c.get('tenantDb'));
    return success(c, row);
  } catch (err) {
    console.error('[app-api/workspace-settings] get blob failed:', err);
    return error.internal(c, 'Failed to fetch workspace settings');
  }
});

/**
 * PUT / — upsert the settings blob, then mirror to master + Stripe.
 *
 * `general:update` matches the legacy gate (ADMIN + OWNER).
 *
 * The mirror runs AFTER the tenant write and is fully best-effort, so a Stripe
 * or master-DB hiccup degrades to "settings saved, invoice address stale"
 * rather than losing the write.
 */
app.put('/', requirePermission('general:update'), zValidator('json', updateWorkspaceSettingsInput), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const data = c.req.valid('json');

  try {
    const { row, created } = await settingsService.upsertWorkspaceSettings(c.get('tenantDb'), data);

    if (settingsService.touchesBillingMirror(data)) {
      await settingsService.syncBillingMirror({
        masterDb: getMasterDb(c.env),
        clerkOrgId: orgId,
        data,
        stripeSecretKey: c.env.STRIPE_SECRET_KEY,
      });
    }

    // The events catalog defines `workspace_settings: ['updated', 'deleted']` —
    // there is no `created` action, so the insert branch also emits `updated`
    // (the legacy route emitted `created`, which this catalog cannot express).
    publishEntityEvent({
      c,
      entityType: 'workspace_settings',
      entityId: row.id,
      action: 'updated',
      data: row as unknown as Record<string, unknown>,
    });

    return success(c, row, created ? 201 : 200);
  } catch (err) {
    console.error('[app-api/workspace-settings] update blob failed:', err);
    return error.internal(c, 'Failed to update workspace settings');
  }
});

// ============================================================================
// Routes — name / slug
// ============================================================================

/**
 * PUT /name — rename the workspace. Owner OR admin. Mirrored to Clerk.
 */
app.put('/name', zValidator('json', updateWorkspaceNameInput), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const tenantDb = c.get('tenantDb');
  if (!orgId) return error.orgRequired(c);

  const { name } = c.req.valid('json');

  const [membership] = await tenantDb
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.userId, userId),
        isNull(schema.workspaceMembers.deletedAt),
      ),
    )
    .limit(1);

  if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
    return error.forbidden(c, 'Only the workspace owner or an admin can rename the workspace.');
  }

  try {
    const result = await updateWorkspaceName({
      masterDb: getMasterDb(c.env),
      clerkOrgId: orgId,
      newName: name,
      clerkSecretKey: c.env.CLERK_SECRET_KEY,
    });

    // Invalidate the workspace cache — the next request re-resolves the
    // workspace metadata and picks up the new name.
    await c.env.WORKSPACE_CACHE.delete(`ws:${orgId}`).catch(() => {});

    publishEntityEvent({
      c,
      entityType: 'workspace_settings',
      entityId: result.id,
      action: 'updated',
      data: { id: result.id, field: 'name', name: result.name },
    });

    return success(c, result);
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) {
      return error.notFound(c, 'Workspace');
    }
    if (err instanceof ClerkSyncError) {
      console.error('[app-api/workspace-settings] name sync failed:', err.clerkStatus, err.details);
      return error.conflict(c, 'That name could not be used. Please try a different value.');
    }
    console.error('[app-api/workspace-settings] updateWorkspaceName failed:', err);
    return error.internal(c, 'Failed to update workspace name');
  }
});

/**
 * POST /slug — change the workspace slug. Owner only. Mirrored to Clerk and
 * the help-center subdomain; invalidates the WORKSPACE_CACHE KV entry.
 */
app.post('/slug', zValidator('json', updateWorkspaceSlugInput), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const tenantDb = c.get('tenantDb');
  if (!orgId) return error.orgRequired(c);

  const { slug } = c.req.valid('json');

  // Owner-only: Clerk's `org:admin` role is broader than WeldSuite's OWNER, so
  // read the canonical role from the tenant membership row.
  const [membership] = await tenantDb
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.userId, userId),
        isNull(schema.workspaceMembers.deletedAt),
      ),
    )
    .limit(1);

  if (!membership || membership.role !== 'OWNER') {
    return error.forbidden(c, 'Only the workspace owner can change the workspace slug.');
  }

  try {
    const result = await updateWorkspaceSlug({
      masterDb: getMasterDb(c.env),
      tenantDb,
      clerkOrgId: orgId,
      newSlug: slug,
      clerkSecretKey: c.env.CLERK_SECRET_KEY,
    });

    // Invalidate the workspace cache — the next request will re-resolve the
    // tenant DB connection and pick up the new slug.
    await c.env.WORKSPACE_CACHE.delete(`ws:${orgId}`).catch(() => {});

    publishEntityEvent({
      c,
      entityType: 'workspace_settings',
      entityId: result.id,
      action: 'updated',
      data: { id: result.id, field: 'slug', slug: result.slug, previousSlug: result.previousSlug },
    });

    return success(c, result);
  } catch (err) {
    if (err instanceof SlugTakenError) {
      return error.conflict(c, err.message);
    }
    if (err instanceof SlugUnchangedError) {
      return error.badRequest(c, err.message);
    }
    if (err instanceof WorkspaceNotFoundError) {
      return error.notFound(c, 'Workspace');
    }
    if (err instanceof ClerkSyncError) {
      console.error('[app-api/workspace-settings] slug sync failed:', err.clerkStatus, err.details);
      const message =
        err.reasonCode === 'taken'
          ? 'That slug is already in use. Please try a different value.'
          : err.reasonCode === 'format'
            ? 'That slug is not in a valid format. Use lowercase letters, numbers, and hyphens.'
            : 'That slug could not be used. Please try a different value.';
      return error.conflict(c, message);
    }
    console.error('[app-api/workspace-settings] updateWorkspaceSlug failed:', err);
    return error.internal(c, 'Failed to update workspace slug');
  }
});

// ============================================================================
// Workspace deletion — owner-only, irreversible.
// ============================================================================

/** Resolve the caller's canonical (tenant) role for the active workspace. */
async function getCallerRole(tenantDb: Database, userId: string): Promise<string | null> {
  const [membership] = await tenantDb
    .select({ role: schema.workspaceMembers.role })
    .from(schema.workspaceMembers)
    .where(
      and(
        eq(schema.workspaceMembers.userId, userId),
        isNull(schema.workspaceMembers.deletedAt),
      ),
    )
    .limit(1);
  return membership?.role ?? null;
}

/**
 * GET /deletion-status — what deleting the active workspace would destroy.
 * Owner-only: the destructive surface is never revealed to non-owners.
 */
app.get('/deletion-status', async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const tenantDb = c.get('tenantDb');
  if (!orgId) return error.orgRequired(c);

  const role = await getCallerRole(tenantDb, userId);
  if (role !== 'OWNER') {
    return error.forbidden(c, 'Only the workspace owner can delete the workspace.');
  }

  try {
    const [workspace] = await getMasterDb(c.env)
      .select({
        id: masterSchema.workspaces.id,
        name: masterSchema.workspaces.name,
        slug: masterSchema.workspaces.slug,
        stripeSubscriptionId: masterSchema.workspaces.stripeSubscriptionId,
      })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
      .limit(1);

    if (!workspace) return error.notFound(c, 'Workspace');

    const [{ count }] = await tenantDb
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.status, 'ACTIVE'),
          isNull(schema.workspaceMembers.deletedAt),
        ),
      );

    const status: WorkspaceDeletionStatus = {
      workspaceId: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      memberCount: count,
      hasActiveSubscription: !!workspace.stripeSubscriptionId,
    };
    return success(c, status);
  } catch (err) {
    console.error('[app-api/workspace-settings] deletion-status failed:', err);
    return error.internal(c, 'Failed to compute workspace deletion status');
  }
});

/**
 * POST /delete — permanently delete the active workspace. Owner-only.
 *
 * The caller confirms by typing the workspace slug. Any active Stripe
 * subscription is cancelled first (best-effort). Deleting the Clerk org fires
 * the `organization.deleted` webhook, which soft-deletes the workspace and
 * tears down its Neon database; the direct master cleanup below covers a
 * delayed or dropped webhook.
 */
app.post('/delete', zValidator('json', deleteWorkspaceInput), async (c) => {
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  const tenantDb = c.get('tenantDb');
  if (!orgId) return error.orgRequired(c);

  const { confirmation } = c.req.valid('json');
  const masterDb = getMasterDb(c.env);

  const role = await getCallerRole(tenantDb, userId);
  if (role !== 'OWNER') {
    return error.forbidden(c, 'Only the workspace owner can delete the workspace.');
  }

  try {
    const [workspace] = await masterDb
      .select({
        id: masterSchema.workspaces.id,
        slug: masterSchema.workspaces.slug,
        stripeSubscriptionId: masterSchema.workspaces.stripeSubscriptionId,
      })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
      .limit(1);

    if (!workspace) return error.notFound(c, 'Workspace');

    if (confirmation !== workspace.slug) {
      return error.badRequest(c, 'Confirmation does not match the workspace identifier.');
    }

    // 1) Cancel any active Stripe subscription first so the owner isn't billed
    //    for a workspace that no longer exists. Best-effort: a Stripe hiccup
    //    must not permanently block deletion (billing reconciliation catches
    //    the rare orphan).
    if (workspace.stripeSubscriptionId && c.env.STRIPE_SECRET_KEY) {
      try {
        await cancelSubscriptionImmediately(c.env.STRIPE_SECRET_KEY, workspace.stripeSubscriptionId);
      } catch (err) {
        console.error(
          `[app-api/workspace-settings] Failed to cancel Stripe subscription ${workspace.stripeSubscriptionId} for workspace ${workspace.id}:`,
          err,
        );
      }
    }

    // 2) Delete the Clerk org — fires the organization.deleted webhook
    //    (workspace soft-delete + userWorkspaces removal + Neon teardown).
    const clerk = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });
    try {
      await clerk.organizations.deleteOrganization(orgId);
    } catch (err) {
      console.error(
        `[app-api/workspace-settings] Failed to delete Clerk org ${orgId} for workspace ${workspace.id}:`,
        err,
      );
      return error.internal(c, 'Failed to delete workspace. Please try again.');
    }

    // 3) Direct master cleanup — the account is unusable even before the
    //    webhook lands. Idempotent with the webhook's own writes.
    await masterDb
      .update(masterSchema.workspaces)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(masterSchema.workspaces.id, workspace.id));

    await masterDb
      .delete(masterSchema.userWorkspaces)
      .where(eq(masterSchema.userWorkspaces.workspaceId, workspace.id));

    // 4) Invalidate the workspace cache so the next request re-resolves.
    await c.env.WORKSPACE_CACHE.delete(`ws:${orgId}`).catch(() => {});

    publishEntityEvent({
      c,
      entityType: 'workspace_settings',
      entityId: workspace.id,
      action: 'deleted',
      data: { id: workspace.id, slug: workspace.slug },
    });

    return success(c, { deleted: true });
  } catch (err) {
    console.error('[app-api/workspace-settings] deleteWorkspace failed:', err);
    return error.internal(c, 'Failed to delete workspace');
  }
});

export const workspaceSettingsRoutes = app;
