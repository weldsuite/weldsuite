/**
 * POST /api/onboard
 *
 * Main onboarding endpoint. Called to:
 * 1. Create Clerk organization
 * 2. Upsert workspace row
 * 3. Provision database (idempotent)
 * 4. Set up Stripe billing
 *
 * Two entry paths share the same core logic (`runOnboard`):
 *  - The public HTTP route below, guarded by Clerk M2M auth (`m2mAuth`).
 *  - The RPC entrypoint (`WorkspaceOnboardEntrypoint` in ../index.ts), invoked
 *    by trusted in-network callers over a Cloudflare service binding. RPC
 *    methods are never exposed on the public HTTP interface, so that path is
 *    trusted by topology and needs no M2M token.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull } from 'drizzle-orm';
import type { Env } from '../index';
import { getMasterDb } from '../db';
import { generateId } from '../lib/id';
import { provisionWorkspaceDatabase } from '../services/provisioning';
import { provisionMailDomain } from '../services/mail-provisioning';
import { workspaces, plans } from '@weldsuite/db/schema/master';
import { m2mAuth } from '../middleware/m2m-auth';
import { syncClerkSeatLimit } from '../lib/clerk';

export const onboardSchema = z.object({
  clerkUserId: z.string().min(1),
  workspaceName: z.string().min(1),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  region: z.string().optional(),
  organizationType: z.string().optional(),
  organizationSize: z.string().optional(),
  referralSource: z.string().optional(),
  country: z.string().optional(),
  selectedApps: z.array(z.string()).optional(),
  productUpdates: z.boolean().optional(),
  role: z.string().optional(),
  initialMember: z.object({
    email: z.string().optional(),
    name: z.string().optional(),
    picture: z.string().optional(),
  }).optional(),
  // Force creation of a brand-new Clerk org instead of reusing the caller's
  // existing one. Set by the platform "create additional workspace" flow; the
  // default (false) keeps the signup dedupe that prevents double-submit orgs.
  createNewOrg: z.boolean().optional(),
  // Seed demo/sample data. Defaults to true (onboarding). Additional workspaces
  // pass false so they install the selected apps but start without demo rows.
  seedSampleData: z.boolean().optional(),
});

export type OnboardData = z.infer<typeof onboardSchema>;

/** Structured, transport-agnostic result of an onboarding run. */
export interface OnboardResult {
  success: boolean;
  workspaceId?: string;
  clerkOrgId?: string;
  alreadyProvisioned?: boolean;
  /**
   * True when the workspace is ALREADY fully usable when this call returns —
   * a warm pre-migrated pool slot was claimed and personalized inline. Callers
   * can switch to it immediately instead of polling database-status.
   */
  ready?: boolean;
  error?: string;
  /** HTTP status hint for the public route (defaults to 200 on success, 500 otherwise). */
  status?: number;
}

/**
 * Find a slug that isn't taken. Tries the base slug first, then appends
 * the short tail of the new workspace id, then a counter as a last resort.
 */
