/**
 * Onboarding — /api/onboarding/*.
 *
 *   POST /create-workspace — create an ADDITIONAL workspace from within the
 *   platform's "New workspace" dialog. Mirrors the onboarding wizard exactly:
 *   org + workspace + provisioning all happen server-side via workspace-worker
 *   /api/onboard (single, controlled trigger — no client-side org creation, no
 *   reliance on the Clerk webhook). `createNewOrg` forces a brand-new org for
 *   the already-onboarded user; a default app set installs and sample data is
 *   skipped.
 *
 *   Signup onboarding flow (ported from mobile-api-worker /v2/onboarding,
 *   which itself was ported from api-worker /onboarding):
 *     GET  /status          — has the workspace completed onboarding?
 *     GET  /database-status — tenant DB provisioning progress (poll target)
 *     GET  /user-info       — Clerk user basics + active workspace name
 *     GET  /available-apps  — published app catalog (static fallback when empty)
 *     POST /profile         — save name + metadata to the Clerk user
 *     POST /workspace       — create FIRST org + workspace (no createNewOrg,
 *                             so workspace-worker's signup dedupe applies)
 *     POST /role            — save primaryRole to Clerk user metadata
 *     POST /invitations     — send Clerk org invitations to teammates
 *     POST /complete        — patch remaining user/org metadata; falls back to
 *                             workspace creation when no org exists yet
 *     POST /retry           — re-trigger provisioning for a stuck workspace
 *     POST /finalize        — mark onboarding complete in the master DB and
 *                             install the selected apps in the tenant DB
 *
 * IMPORTANT — middleware: this router needs Clerk auth but NOT the workspace-DB
 * middleware. The user is creating a NEW workspace, so requiring an active org
 * (and resolving its tenant DB) would be wrong. Like `auth-desktop`, it applies
 * `clerkMiddleware()` itself and must be mounted on the root app BEFORE the
 * global `app.use('/api/*', clerkMiddleware(), workspaceDbMiddleware(), ...)`.
 *
 * Entity events: workspace provisioning is delegated to the workspace worker,
 * and /finalize's installed-app rows have no entity type in the
 * @weldsuite/entity-events catalog (the `user_app` type covers WeldApps, not
 * catalog app installs) — so no events are published here, matching the
 * api-worker + mobile-api-worker originals.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import type { Env, Variables } from '../../types';
import { clerkMiddleware } from '../../middleware/clerk';
import { success, error } from '../../lib/response';
import { getMasterDb, getTenantDbForWorkspace, masterSchema, schema } from '../../db';
import { generateId } from '../../lib/id';

/**
 * Default apps installed when a workspace is created from the platform's
 * "New workspace" dialog and the caller doesn't specify a selection. The dialog
 * now lets the user pick apps (like the onboarding wizard), but we keep this
 * fallback for older clients / an empty selection. Core productivity set.
 */
const DEFAULT_WORKSPACE_APPS = ['crm', 'projects', 'task', 'mail', 'helpdesk'];

/**
 * Static fallback for GET /available-apps when the master DB has no published
 * catalog rows (or the query fails). Copied verbatim from the api-worker
 * original so the wizard's app-selection step never renders empty.
 */
