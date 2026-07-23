/**
 * Clerk Webhook Handler
 *
 * Handles Clerk webhook events for:
 * - Organization lifecycle (created, updated, deleted)
 * - Membership changes (created, updated, deleted)
 * - Invitations (created, accepted, revoked)
 * - User lifecycle (created, updated, deleted)
 *
 * Also triggers database provisioning for new organizations.
 */

import { Hono } from 'hono';
import { Webhook } from 'svix';
import { eq, and, isNull, or, ne, sql } from 'drizzle-orm';
import { sendTemplateEmail } from '@weldsuite/transactional-email';
import type { Env } from '../../index';
import { getMasterDb, getTenantDbForWorkspace } from '../../db';
import { generateId } from '../../lib/id';
import { autoJoinUserToPublicChannels } from '../../lib/weldchat-auto-join';
import { createProvisioningService, type InitialMember } from '@weldsuite/neon-provisioning';
import { provisionWorkspaceDatabase } from '../../services/provisioning';
import {
  users,
  workspaces,
  userWorkspaces,
  plans,
} from '@weldsuite/db/schema/master';
import { workspaceMembers } from '@weldsuite/db/schema';

// ============================================================================
// Clerk Webhook Types
// ============================================================================

interface ClerkOrganizationData {
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
  created_by: string;
  public_metadata?: Record<string, unknown>;
}

interface ClerkOrganizationMembership {
  id: string;
  organization: { id: string; name: string; slug: string };
  public_user_data: {
    user_id: string;
    first_name: string | null;
    last_name: string | null;
    image_url: string | null;
    identifier: string;
  };
  role: string;
  created_at: number;
}

interface ClerkOrganizationInvitation {
  id: string;
  organization_id: string;
  email_address: string;
  role: string;
  status: string;
  created_at: number;
  // `inviter_user_id` is included on the organizationInvitation.created
  // payload but may be absent on system-generated invitations.
  inviter_user_id?: string | null;
}

interface ClerkUserData {
  id: string;
  email_addresses: Array<{ email_address: string; id: string }>;
  primary_email_address_id: string | null;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
}

function mapClerkRoleToDisplay(clerkRole: string): 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER' {
  switch (clerkRole) {
    case 'org:admin': return 'ADMIN';
    case 'org:member':
    default: return 'MEMBER';
  }
}

// New workspaces start a 14-day trial on this plan (see setupWorkspaceBilling).
const DEFAULT_PLAN_SLUG = 'business';

export const clerkWebhookRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /api/webhooks/clerk — Main webhook endpoint
 */