async function resolveUniqueSlug(
  masterDb: ReturnType<typeof getMasterDb>,
  base: string,
  workspaceId: string,
): Promise<string> {
  const candidates = [base, `${base}-${workspaceId.slice(-6)}`];
  for (const candidate of candidates) {
    const [taken] = await masterDb
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${workspaceId.slice(-6)}-${i}`;
    const [taken] = await masterDb
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, candidate))
      .limit(1);
    if (!taken) return candidate;
  }
  return `${base}-${workspaceId}`;
}

/**
 * Upsert workspace row, provision database, and set up billing.
 * Shared by both the new-org and existing-org code paths.
 */
async function upsertAndProvision(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  data: OnboardData,
  clerkOrgId: string,
  clerkOrgSlug: string,
): Promise<OnboardResult> {
  // Upsert workspace row
  let workspaceId: string;
  const [existing] = await masterDb
    .select({
      id: workspaces.id,
      neonProjectId: workspaces.neonProjectId,
      neonRoleName: workspaces.neonRoleName,
      databaseProvisionedAt: workspaces.databaseProvisionedAt,
    })
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, clerkOrgId))
    .limit(1);

  if (existing) {
    workspaceId = existing.id;

    // Only short-circuit if provisioning actually COMPLETED. If the Neon project
    // exists but databaseProvisionedAt is still null, the workflow never finished
    // — fall through so provisionWorkspaceDatabase() re-triggers it (recovery).
    if (existing.neonProjectId && existing.neonRoleName && existing.databaseProvisionedAt) {
      console.log(`[Onboard] Workspace ${workspaceId} already provisioned`);

      return {
        success: true,
        workspaceId,
        clerkOrgId,
        alreadyProvisioned: true,
        ready: true,
      };
    }

    // Update metadata
    await masterDb
      .update(workspaces)
      .set({
        name: data.workspaceName,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, existing.id));
  } else {
    // Get the default plan new workspaces start their 14-day trial on
    const [defaultPlan] = await masterDb
      .select({ id: plans.id, maxUsers: plans.maxUsers })
      .from(plans)
      .where(and(eq(plans.slug, 'business'), isNull(plans.deletedAt)))
      .limit(1);

    workspaceId = generateId('ws');

    const baseSlug = clerkOrgSlug || data.workspaceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
    const slug = await resolveUniqueSlug(masterDb, baseSlug, workspaceId);

    await masterDb.insert(workspaces).values({
      id: workspaceId,
      clerkOrgId,
      name: data.workspaceName,
      slug,
      planId: defaultPlan?.id || null,
      isActive: true,
      // New signups are subject to the "add payment or workspace is deleted
      // in 30 days" policy. Existing workspaces are grandfathered (column
      // defaults to false) — see packages/core/db/src/schema/master.ts.
      paidPlanRequired: true,
    });

    console.log(`[Onboard] Created workspace ${workspaceId} for org ${clerkOrgId}`);

    // Sync default plan seat limit to Clerk
    if (defaultPlan?.maxUsers && defaultPlan.maxUsers > 0) {
      syncClerkSeatLimit(env.CLERK_SECRET_KEY, clerkOrgId, defaultPlan.maxUsers).catch((err) => {
        console.warn('[Onboard] Failed to sync Clerk seat limit (non-blocking):', err);
      });
    }
  }

  // Provision database (idempotent). Instant path: a warm pre-migrated pool
  // slot is claimed and personalized inline (ready=true, no waiting). Slow
  // path: the Neon database is created on-demand and the
  // ProvisionWorkspaceWorkflow migrates it asynchronously. If the kickoff
  // itself fails we record 'failed' so the onboarding UI can surface a retry
  // instead of spinning.
  let ready = false;
  if (env.NEON_API_KEY) {
    const initialMember = data.initialMember ? {
      userId: data.clerkUserId,
      email: data.initialMember.email,
      name: data.initialMember.name,
      picture: data.initialMember.picture,
    } : { userId: data.clerkUserId };

    const provisionResult = await provisionWorkspaceDatabase(
      env,
      masterDb,
      workspaceId,
      data.workspaceName,
      initialMember,
      data.region,
      data.selectedApps,
      clerkOrgSlug,
      data.seedSampleData,
    );

    if (!provisionResult.ok) {
      await masterDb
        .update(workspaces)
        .set({
          provisioningStatus: 'failed',
          provisioningError: (provisionResult.error || 'Provisioning failed to start').slice(0, 1000),
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspaceId));
    }

    ready = provisionResult.ready === true;
  }

  // Auto-provision {slug}.weldmail.com email domain (non-blocking)
  if (env.CLOUDFLARE_API_TOKEN) {
    try {
      await provisionMailDomain(env, masterDb, workspaceId, clerkOrgSlug);
    } catch (mailErr) {
      // Non-fatal: workspace is usable without email domain
      console.error('[Onboard] Mail domain provisioning failed (non-blocking):', mailErr);
    }
  }

  // Stripe billing is set up by the ProvisionWorkspaceWorkflow (Cloudflare Workflow)
  // after migrations complete, keeping everything in one sequential flow.

  return {
    success: true,
    workspaceId,
    clerkOrgId,
    ready,
  };
}

/**
 * Core onboarding logic, decoupled from the HTTP layer so it runs identically
 * from the public `/api/onboard` route and the RPC entrypoint. `data` must
 * already be validated against `onboardSchema`.
 */
export async function runOnboard(
  env: Env,
  ctx: ExecutionContext,
  data: OnboardData,
): Promise<OnboardResult> {
  const masterDb = getMasterDb(env);

  // Best-effort guard against double-submits creating duplicate orgs/workspaces.
  // KV is eventually consistent, so this is not a hard lock — it narrows the
  // race window; the Clerk membership check below is the real dedupe for the
  // common (sequential) case. Fails open: if KV is unavailable we still proceed.
  const lockKey = `onboard:inflight:${data.clerkUserId}`;
  let heldLock = false;
  try {
    const inFlight = await env.WORKSPACE_CACHE.get(lockKey);
    if (inFlight) {
      // A concurrent onboarding for this user is in flight. Pause briefly so the
      // other request can register its Clerk org, then fall through — the
      // membership check reuses it instead of creating a second org.
      console.warn(`[Onboard] Concurrent onboarding for user ${data.clerkUserId}; waiting before dedupe`);
      await new Promise((r) => setTimeout(r, 1500));
    } else {
      await env.WORKSPACE_CACHE.put(lockKey, '1', { expirationTtl: 120 });
      heldLock = true;
    }
  } catch (lockErr) {
    console.warn('[Onboard] Concurrency guard unavailable (proceeding):', lockErr);
  }

  try {
    // 0. Check if user already has an organization (prevents duplicates from double-submit).
    //    Skipped when createNewOrg is set — the platform "create additional workspace"
    //    flow deliberately wants a brand-new org even though the user already has one.
    const existingMembershipsRes = data.createNewOrg
      ? null
      : await fetch(
          `https://api.clerk.com/v1/users/${data.clerkUserId}/organization_memberships?limit=1`,
          { headers: { 'Authorization': `Bearer ${env.CLERK_SECRET_KEY}` } },
        );

    if (existingMembershipsRes && existingMembershipsRes.ok) {
      const memberships = await existingMembershipsRes.json() as {
        data: Array<{ organization: { id: string; slug: string } }>;
      };

      if (memberships.data?.length > 0) {
        const existingOrg = memberships.data[0].organization;
        console.log(`[Onboard] User ${data.clerkUserId} already has org ${existingOrg.id}, reusing`);

        // Update org metadata in case this is a retry with different data
        const patchMetadata = {
          region: data.region,
          country: data.country,
          organizationType: data.organizationType,
          organizationSize: data.organizationSize,
          referralSource: data.referralSource,
          selectedApps: data.selectedApps,
        };
        console.log('[Onboard] PATCH public_metadata:', JSON.stringify(patchMetadata));

        // Update org name
        await fetch(`https://api.clerk.com/v1/organizations/${existingOrg.id}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${env.CLERK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: data.workspaceName }),
        });

        // Use /metadata endpoint (merges instead of replacing)
        const patchRes = await fetch(`https://api.clerk.com/v1/organizations/${existingOrg.id}/metadata`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${env.CLERK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ public_metadata: patchMetadata }),
        });

        if (!patchRes.ok) {
          const err = await patchRes.text();
          console.error('[Onboard] Failed to PATCH Clerk org metadata:', err);
        } else {
          console.log('[Onboard] PATCH org metadata succeeded');
        }

        return await upsertAndProvision(env, masterDb, data, existingOrg.id, existingOrg.slug);
      }
    }

    // 1. Create Clerk organization via Backend API
    const postMetadata = {
      region: data.region,
      country: data.country,
      organizationType: data.organizationType,
      organizationSize: data.organizationSize,
      referralSource: data.referralSource,
      selectedApps: data.selectedApps,
    };
    console.log('[Onboard] POST public_metadata:', JSON.stringify(postMetadata));

    const clerkRes = await fetch('https://api.clerk.com/v1/organizations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CLERK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: data.workspaceName,
        created_by: data.clerkUserId,
        public_metadata: postMetadata,
      }),
    });

    if (!clerkRes.ok) {
      const err = await clerkRes.text();
      console.error('[Onboard] Failed to create Clerk org:', err);
      return { success: false, error: 'Failed to create organization. Please try again or contact support.', status: 500 };
    }

    const clerkOrg = await clerkRes.json() as { id: string; slug: string; public_metadata?: Record<string, unknown> };
    console.log(`[Onboard] Created Clerk org ${clerkOrg.id}, metadata:`, JSON.stringify(clerkOrg.public_metadata));

    // Explicitly PATCH metadata after creation — the POST endpoint may not persist it
    const metadataPatchRes = await fetch(`https://api.clerk.com/v1/organizations/${clerkOrg.id}/metadata`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${env.CLERK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ public_metadata: postMetadata }),
    });

    if (!metadataPatchRes.ok) {
      const err = await metadataPatchRes.text();
      console.error('[Onboard] Failed to PATCH org metadata after creation:', err);
    } else {
      console.log('[Onboard] PATCH org metadata succeeded after creation');
    }

    // 2-4. Upsert workspace, provision database, set up billing
    return await upsertAndProvision(env, masterDb, data, clerkOrg.id, clerkOrg.slug);
  } catch (error: any) {
    const cause = error?.cause;
    console.error('[Onboard] Error:', JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
      code: error?.code ?? cause?.code,
      detail: error?.detail ?? cause?.detail,
      constraint: error?.constraint_name ?? cause?.constraint_name,
      schema: error?.schema_name ?? cause?.schema_name,
      table: error?.table_name ?? cause?.table_name,
      column: error?.column_name ?? cause?.column_name,
      severity: error?.severity ?? cause?.severity,
      causeMessage: cause?.message,
      causeStack: cause?.stack,
      stack: error?.stack,
    }));
    return {
      success: false,
      error: 'Something went wrong while setting up your workspace. Please try again or contact support.',
      status: 500,
    };
  } finally {
    if (heldLock) {
      ctx.waitUntil(env.WORKSPACE_CACHE.delete(lockKey).catch(() => {}));
    }
  }
}

export const onboardRoutes = new Hono<{ Bindings: Env }>();

// Verify M2M token on the PUBLIC HTTP path. This endpoint creates Clerk orgs,
// master rows and Neon projects, so it must never be publicly callable without
// auth. Trusted in-network callers use the RPC entrypoint (binding-only) instead.
onboardRoutes.use('*', m2mAuth());

onboardRoutes.post(
  '/',
  zValidator('json', onboardSchema, (result, c) => {
    if (!result.success) {
      console.error('[Onboard] Validation failed:', JSON.stringify(result.error.flatten()));
      return c.json({ success: false, error: 'Validation failed', details: result.error.flatten() }, 400);
    }
  }),
  async (c) => {
    const result = await runOnboard(c.env, c.executionCtx, c.req.valid('json'));
    const { status, ...body } = result;
    return c.json(body, result.success ? 200 : ((status ?? 500) as 400 | 500));
  },
);