const FALLBACK_CATALOG = [
  {
    code: 'commerce',
    name: 'Commerce',
    description:
      'Comprehensive e-commerce platform for online selling, product management, and order processing',
    icon: 'ShoppingCart',
    category: 'Sales & Marketing',
    path: '/commerce',
  },
  {
    code: 'crm',
    name: 'CRM',
    description: 'Manage leads, contacts, and sales pipelines',
    icon: 'Users',
    category: 'Sales & Marketing',
    path: '/crm',
  },
  {
    code: 'projects',
    name: 'Projects',
    description:
      'Project management and collaboration tools for teams, tasks, timelines, and deliverables',
    icon: 'ClipboardList',
    category: 'Productivity',
    path: '/projects',
  },
  {
    code: 'task',
    name: 'Tasks',
    description:
      'Personal task management for tracking to-dos, deadlines, and daily productivity',
    icon: 'CheckSquare',
    category: 'Productivity',
    path: '/task',
  },
  {
    code: 'helpdesk',
    name: 'Helpdesk',
    description:
      'Customer support ticketing system for managing customer inquiries and support requests',
    icon: 'Headphones',
    category: 'Customer Support',
    path: '/helpdesk',
  },
  {
    code: 'mail',
    name: 'Mail',
    description:
      'Email management and communication platform for team collaboration and customer outreach',
    icon: 'Mail',
    category: 'Communication',
    path: '/mail',
  },
  {
    code: 'parcel',
    name: 'Parcel',
    description:
      'Parcel tracking and shipping management for deliveries, returns, and carrier integrations',
    icon: 'Package',
    category: 'Operations',
    path: '/parcel',
  },
  {
    code: 'host',
    name: 'Host',
    description: 'Domain management and hosting services for websites and online presence',
    icon: 'Globe',
    category: 'Infrastructure',
    path: '/host',
  },
];

const createWorkspaceInput = z.object({
  name: z.string().min(1).max(255),
  region: z.string().optional(),
  /** App codes the user selected in the dialog. Falls back to the default set when omitted/empty. */
  selectedApps: z.array(z.string().min(1)).optional(),
});

const profileInput = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phone: z.string().optional(),
  jobTitle: z.string().optional(),
  productUpdates: z.boolean().optional(),
});

const workspaceInput = z.object({
  name: z.string().min(1).max(255),
  country: z.string().optional(),
  referralSource: z.string().optional(),
});

const roleInput = z.object({
  role: z.string().min(1),
});

/**
 * Both fields optional to match the api-worker original, which short-circuits
 * to `{ success: true, sent: 0, failed: [] }` when either is missing/empty
 * instead of rejecting. Email format is NOT validated here — an invalid email
 * surfaces as a per-invite Clerk failure in `failed`, like the original.
 */
const invitationsInput = z.object({
  organizationId: z.string().optional(),
  invites: z
    .array(
      z.object({
        email: z.string(),
        role: z.string(),
      }),
    )
    .optional(),
});

/**
 * Basic user fields fetched from the Clerk REST API. Non-OK responses yield
 * empty strings; a rejected fetch propagates to the caller's catch (matching
 * the api-worker + mobile-api-worker originals).
 */