clerkWebhookRoutes.post('/', async (c) => {
  const body = await c.req.text();

  const svixId = c.req.header('svix-id');
  const svixTimestamp = c.req.header('svix-timestamp');
  const svixSignature = c.req.header('svix-signature');

  if (!svixId || !svixTimestamp || !svixSignature) {
    return c.json({ error: 'Missing svix headers' }, 400);
  }

  const webhookSecret = c.env.CLERK_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return c.json({ error: 'Webhook not configured' }, 500);
  }

  let event: { type: string; data: unknown };
  try {
    const webhook = new Webhook(webhookSecret);
    event = webhook.verify(body, {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': svixSignature,
    }) as { type: string; data: unknown };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Clerk Webhook] Signature verification failed:', message);
    return c.json({ error: 'Invalid signature' }, 400);
  }

  console.log(`[Clerk Webhook] Received event: ${event.type}`);

  try {
    const masterDb = getMasterDb(c.env);

    switch (event.type) {
      case 'organization.created':
        await handleOrganizationCreated(c.env, masterDb, event.data as ClerkOrganizationData);
        break;
      case 'organization.updated':
        await handleOrganizationUpdated(masterDb, event.data as ClerkOrganizationData);
        break;
      case 'organization.deleted':
        await handleOrganizationDeleted(c.env, masterDb, event.data as ClerkOrganizationData);
        break;
      case 'organizationMembership.created':
        await handleMembershipCreated(c.env, masterDb, event.data as ClerkOrganizationMembership);
        break;
      case 'organizationMembership.updated':
        await handleMembershipUpdated(c.env, masterDb, event.data as ClerkOrganizationMembership);
        break;
      case 'organizationMembership.deleted':
        await handleMembershipDeleted(c.env, masterDb, event.data as ClerkOrganizationMembership);
        break;
      case 'organizationInvitation.created':
        await handleInvitationCreated(c.env, masterDb, event.data as ClerkOrganizationInvitation);
        break;
      case 'organizationInvitation.accepted':
        await handleInvitationAccepted(c.env, masterDb, event.data as ClerkOrganizationInvitation);
        break;
      case 'organizationInvitation.revoked':
        await handleInvitationRevoked(c.env, masterDb, event.data as ClerkOrganizationInvitation);
        break;
      case 'user.created':
        await handleUserCreated(masterDb, event.data as ClerkUserData);
        break;
      case 'user.updated':
        await handleUserUpdated(c.env, masterDb, event.data as ClerkUserData);
        break;
      case 'user.deleted':
        await handleUserDeleted(c.env, masterDb, event.data as ClerkUserData);
        break;
      default:
        console.log(`[Clerk Webhook] Unhandled event type: ${event.type}`);
    }

    return c.json({ received: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Clerk Webhook] Error processing event:', error);
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// ORGANIZATION HANDLERS
// ============================================================================

async function handleOrganizationCreated(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  org: ClerkOrganizationData,
) {
  console.log('[Clerk Webhook] Processing organization.created');

  try {
    // Use INSERT ... ON CONFLICT to safely handle the race between this webhook
    // and the onboard endpoint, which may both try to create the workspace row
    // for the same clerkOrgId concurrently.
    const [defaultPlan] = await masterDb
      .select()
      .from(plans)
      .where(and(eq(plans.slug, DEFAULT_PLAN_SLUG), isNull(plans.deletedAt)))
      .limit(1);

    const newWorkspaceId = generateId('ws');

    const [upserted] = await masterDb
      .insert(workspaces)
      .values({
        id: newWorkspaceId,
        clerkOrgId: org.id,
        name: org.name,
        slug: org.slug,
        imageUrl: org.image_url,
        planId: defaultPlan?.id || null,
        // New signup → subject to the "add payment or be deleted" policy.
        // Only set on insert; the conflict-update below intentionally omits it
        // so a grandfathered existing workspace is never flipped.
        paidPlanRequired: true,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: workspaces.clerkOrgId,
        set: {
          name: org.name,
          slug: org.slug,
          imageUrl: org.image_url,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: workspaces.id,
        neonProjectId: workspaces.neonProjectId,
        neonRoleName: workspaces.neonRoleName,
      });

    const workspaceId = upserted.id;
    const alreadyProvisioned = !!(upserted.neonProjectId && upserted.neonRoleName);

    if (alreadyProvisioned) {
      console.log(`[Clerk Webhook] Workspace ${workspaceId} already provisioned, skipping`);
    } else if (upserted.id !== newWorkspaceId) {
      console.log(`[Clerk Webhook] Updated existing workspace ${workspaceId} for org ${org.id}`);
    } else {
      console.log(`[Clerk Webhook] Created workspace ${workspaceId} for org ${org.id}`);
    }

    // Provision database if not already done.
    // Skip if the org was created via the onboard endpoint (it handles provisioning itself).
    // We detect this by checking for selectedApps in public_metadata, which is only set
    // by the onboard endpoint. This prevents the race condition where both the webhook
    // and the onboard endpoint try to create a Neon project simultaneously.
    const createdViaOnboard = !!(org.public_metadata as Record<string, unknown>)?.selectedApps;

    if (!alreadyProvisioned && !createdViaOnboard && env.NEON_API_KEY) {
      let initialMember: InitialMember | undefined;
      if (org.created_by) {
        const [creator] = await masterDb
          .select({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            imageUrl: users.imageUrl,
          })
          .from(users)
          .where(eq(users.id, org.created_by))
          .limit(1);

        if (creator) {
          const fullName = [creator.firstName, creator.lastName].filter(Boolean).join(' ');
          initialMember = {
            userId: creator.id,
            email: creator.email || undefined,
            name: fullName || undefined,
            picture: creator.imageUrl || undefined,
          };
        } else {
          initialMember = { userId: org.created_by };
        }
      }

      const region = (org.public_metadata as Record<string, unknown>)?.region as string | undefined
        || env.NEON_DEFAULT_REGION
        || 'aws-eu-central-1';

      // Pass org.slug so the WeldMail domain ({slug}.weldmail.com) gets provisioned
      // too — matching the onboard path. selectedApps is unknown on webhook-only org
      // creations (an edge case now that both UI paths go through /api/onboard).
      await provisionWorkspaceDatabase(env, masterDb, workspaceId, org.name, initialMember, region, undefined, org.slug);
    } else if (createdViaOnboard) {
      console.log(`[Clerk Webhook] Skipping provisioning — org created via onboard endpoint`);
    }

    // Stripe billing is set up by the ProvisionWorkspaceWorkflow (Cloudflare Workflow)
    // after migrations complete, keeping everything in one sequential flow.
  } catch (error) {
    console.error('[Clerk Webhook] Error handling organization.created:', error);
    throw error;
  }
}

async function handleOrganizationUpdated(
  masterDb: ReturnType<typeof getMasterDb>,
  org: ClerkOrganizationData,
) {
  const result = await masterDb
    .update(workspaces)
    .set({
      name: org.name,
      slug: org.slug,
      imageUrl: org.image_url,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.clerkOrgId, org.id))
    .returning({ id: workspaces.id });

  if (result.length > 0) {
    console.log(`[Clerk Webhook] Updated workspace ${result[0].id}`);
  }
}

async function handleOrganizationDeleted(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  org: ClerkOrganizationData,
) {
  const [workspace] = await masterDb
    .select()
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, org.id));

  if (!workspace) return;

  await masterDb
    .update(workspaces)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(workspaces.id, workspace.id));

  await masterDb
    .delete(userWorkspaces)
    .where(eq(userWorkspaces.workspaceId, workspace.id));

  console.log(`[Clerk Webhook] Soft-deleted workspace ${workspace.id}`);

  if (env.NEON_API_KEY && workspace.neonProjectId) {
    try {
      const provisioningService = createProvisioningService({
        NEON_API_KEY: env.NEON_API_KEY,
        NEON_ORG_ID: env.NEON_ORG_ID,
        NEON_DEFAULT_REGION: env.NEON_DEFAULT_REGION || 'aws-eu-central-1',
      });

      await provisioningService.deleteWorkspaceDatabase(masterDb, workspace.id);
      console.log(`[Clerk Webhook] Deleted database for workspace ${workspace.id}`);
    } catch (error) {
      console.error('[Clerk Webhook] Failed to delete workspace database:', error);
    }
  }
}