async function fetchClerkUser(env: Env, userId: string) {
  const info = { email: '', picture: '', firstName: '', lastName: '' };
  const resp = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
  });
  if (resp.ok) {
    const clerkUser = (await resp.json()) as {
      first_name?: string;
      last_name?: string;
      email_addresses?: Array<{ email_address: string }>;
      image_url?: string;
    };
    info.email = clerkUser.email_addresses?.[0]?.email_address || '';
    info.picture = clerkUser.image_url || '';
    info.firstName = clerkUser.first_name || '';
    info.lastName = clerkUser.last_name || '';
  }
  return info;
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Clerk auth only — deliberately NOT workspaceDbMiddleware (creating a new org,
// so no active workspace / tenant DB is required or appropriate).
app.use('*', clerkMiddleware());

app.post('/create-workspace', zValidator('json', createWorkspaceInput), async (c) => {
  const userId = c.get('userId');
  if (!userId) {
    return error.unauthorized(c, 'Not authenticated');
  }

  const { name, region, selectedApps } = c.req.valid('json');
  const workspaceName = name.trim();
  if (!workspaceName) {
    return error.badRequest(c, 'Workspace name is required');
  }

  // Use the user's picks when provided; otherwise ship the default set.
  const appsToInstall =
    selectedApps && selectedApps.length > 0 ? selectedApps : DEFAULT_WORKSPACE_APPS;

  const workspaceWorker = c.env.WORKSPACE_WORKER;
  if (!workspaceWorker) {
    console.error('[Onboarding] WORKSPACE_WORKER service binding not configured');
    return error.internal(c, 'Workspace service not configured');
  }

  try {
    // Fetch creator info for the initial OWNER member.
    const { email, picture, firstName, lastName } = await fetchClerkUser(c.env, userId);
    const fullName = [firstName, lastName].filter(Boolean).join(' ');

    // Provision org + workspace + database via the workspace-worker RPC binding.
    // Binding-only (never public), so no Clerk M2M token is required.
    const result = await workspaceWorker.onboard({
      clerkUserId: userId,
      workspaceName,
      firstName,
      lastName,
      region,
      selectedApps: appsToInstall,
      createNewOrg: true,
      seedSampleData: false,
      initialMember: { email, name: fullName, picture },
    });

    if (!result.success) {
      console.warn('[Onboarding] create-workspace failed:', result.error);
      return error.internal(c, result.error || 'Failed to create workspace');
    }

    return success(c, {
      success: true,
      organizationId: result.clerkOrgId,
      workspaceId: result.workspaceId,
      // Instant provisioning: a warm pre-migrated database slot was claimed
      // and personalized inline — the client can switch to the new workspace
      // immediately instead of showing the provisioning wait.
      ready: result.ready === true,
    });
  } catch (err) {
    console.error('[Onboarding] Error creating additional workspace:', err);
    return error.internal(c, 'Failed to create workspace');
  }
});

// ============================================================================
// GET /status — has the active workspace completed onboarding?
// ============================================================================

app.get('/status', async (c) => {
  const userId = c.get('userId');
  const orgId = c.get('orgId');

  if (!userId || !orgId) {
    return success(c, { completed: false, hasOrganization: false });
  }

  try {
    const masterDb = getMasterDb(c.env);

    const [workspace] = await masterDb
      .select({
        onboardingCompletedAt: masterSchema.workspaces.onboardingCompletedAt,
      })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
      .limit(1);

    return success(c, {
      completed: !!workspace?.onboardingCompletedAt,
      hasOrganization: true,
    });
  } catch (err) {
    console.error('[Onboarding] Error checking status:', err);
    return success(c, { completed: false, hasOrganization: false });
  }
});

// ============================================================================
// GET /database-status — tenant DB provisioning progress (poll target)
// ============================================================================

app.get('/database-status', async (c) => {
  const orgId = c.get('orgId');

  if (!orgId) {
    return success(c, { provisioned: false, migrated: false, status: 'pending', failed: false });
  }

  try {
    const masterDb = getMasterDb(c.env);

    const [workspace] = await masterDb
      .select({
        neonProjectId: masterSchema.workspaces.neonProjectId,
        databaseProvisionedAt: masterSchema.workspaces.databaseProvisionedAt,
        provisioningStatus: masterSchema.workspaces.provisioningStatus,
      })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
      .limit(1);

    if (!workspace) {
      return success(c, { provisioned: false, migrated: false, status: 'pending', failed: false });
    }

    const provisioned = !!workspace.neonProjectId && !!workspace.databaseProvisionedAt;
    // databaseProvisionedAt stays the source of truth for "ready" (covers rows
    // created before provisioningStatus existed). Only trust the 'failed' flag
    // when the workspace is not already provisioned.
    const failed = !provisioned && workspace.provisioningStatus === 'failed';
    const status = provisioned ? 'ready' : (workspace.provisioningStatus ?? 'pending');

    return success(c, {
      provisioned,
      migrated: provisioned,
      status,
      failed,
    });
  } catch (err) {
    console.error('[Onboarding] Error checking database status:', err);
    return success(c, { provisioned: false, migrated: false, status: 'pending', failed: false });
  }
});

// ============================================================================
// GET /user-info — Clerk user basics + active workspace name (wizard prefill)
// ============================================================================

app.get('/user-info', async (c) => {
  const userId = c.get('userId');
  const orgId = c.get('orgId');

  if (!userId) {
    return success(c, {
      user: { firstName: '', lastName: '', email: '' },
      organization: null,
    });
  }

  try {
    // Fetch user info from the Clerk REST API. Inline (not fetchClerkUser)
    // to preserve the original's `imageUrl?: string` shape — the key is
    // omitted from the JSON when Clerk has no image, never an empty string.
    const clerkResp = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
      headers: { Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}` },
    });

    let userInfo = {
      firstName: '',
      lastName: '',
      email: '',
      imageUrl: undefined as string | undefined,
    };

    if (clerkResp.ok) {
      const clerkUser = (await clerkResp.json()) as {
        first_name?: string;
        last_name?: string;
        email_addresses?: Array<{ email_address: string }>;
        image_url?: string;
      };
      userInfo = {
        firstName: clerkUser.first_name || '',
        lastName: clerkUser.last_name || '',
        email: clerkUser.email_addresses?.[0]?.email_address || '',
        imageUrl: clerkUser.image_url,
      };
    }

    let organization: { id: string; name: string } | null = null;
    if (orgId) {
      const masterDb = getMasterDb(c.env);
      const [workspace] = await masterDb
        .select({
          name: masterSchema.workspaces.name,
        })
        .from(masterSchema.workspaces)
        .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
        .limit(1);

      if (workspace) {
        organization = { id: orgId, name: workspace.name };
      }
    }

    return success(c, {
      user: userInfo,
      organization,
    });
  } catch (err) {
    console.error('[Onboarding] Error getting user info:', err);
    return success(c, {
      user: { firstName: '', lastName: '', email: '' },
      organization: null,
    });
  }
});

// ============================================================================
// GET /available-apps — published app catalog for the wizard's selection step.
// Master-DB read only (no tenant DB exists yet during signup), so this stays
// here rather than reusing services/app-catalog.ts (which needs a tenant DB
// for installation status). Falls back to the static catalog when the master
// DB has no published apps or the query fails, matching the original.
// ============================================================================

app.get('/available-apps', async (c) => {
  try {
    const masterDb = getMasterDb(c.env);

    const apps = await masterDb
      .select()
      .from(masterSchema.appCatalog)
      .where(
        and(
          eq(masterSchema.appCatalog.isActive, true),
          eq(masterSchema.appCatalog.isPublished, true),
        ),
      );

    if (apps.length === 0) {
      return success(c, FALLBACK_CATALOG);
    }

    const mapped = apps.map((app) => ({
      code: app.code,
      name: app.name,
      description: app.description,
      icon: app.icon,
      category: app.category,
      path: app.path,
      overview: app.overview,
      // NOTE: null passes through as JSON null (the api-worker original's
      // `as string[] | undefined` was a compile-time cast only).
      features: app.features as string[] | null,
      howItWorks: app.howItWorks as { title: string; description: string }[] | null,
      version: app.version || '1.0.0',
      provider: app.provider,
    }));

    return success(c, mapped);
  } catch (err) {
    console.error('[Onboarding] Error getting available apps:', err);
    return success(c, FALLBACK_CATALOG);
  }
});

// ============================================================================
// POST /profile — save name + metadata to the Clerk user
// ============================================================================

app.post('/profile', zValidator('json', profileInput), async (c) => {
  const userId = c.get('userId');

  if (!userId) {
    return error.unauthorized(c, 'Not authenticated');
  }

  try {
    const data = c.req.valid('json');

    // Update user profile in Clerk.
    const patchRes = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        first_name: data.firstName,
        last_name: data.lastName,
      }),
    });

    if (!patchRes.ok) {
      const errText = await patchRes.text();
      console.error('[Onboarding] Failed to update Clerk user profile:', errText);
      return error.internal(c, 'Failed to update profile');
    }

    // Update user metadata (phone, jobTitle, productUpdates).
    const metadata: Record<string, unknown> = {};
    if (data.productUpdates !== undefined) metadata.productUpdates = data.productUpdates;
    if (data.phone) metadata.phone = data.phone;
    if (data.jobTitle) metadata.jobTitle = data.jobTitle;

    if (Object.keys(metadata).length > 0) {
      await fetch(`https://api.clerk.com/v1/users/${userId}/metadata`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          public_metadata: metadata,
        }),
      });
    }

    return success(c, { success: true });
  } catch (err) {
    console.error('[Onboarding] Error saving profile:', err);
    return error.internal(c, 'Failed to save profile');
  }
});