// ============================================================================
// MEMBERSHIP HANDLERS
// ============================================================================

async function getWorkspaceIdFromClerkOrg(
  masterDb: ReturnType<typeof getMasterDb>,
  clerkOrgId: string,
): Promise<string | null> {
  const [workspace] = await masterDb
    .select()
    .from(workspaces)
    .where(eq(workspaces.clerkOrgId, clerkOrgId));
  return workspace?.id || null;
}

async function handleMembershipCreated(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  membership: ClerkOrganizationMembership,
) {
  const clerkOrgId = membership.organization.id;
  const userId = membership.public_user_data.user_id;

  const masterWorkspaceId = await getWorkspaceIdFromClerkOrg(masterDb, clerkOrgId);
  if (masterWorkspaceId) {
    try {
      const [existingUW] = await masterDb
        .select()
        .from(userWorkspaces)
        .where(and(
          eq(userWorkspaces.userId, userId),
          eq(userWorkspaces.workspaceId, masterWorkspaceId),
        ));

      if (existingUW) {
        await masterDb
          .update(userWorkspaces)
          .set({
            clerkMembershipId: membership.id,
            role: membership.role,
            status: 'ACTIVE',
            joinedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(userWorkspaces.id, existingUW.id));
      } else {
        await masterDb.insert(userWorkspaces).values({
          id: generateId('uw'),
          userId,
          workspaceId: masterWorkspaceId,
          clerkMembershipId: membership.id,
          role: membership.role,
          status: 'ACTIVE',
          joinedAt: new Date(),
        });
      }
    } catch (error) {
      console.error('[Clerk Webhook] Error updating user_workspaces:', error);
    }
  }

  // Update tenant DB
  try {
    const tenantDb = await getTenantDbForWorkspace(env, clerkOrgId);
    if (!masterWorkspaceId) return;

    const email = membership.public_user_data.identifier;
    const name = [membership.public_user_data.first_name, membership.public_user_data.last_name]
      .filter(Boolean).join(' ') || null;
    const picture = membership.public_user_data.image_url;
    const role = mapClerkRoleToDisplay(membership.role);

    // Captured per branch so we can fan the user into every public weldchat
    // channel once the row is ACTIVE. Null = no activation happened.
    let activatedMemberType: string | null = null;

    // 1. Check if member already exists by userId
    const [existing] = await tenantDb
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)));

    if (existing) {
      // Don't downgrade OWNER — Clerk has no OWNER concept, so a sync from Clerk
      // (org:admin → ADMIN, org:member → MEMBER) must not strip the OWNER set
      // by provisioning or by the first-member rule below.
      // Don't promote EXTERNAL_GUEST either — guests are deliberately VIEWER
      // with a fixed permissions allowlist; Clerk's org:member role mapping
      // would bump them to MEMBER and quietly turn a guest into a billable
      // employee.
      const preservedRole =
        existing.role === 'OWNER'
          ? 'OWNER'
          : existing.memberType === 'EXTERNAL_GUEST'
            ? existing.role
            : role;
      console.log(`[Clerk Webhook] Updating existing member ${existing.id} to ACTIVE for user ${userId} (role: ${preservedRole}, memberType: ${existing.memberType})`);
      await tenantDb
        .update(workspaceMembers)
        .set({ email, name, picture, role: preservedRole, status: 'ACTIVE', clerkMembershipId: membership.id, updatedAt: new Date() })
        .where(eq(workspaceMembers.id, existing.id));
      activatedMemberType = existing.memberType;
    } else {
      // 2. Look for an invitation row by email — match either:
      //    - PENDING (membership.created arrived before invitation.accepted), or
      //    - already-ACTIVE row whose userId is still the `pending_clerk_…`
      //      placeholder (invitation.accepted arrived first and flipped status
      //      to ACTIVE without knowing the real userId).
      const [pendingByEmail] = email
        ? await tenantDb
            .select()
            .from(workspaceMembers)
            .where(and(
              sql`lower(${workspaceMembers.email}) = lower(${email})`,
              or(
                eq(workspaceMembers.status, 'PENDING'),
                sql`${workspaceMembers.userId} LIKE 'pending_clerk_%'`,
                sql`${workspaceMembers.userId} LIKE 'invited_%'`,
              ),
              isNull(workspaceMembers.deletedAt),
            ))
        : [];

      if (pendingByEmail) {
        // OWNER preserved; EXTERNAL_GUEST role preserved (would otherwise be
        // bumped from VIEWER → MEMBER by Clerk's role mapping).
        const preservedRole =
          pendingByEmail.role === 'OWNER'
            ? 'OWNER'
            : pendingByEmail.memberType === 'EXTERNAL_GUEST'
              ? pendingByEmail.role
              : role;
        // Don't wipe values supplied at invite time: a brand-new Clerk user often
        // has null first_name/last_name and image_url at this webhook moment, but
        // the admin already entered a name (and possibly avatar) when sending the
        // invite. Prefer Clerk's values only when they're actually populated.
        console.log(`[Clerk Webhook] Activating invitation member ${pendingByEmail.id} (email: ${email}) for user ${userId} (role: ${preservedRole}, memberType: ${pendingByEmail.memberType})`);
        await tenantDb
          .update(workspaceMembers)
          .set({
            userId,
            name: name ?? pendingByEmail.name,
            picture: picture ?? pendingByEmail.picture,
            role: preservedRole,
            status: 'ACTIVE',
            clerkMembershipId: membership.id,
            acceptedAt: pendingByEmail.acceptedAt ?? new Date(),
            updatedAt: new Date(),
          })
          .where(eq(workspaceMembers.id, pendingByEmail.id));
        activatedMemberType = pendingByEmail.memberType;
      } else {
        // First-member rule: if there are no other active members, this is the
        // org creator and must be OWNER — Clerk's role mapping tops out at ADMIN.
        const [{ count: memberCount }] = await tenantDb
          .select({ count: sql<number>`count(*)::int` })
          .from(workspaceMembers)
          .where(isNull(workspaceMembers.deletedAt));
        const insertRole = memberCount === 0 ? 'OWNER' : role;
        console.log(`[Clerk Webhook] No existing member found for user ${userId} / email ${email}, creating new ACTIVE member (role: ${insertRole}, existingCount: ${memberCount})`);
        await tenantDb.insert(workspaceMembers).values({
          id: generateId('mbr'),
          userId, email, name, picture, role: insertRole,
          status: 'ACTIVE',
          clerkMembershipId: membership.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        // Fresh insert uses the column default (`INTERNAL`).
        activatedMemberType = 'INTERNAL';
      }
    }
    console.log(`[Clerk Webhook] Tenant DB updated for membership ${membership.id}`);

    if (activatedMemberType) {
      try {
        const joined = await autoJoinUserToPublicChannels(tenantDb, userId, activatedMemberType);
        if (joined.length > 0) {
          console.log(`[Clerk Webhook] Auto-joined user ${userId} to ${joined.length} public channel(s) in org ${clerkOrgId}`);
        }
      } catch (e) {
        console.error('[Clerk Webhook] Failed to auto-join user to public channels:', e);
      }
    }
  } catch (error) {
    console.error(`[Clerk Webhook] Could not update tenant DB for org ${clerkOrgId}:`, error);
  }
}

async function handleMembershipUpdated(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  membership: ClerkOrganizationMembership,
) {
  const clerkOrgId = membership.organization.id;
  const userId = membership.public_user_data.user_id;

  const masterWorkspaceId = await getWorkspaceIdFromClerkOrg(masterDb, clerkOrgId);

  // Resolve the tenant member up-front. The tenant row is authoritative for the
  // OWNER tier — master `user_workspaces` has no owner concept (owners are just
  // `org:admin`), so without this a Clerk role-sync carrying a non-admin role
  // (e.g. a custom `org:*_role`) would silently downgrade the owner in master.
  // Best-effort: if the tenant DB is unreachable we fall back to the raw role.
  let tenantDb: Awaited<ReturnType<typeof getTenantDbForWorkspace>> | null = null;
  let existing: typeof workspaceMembers.$inferSelect | undefined;
  try {
    tenantDb = await getTenantDbForWorkspace(env, clerkOrgId);
    [existing] = await tenantDb
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)));
  } catch (error) {
    console.warn(`[Clerk Webhook] Could not read tenant DB for org ${clerkOrgId}:`, error);
  }

  const isTenantOwner = existing?.role === 'OWNER';

  if (masterWorkspaceId) {
    // Never let a Clerk sync downgrade the workspace owner — pin them to admin.
    const masterRole = isTenantOwner ? 'org:admin' : membership.role;
    await masterDb
      .update(userWorkspaces)
      .set({ role: masterRole, updatedAt: new Date() })
      .where(and(eq(userWorkspaces.userId, userId), eq(userWorkspaces.workspaceId, masterWorkspaceId)));
  }

  if (!masterWorkspaceId || !tenantDb) return;

  try {
    const role = mapClerkRoleToDisplay(membership.role);
    const name = [membership.public_user_data.first_name, membership.public_user_data.last_name]
      .filter(Boolean).join(' ') || null;
    const picture = membership.public_user_data.image_url;

    if (existing) {
      // Don't downgrade OWNER on Clerk role-sync events.
      const preservedRole = isTenantOwner ? 'OWNER' : role;
      await tenantDb
        .update(workspaceMembers)
        .set({ role: preservedRole, name, picture, clerkMembershipId: membership.id, updatedAt: new Date() })
        .where(eq(workspaceMembers.id, existing.id));
      // TODO: if a future Clerk metadata flow propagates a custom `roleId`,
      // call applyRoleChangeToChannels(tenantDb, userId, oldRoleId, newRoleId)
      // here so weldchat membership stays in sync. Today only the system
      // tier syncs via webhook, so no action is needed.
    } else {
      await handleMembershipCreated(env, masterDb, membership);
    }
  } catch (error) {
    console.warn(`[Clerk Webhook] Could not update tenant DB for org ${clerkOrgId}:`, error);
  }
}