// ============================================================================
// POST /workspace — create FIRST org + workspace during signup onboarding.
// Unlike /create-workspace, createNewOrg is NOT set, so workspace-worker's
// signup dedupe (reuse the caller's existing org) prevents double-submit orgs.
// ============================================================================

app.post('/workspace', zValidator('json', workspaceInput), async (c) => {
  const userId = c.get('userId');

  if (!userId) {
    return error.unauthorized(c, 'Not authenticated');
  }

  const workspaceWorker = c.env.WORKSPACE_WORKER;
  if (!workspaceWorker) {
    console.error('[Onboarding] WORKSPACE_WORKER service binding not configured');
    return error.internal(c, 'Workspace service not configured');
  }

  try {
    const data = c.req.valid('json');

    // Fetch user info for the initial OWNER member.
    const { email, picture, firstName, lastName } = await fetchClerkUser(c.env, userId);
    const fullName = [firstName, lastName].filter(Boolean).join(' ');

    const result = await workspaceWorker.onboard({
      clerkUserId: userId,
      workspaceName: data.name,
      firstName,
      lastName,
      country: data.country,
      referralSource: data.referralSource,
      initialMember: { email, name: fullName, picture },
    });

    if (!result.success) {
      console.warn('[Onboarding] Workspace worker failed:', result.error);
      return error.internal(c, result.error || 'Failed to create workspace');
    }

    return success(c, {
      success: true,
      organizationId: result.clerkOrgId,
      workspaceId: result.workspaceId,
      ready: result.ready === true,
    });
  } catch (err) {
    console.error('[Onboarding] Error creating workspace:', err);
    return error.internal(c, 'Failed to create workspace');
  }
});

// ============================================================================
// POST /role — save primaryRole to Clerk user metadata
// ============================================================================

app.post('/role', zValidator('json', roleInput), async (c) => {
  const userId = c.get('userId');

  if (!userId) {
    return error.unauthorized(c, 'Not authenticated');
  }

  try {
    const { role } = c.req.valid('json');

    await fetch(`https://api.clerk.com/v1/users/${userId}/metadata`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        public_metadata: {
          primaryRole: role,
        },
      }),
    });

    return success(c, { success: true });
  } catch (err) {
    console.error('[Onboarding] Error saving role:', err);
    return error.internal(c, 'Failed to save role');
  }
});

// ============================================================================
// POST /invitations — send Clerk org invitations to teammates. Per-invite
// failures are collected in `failed` rather than failing the whole request.
// The org id comes from the client (the wizard holds it from the /workspace
// response before the session's active org is set); Clerk authorizes the
// invite via `inviter_user_id`, matching the api-worker original.
// ============================================================================

app.post('/invitations', zValidator('json', invitationsInput), async (c) => {
  const userId = c.get('userId');

  if (!userId) {
    return error.unauthorized(c, 'Not authenticated');
  }

  try {
    const { organizationId, invites } = c.req.valid('json');

    if (!organizationId || !invites?.length) {
      return success(c, { success: true, sent: 0, failed: [] });
    }

    let sent = 0;
    const failed: Array<{ email: string; error: string }> = [];

    for (const invite of invites) {
      try {
        const inviteRes = await fetch(
          `https://api.clerk.com/v1/organizations/${organizationId}/invitations`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              email_address: invite.email,
              role: invite.role === 'admin' ? 'org:admin' : 'org:member',
              inviter_user_id: userId,
            }),
          },
        );

        if (inviteRes.ok) {
          sent += 1;
        } else {
          const errText = await inviteRes.text();
          failed.push({ email: invite.email, error: errText });
        }
      } catch {
        failed.push({ email: invite.email, error: 'Failed to send invitation' });
      }
    }

    return success(c, { success: true, sent, failed });
  } catch (err) {
    console.error('[Onboarding] Error sending invitations:', err);
    return error.internal(c, 'Failed to send invitations');
  }
});

// ============================================================================
// POST /complete — patch remaining user/org metadata; falls back to workspace
// creation when no org exists yet (backwards compat with clients that skip
// the /workspace step).
// ============================================================================