async function handleMembershipDeleted(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  membership: ClerkOrganizationMembership,
) {
  const clerkOrgId = membership.organization.id;
  const userId = membership.public_user_data.user_id;

  const masterWorkspaceId = await getWorkspaceIdFromClerkOrg(masterDb, clerkOrgId);
  if (masterWorkspaceId) {
    await masterDb
      .delete(userWorkspaces)
      .where(and(eq(userWorkspaces.userId, userId), eq(userWorkspaces.workspaceId, masterWorkspaceId)));
  }

  try {
    const tenantDb = await getTenantDbForWorkspace(env, clerkOrgId);
    if (!masterWorkspaceId) return;

    await tenantDb
      .update(workspaceMembers)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)));
  } catch (error) {
    console.warn(`[Clerk Webhook] Could not update tenant DB for org ${clerkOrgId}:`, error);
  }
}

// ============================================================================
// INVITATION HANDLERS
// ============================================================================

async function handleInvitationCreated(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  invitation: ClerkOrganizationInvitation,
) {
  const clerkOrgId = invitation.organization_id;

  try {
    const tenantDb = await getTenantDbForWorkspace(env, clerkOrgId);
    const email = invitation.email_address;
    const role = mapClerkRoleToDisplay(invitation.role);

    // Match an existing invitation row by email regardless of which path
    // inserted it: the api-worker invite endpoint uses `userId='invited_<email>'`
    // and a previous run of this handler used `userId='pending_clerk_<inv>'`.
    // We attach the clerkInvitationId to whichever row already exists; we only
    // insert a new row if nothing matches.
    const [existing] = await tenantDb
      .select()
      .from(workspaceMembers)
      .where(and(
        sql`lower(${workspaceMembers.email}) = lower(${email})`,
        or(
          eq(workspaceMembers.status, 'PENDING'),
          sql`${workspaceMembers.userId} LIKE 'pending_clerk_%'`,
          sql`${workspaceMembers.userId} LIKE 'invited_%'`,
        ),
        isNull(workspaceMembers.deletedAt),
      ));

    if (existing) {
      await tenantDb
        .update(workspaceMembers)
        .set({ role, clerkInvitationId: invitation.id, invitedAt: new Date(invitation.created_at), updatedAt: new Date() })
        .where(eq(workspaceMembers.id, existing.id));
    } else {
      await tenantDb.insert(workspaceMembers).values({
        id: generateId('mbr'),
        userId: `pending_clerk_${invitation.id}`,
        email, role,
        status: 'PENDING',
        clerkInvitationId: invitation.id,
        invitedAt: new Date(invitation.created_at),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  } catch (error) {
    console.warn('[Clerk Webhook] Could not create invitation in tenant DB:', error);
  }

  // Send our own invitation email via Resend (Clerk's built-in template is
  // disabled). Failures must never propagate — Clerk would otherwise retry
  // the webhook and double-write the DB row above.
  await sendInvitationEmail(env, invitation);
}

async function sendInvitationEmail(env: Env, invitation: ClerkOrganizationInvitation) {
  if (!env.RESEND_API_KEY || !env.RESEND_WORKSPACE_INVITATION_TEMPLATE_ID) {
    console.warn('[Clerk Webhook] Skipping invitation email: RESEND_API_KEY or RESEND_WORKSPACE_INVITATION_TEMPLATE_ID not configured');
    return;
  }

  try {
    const clerkHeaders = {
      Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    };

    // Re-fetch the invitation to get the `url` field (the Clerk-hosted accept
    // ticket URL). It is not included on the webhook payload.
    const invResp = await fetch(
      `https://api.clerk.com/v1/organizations/${invitation.organization_id}/invitations/${invitation.id}`,
      { headers: clerkHeaders },
    );
    const invData = invResp.ok
      ? (await invResp.json()) as { url?: string | null }
      : null;
    const acceptUrl = invData?.url || `${env.APP_URL || 'https://app.weldsuite.org'}/invite`;

    // Org name — used as the workspace display name in the email.
    let workspaceName = 'a WeldSuite workspace';
    const orgResp = await fetch(
      `https://api.clerk.com/v1/organizations/${invitation.organization_id}`,
      { headers: clerkHeaders },
    );
    if (orgResp.ok) {
      const org = await orgResp.json() as { name?: string };
      if (org.name) workspaceName = org.name;
    }

    // Inviter — only fetch if the payload includes inviter_user_id.
    let inviterName = 'A teammate';
    let inviterEmail: string | undefined;
    if (invitation.inviter_user_id) {
      const userResp = await fetch(
        `https://api.clerk.com/v1/users/${invitation.inviter_user_id}`,
        { headers: clerkHeaders },
      );
      if (userResp.ok) {
        const user = await userResp.json() as {
          first_name?: string | null;
          last_name?: string | null;
          email_addresses?: Array<{ email_address: string; id: string }>;
          primary_email_address_id?: string | null;
        };
        const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
        const primary = user.email_addresses?.find((e) => e.id === user.primary_email_address_id)
          ?? user.email_addresses?.[0];
        inviterEmail = primary?.email_address;
        inviterName = fullName || inviterEmail || inviterName;
      }
    }

    const role = mapClerkRoleToDisplay(invitation.role);

    await sendTemplateEmail(env.RESEND_API_KEY, {
      from: 'WeldSuite <notifications@mail.weldsuite.org>',
      to: [invitation.email_address],
      template: {
        id: env.RESEND_WORKSPACE_INVITATION_TEMPLATE_ID,
        variables: {
          INVITER_NAME: inviterName,
          INVITER_EMAIL: inviterEmail ?? '',
          WORKSPACE_NAME: workspaceName,
          ROLE: role,
          ACCEPT_URL: acceptUrl,
          RECIPIENT_EMAIL: invitation.email_address,
        },
      },
    });
  } catch (error) {
    console.error('[Clerk Webhook] Failed to send invitation email:', error);
  }
}

async function handleInvitationAccepted(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  invitation: ClerkOrganizationInvitation,
) {
  const clerkOrgId = invitation.organization_id;

  try {
    const tenantDb = await getTenantDbForWorkspace(env, clerkOrgId);

    const [pending] = await tenantDb
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.clerkInvitationId, invitation.id), isNull(workspaceMembers.deletedAt)));

    if (!pending) {
      console.log(`[Clerk Webhook] No pending member found for invitation ${invitation.id}`);
      return;
    }

    // If membership.created already raced ahead and inserted a separate ACTIVE
    // row for this user, merge its real userId/name/picture/clerkMembershipId
    // back onto the invitation row and soft-delete the duplicate.
    const [duplicate] = invitation.email_address
      ? await tenantDb
          .select()
          .from(workspaceMembers)
          .where(and(
            sql`lower(${workspaceMembers.email}) = lower(${invitation.email_address})`,
            eq(workspaceMembers.status, 'ACTIVE'),
            ne(workspaceMembers.id, pending.id),
            sql`${workspaceMembers.userId} NOT LIKE 'pending_clerk_%'`,
            sql`${workspaceMembers.userId} NOT LIKE 'invited_%'`,
            isNull(workspaceMembers.deletedAt),
          ))
      : [];

    if (duplicate) {
      console.log(`[Clerk Webhook] Merging duplicate ACTIVE member ${duplicate.id} into invitation member ${pending.id} for invitation ${invitation.id}`);
      const preservedRole = pending.role === 'OWNER' || duplicate.role === 'OWNER' ? 'OWNER' : (duplicate.role ?? pending.role);
      await tenantDb
        .update(workspaceMembers)
        .set({
          userId: duplicate.userId,
          name: duplicate.name ?? pending.name,
          picture: duplicate.picture ?? pending.picture,
          email: duplicate.email ?? pending.email,
          role: preservedRole,
          clerkMembershipId: duplicate.clerkMembershipId ?? pending.clerkMembershipId,
          status: 'ACTIVE',
          acceptedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(workspaceMembers.id, pending.id));
      await tenantDb
        .update(workspaceMembers)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(workspaceMembers.id, duplicate.id));
    } else {
      console.log(`[Clerk Webhook] Invitation ${invitation.id} accepted, updating member ${pending.id} to ACTIVE`);
      await tenantDb
        .update(workspaceMembers)
        .set({ status: 'ACTIVE', acceptedAt: new Date(), updatedAt: new Date() })
        .where(eq(workspaceMembers.id, pending.id));
    }

    // Fan the now-ACTIVE member into every public weldchat channel.
    // pending.userId may still be a `pending_clerk_*` placeholder if the
    // membership.created webhook hasn't arrived yet — in that case the join
    // is wired by handleMembershipCreated instead. Only act when we have a
    // real Clerk user id (one with the `user_` prefix that Clerk emits).
    const realUserId = duplicate?.userId ?? pending.userId;
    if (realUserId && !realUserId.startsWith('pending_clerk_') && !realUserId.startsWith('invited_')) {
      try {
        const joined = await autoJoinUserToPublicChannels(tenantDb, realUserId, pending.memberType);
        if (joined.length > 0) {
          console.log(`[Clerk Webhook] Auto-joined user ${realUserId} to ${joined.length} public channel(s) in org ${clerkOrgId}`);
        }
      } catch (e) {
        console.error('[Clerk Webhook] Failed to auto-join user to public channels:', e);
      }
    }
  } catch (error) {
    console.error('[Clerk Webhook] Could not update invitation in tenant DB:', error);
  }
}

async function handleInvitationRevoked(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  invitation: ClerkOrganizationInvitation,
) {
  const clerkOrgId = invitation.organization_id;

  try {
    const tenantDb = await getTenantDbForWorkspace(env, clerkOrgId);

    await tenantDb
      .update(workspaceMembers)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(workspaceMembers.clerkInvitationId, invitation.id),
        eq(workspaceMembers.status, 'PENDING'),
        isNull(workspaceMembers.deletedAt),
      ));
  } catch (error) {
    console.warn('[Clerk Webhook] Could not revoke invitation in tenant DB:', error);
  }
}

// ============================================================================
// USER HANDLERS
// ============================================================================

async function handleUserCreated(
  masterDb: ReturnType<typeof getMasterDb>,
  userData: ClerkUserData,
) {
  const primaryEmail = userData.email_addresses.find(
    (e) => e.id === userData.primary_email_address_id,
  )?.email_address || userData.email_addresses[0]?.email_address;

  try {
    await masterDb.insert(users).values({
      id: userData.id,
      email: primaryEmail || '',
      firstName: userData.first_name,
      lastName: userData.last_name,
      imageUrl: userData.image_url,
    }).onConflictDoNothing();
  } catch (error) {
    console.error('[Clerk Webhook] Error creating user:', error);
  }
}