app.post('/complete', async (c) => {
  const userId = c.get('userId');
  const orgId = c.get('orgId');

  if (!userId) {
    return error.unauthorized(c, 'Not authenticated');
  }

  try {
    let data: Record<string, unknown> = {};
    try {
      data = await c.req.json();
    } catch {
      // Body may be empty — that's OK.
    }

    // Update user metadata with any remaining fields (role, productUpdates).
    if (data.role || data.productUpdates !== undefined) {
      await fetch(`https://api.clerk.com/v1/users/${userId}/metadata`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          public_metadata: {
            ...(data.productUpdates !== undefined ? { productUpdates: data.productUpdates } : {}),
            ...(data.role ? { primaryRole: data.role } : {}),
          },
        }),
      });
    }

    // Org already exists (workspace was created in the /workspace step) — just
    // patch org metadata with any data sent along.
    if (orgId) {
      const metadata: Record<string, unknown> = {};
      if (data.country) metadata.country = data.country;
      if (data.referralSource) metadata.referralSource = data.referralSource;
      if (data.organizationType) metadata.organizationType = data.organizationType;
      if (data.organizationSize) metadata.organizationSize = data.organizationSize;
      if (data.region) metadata.region = data.region;
      if (data.selectedApps) metadata.selectedApps = data.selectedApps;

      if (Object.keys(metadata).length > 0) {
        const patchRes = await fetch(`https://api.clerk.com/v1/organizations/${orgId}/metadata`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ public_metadata: metadata }),
        });

        if (!patchRes.ok) {
          const errText = await patchRes.text();
          console.error('[Onboarding] Failed to patch org metadata:', errText);
        }
      }

      return success(c, { success: true, clerkOrgId: orgId });
    }

    // Fallback: no org set yet — create org + workspace via the workspace-worker
    // RPC binding (binding-only, so no M2M token is required).
    const workspaceWorker = c.env.WORKSPACE_WORKER;
    if (!workspaceWorker) {
      console.error('[Onboarding] WORKSPACE_WORKER service binding not configured');
      return error.internal(c, 'Workspace service not configured');
    }

    const { email, picture } = await fetchClerkUser(c.env, userId);
    const name = [data.firstName, data.lastName].filter(Boolean).join(' ');

    const result = await workspaceWorker.onboard({
      clerkUserId: userId,
      workspaceName: data.organizationName,
      firstName: data.firstName,
      lastName: data.lastName,
      country: data.country,
      referralSource: data.referralSource,
      region: data.region,
      organizationType: data.organizationType,
      organizationSize: data.organizationSize,
      selectedApps: data.selectedApps,
      productUpdates: data.productUpdates,
      role: data.role,
      initialMember: { email, name, picture },
    });

    if (!result.success) {
      console.warn('[Onboarding] Workspace worker failed:', result.error);
      return error.internal(c, result.error || 'Failed to create workspace');
    }

    return success(c, {
      success: true,
      clerkOrgId: result.clerkOrgId,
      workspaceId: result.workspaceId,
    });
  } catch (err) {
    console.error('[Onboarding] Error completing onboarding:', err);
    return error.internal(c, 'Failed to complete onboarding');
  }
});

// ============================================================================
// POST /retry — re-trigger provisioning for a workspace whose org exists but
// whose tenant DB never finished provisioning. Short-circuits when the DB is
// already provisioned (databaseProvisionedAt is the source of truth — billing
// is set up inside the provisioning workflow, so checking it here would
// wrongly skip a workspace whose DB exists but never finished provisioning).
// Uses the WORKSPACE_WORKER RPC binding (binding-only, no M2M token) instead
// of the api-worker original's public HTTP + M2M path.
// ============================================================================

app.post('/retry', async (c) => {
  const userId = c.get('userId');
  const orgId = c.get('orgId');

  if (!userId || !orgId) {
    return error.unauthorized(c, 'Not authenticated');
  }

  try {
    const masterDb = getMasterDb(c.env);

    const [workspace] = await masterDb
      .select({
        databaseProvisionedAt: masterSchema.workspaces.databaseProvisionedAt,
      })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
      .limit(1);

    if (workspace?.databaseProvisionedAt) {
      return success(c, { success: true });
    }

    const workspaceWorker = c.env.WORKSPACE_WORKER;
    if (!workspaceWorker) {
      console.error('[Onboarding] WORKSPACE_WORKER service binding not configured');
      return error.internal(c, 'Workspace service not configured');
    }

    // Clear any 'failed' state so the UI immediately reflects that we're retrying.
    await masterDb
      .update(masterSchema.workspaces)
      .set({ provisioningStatus: 'provisioning', provisioningError: null, updatedAt: new Date() })
      .where(eq(masterSchema.workspaces.clerkOrgId, orgId));

    // Re-fetch the org name + user info from Clerk for the onboard payload.
    const [orgResp, user] = await Promise.all([
      fetch(`https://api.clerk.com/v1/organizations/${orgId}`, {
        headers: { Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}` },
      }),
      fetchClerkUser(c.env, userId),
    ]);

    let orgName = '';
    if (orgResp.ok) {
      const org = (await orgResp.json()) as { name?: string };
      orgName = org.name || '';
    }

    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ');

    const result = await workspaceWorker.onboard({
      clerkUserId: userId,
      workspaceName: orgName,
      firstName: user.firstName,
      lastName: user.lastName,
      initialMember: { email: user.email, name: fullName, picture: user.picture },
    });

    if (result.success) {
      return success(c, { success: true });
    }

    console.warn('[Onboarding] Retry provisioning failed:', result.error);
    return error.internal(c, 'Failed to provision');
  } catch (err) {
    console.error('[Onboarding] Error in retry provisioning:', err);
    return error.internal(c, 'Failed to provision');
  }
});

// ============================================================================
// POST /finalize — mark onboarding complete in the master DB and install the
// selected apps (from Clerk org metadata) in the tenant DB.
// ============================================================================

app.post('/finalize', async (c) => {
  const userId = c.get('userId');
  const orgId = c.get('orgId');

  if (!userId) {
    return error.unauthorized(c, 'Not authenticated');
  }

  if (!orgId) {
    return error.orgRequired(c);
  }

  try {
    const masterDb = getMasterDb(c.env);

    // Get selected apps from Clerk org metadata.
    const orgResp = await fetch(`https://api.clerk.com/v1/organizations/${orgId}`, {
      headers: { Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}` },
    });

    let selectedApps: string[] = [];
    if (orgResp.ok) {
      const org = (await orgResp.json()) as { public_metadata?: Record<string, unknown> };
      selectedApps = (org.public_metadata?.selectedApps as string[]) || [];
    }

    // Mark onboarding complete in the master DB.
    await masterDb
      .update(masterSchema.workspaces)
      .set({
        onboardingCompletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(masterSchema.workspaces.clerkOrgId, orgId));

    // Install selected apps in the tenant DB. Best-effort per app — onboarding
    // stays marked complete even if an install fails.
    if (selectedApps.length > 0) {
      try {
        const tenantDb = await getTenantDbForWorkspace(c.env, orgId);
        const { workspaceInstalledApps, userAppAssignments } = schema;

        for (const appCode of selectedApps) {
          try {
            // Install app at workspace level.
            await tenantDb
              .insert(workspaceInstalledApps)
              .values({
                id: generateId('wia'),
                appCode,
                installedBy: userId,
                isActive: true,
                installedAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
              })
              .onConflictDoNothing();

            // Assign app to the onboarding user.
            await tenantDb
              .insert(userAppAssignments)
              .values({
                id: generateId('uaa'),
                userId,
                appCode,
                isActive: true,
                createdAt: new Date(),
                updatedAt: new Date(),
              })
              .onConflictDoNothing();
          } catch (appError) {
            console.error(`[Onboarding] Failed to install app ${appCode}:`, appError);
          }
        }
      } catch (dbError) {
        console.error('[Onboarding] Failed to connect to tenant DB for app install:', dbError);
        // Continue — onboarding is still marked complete.
      }
    }

    return success(c, { success: true });
  } catch (err) {
    console.error('[Onboarding] Error finalizing onboarding:', err);
    return error.internal(c, 'Failed to finalize onboarding');
  }
});

export const onboardingRoutes = app;