async function handleUserUpdated(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  userData: ClerkUserData,
) {
  const userId = userData.id;
  const fullName = [userData.first_name, userData.last_name].filter(Boolean).join(' ');
  const imageUrl = userData.image_url;
  const primaryEmail = userData.email_addresses.find(
    (e) => e.id === userData.primary_email_address_id,
  )?.email_address || userData.email_addresses[0]?.email_address;

  try {
    await masterDb
      .update(users)
      .set({
        email: primaryEmail || undefined,
        firstName: userData.first_name,
        lastName: userData.last_name,
        imageUrl: userData.image_url,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    const memberships = await masterDb
      .select({ workspaceId: userWorkspaces.workspaceId })
      .from(userWorkspaces)
      .where(eq(userWorkspaces.userId, userId));

    for (const membership of memberships) {
      try {
        const [workspace] = await masterDb
          .select({ clerkOrgId: workspaces.clerkOrgId })
          .from(workspaces)
          .where(eq(workspaces.id, membership.workspaceId));

        if (workspace?.clerkOrgId) {
          const tenantDb = await getTenantDbForWorkspace(env, workspace.clerkOrgId);
          // Only overwrite name/picture when Clerk has actual values. user.updated
          // fires multiple times during signup/onboarding — early events have
          // empty first_name/last_name and would wipe the name typed at invite time.
          const updates: Record<string, unknown> = { updatedAt: new Date() };
          if (fullName) updates.name = fullName;
          if (imageUrl) updates.picture = imageUrl;
          await tenantDb
            .update(workspaceMembers)
            .set(updates)
            .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)));
        }
      } catch { continue; }
    }
  } catch (error) {
    console.error('[Clerk Webhook] Error syncing user update:', error);
  }
}

async function handleUserDeleted(
  env: Env,
  masterDb: ReturnType<typeof getMasterDb>,
  userData: ClerkUserData,
) {
  const userId = userData.id;

  try {
    const memberships = await masterDb
      .select({ workspaceId: userWorkspaces.workspaceId })
      .from(userWorkspaces)
      .where(eq(userWorkspaces.userId, userId));

    await masterDb
      .update(users)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(users.id, userId));

    await masterDb
      .delete(userWorkspaces)
      .where(eq(userWorkspaces.userId, userId));

    for (const membership of memberships) {
      try {
        const [workspace] = await masterDb
          .select({ clerkOrgId: workspaces.clerkOrgId })
          .from(workspaces)
          .where(eq(workspaces.id, membership.workspaceId));

        if (workspace?.clerkOrgId) {
          const tenantDb = await getTenantDbForWorkspace(env, workspace.clerkOrgId);
          await tenantDb
            .update(workspaceMembers)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(workspaceMembers.userId, userId), isNull(workspaceMembers.deletedAt)));
        }
      } catch { continue; }
    }
  } catch (error) {
    console.error('[Clerk Webhook] Error handling user.deleted:', error);
    throw error;
  }
}
