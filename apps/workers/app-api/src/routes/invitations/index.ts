/**
 * Invitations — /api/invitations/*.
 *
 * Handles invitation lookup and acceptance. Ported from api-worker
 * `src/routes/invitations.ts` (W3 legacy-worker phase-out).
 *
 *   GET  /:token  — invitation details (Clerk invitation id)
 *   POST /accept  — sync Clerk memberships → activate PENDING tenant member
 *
 * IMPORTANT — middleware: users accepting invitations may not have an active
 * org yet, so this router must NOT go through the workspace-DB middleware.
 * Like `onboarding` it applies `clerkMiddleware()` itself and must be mounted
 * on the root app BEFORE the global
 * `app.use('/api/*', clerkMiddleware(), workspaceDbMiddleware(), ...)` guard.
 *
 * Permissions: none beyond Clerk auth — the caller may hold no workspace
 * permissions yet (mirrors the api-worker original). All tenant lookups are
 * scoped to orgs the CALLER is a member of per Clerk, so no cross-tenant
 * reads are possible beyond the invitation row addressed by its token.
 *
 * Entity events: no `workspace_member` entity type exists in the
 * @weldsuite/entity-events catalog, so no events are published (matches the
 * api-worker original).
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import type { Env, Variables } from '../../types';
import { clerkMiddleware } from '@weldsuite/worker-kit/middleware/clerk';
import { schema, getMasterDb, masterSchema, getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import { success, error } from '@weldsuite/worker-kit/response';
import { autoJoinUserToPublicChannels } from '@weldsuite/chat-domain/weldchat-auto-join';
import { applyRoleChangeToChannels } from '@weldsuite/chat-domain/weldchat-role-links';
import {
  publishChatMemberJoined,
  publishChatUserChannelNew,
} from '@weldsuite/chat-domain/realtime/weldchat-publisher';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', clerkMiddleware());

type TenantDb = Awaited<ReturnType<typeof getTenantDbForWorkspace>>;
type MasterDb = ReturnType<typeof getMasterDb>;
type WorkspaceMemberRow = typeof schema.workspaceMembers.$inferSelect;

/** Clerk org role → tenant workspace role. */
const CLERK_ROLE_MAP: Record<string, string> = {
  'org:admin': 'ADMIN',
  'org:member': 'MEMBER',
};

interface InvitationDetails {
  workspaceId: string;
  workspaceName: string;
  role: string;
  inviteeEmail: string;
  inviteeName: string;
  isExpired: boolean;
  isUsed: boolean;
  expiresAt?: string;
}

interface ClerkOrgMembership {
  id: string;
  organization: { id: string; name: string; slug: string };
  role: string;
  public_user_data: { identifier: string; first_name: string | null; last_name: string | null; image_url: string | null };
}

interface AcceptedInvitation {
  org: { id: string; name: string };
  role: string;
}

/** Details of the invitation `token` inside one Clerk org; null when it is not in that org. */
async function lookupClerkOrgInvitation(
  env: Env,
  masterDb: MasterDb,
  org: { id: string; name: string },
  token: string,
): Promise<InvitationDetails | null> {
  try {
    const invResp = await fetch(`https://api.clerk.com/v1/organizations/${org.id}/invitations/${token}`, {
      headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
    });
    if (!invResp.ok) return null;

    const invitation = await invResp.json() as {
      id: string;
      email_address: string;
      role: string;
      status: string;
      created_at: number;
      expires_at?: number;
    };

    // Get workspace name from master DB
    const [workspace] = await masterDb
      .select({ id: masterSchema.workspaces.id, name: masterSchema.workspaces.name })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, org.id))
      .limit(1);

    return {
      workspaceId: org.id,
      workspaceName: workspace?.name || org.name,
      role: invitation.role,
      inviteeEmail: invitation.email_address,
      inviteeName: '',
      isExpired: invitation.expires_at ? new Date(invitation.expires_at) < new Date() : false,
      isUsed: invitation.status === 'accepted' || invitation.status === 'revoked',
      expiresAt: invitation.expires_at ? new Date(invitation.expires_at).toISOString() : undefined,
    };
  } catch {
    // Invitation not in this org, continue
    return null;
  }
}

/**
 * Strategy: Use Clerk API to get the user's org memberships, then check each
 * org for the invitation ID.
 */
async function findInvitationViaClerk(
  env: Env,
  masterDb: MasterDb,
  userId: string,
  token: string,
): Promise<InvitationDetails | null> {
  const userResp = await fetch(`https://api.clerk.com/v1/users/${userId}/organization_memberships?limit=100`, {
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
  });
  if (!userResp.ok) return null;

  const memberships = await userResp.json() as { data: Array<{ organization: { id: string; name: string; slug: string; image_url: string | null }; role: string }> };

  for (const membership of memberships.data || []) {
    const details = await lookupClerkOrgInvitation(env, masterDb, membership.organization, token);
    if (details) return details;
  }
  return null;
}

/** Fallback: search tenant DBs for this invitation. */
async function findInvitationInTenantDbs(
  env: Env,
  masterDb: MasterDb,
  token: string,
): Promise<InvitationDetails | null> {
  const allWorkspaces = await masterDb
    .select({
      id: masterSchema.workspaces.id,
      name: masterSchema.workspaces.name,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
    })
    .from(masterSchema.workspaces)
    .where(eq(masterSchema.workspaces.isActive, true))
    .limit(50);

  for (const workspace of allWorkspaces) {
    if (!workspace.clerkOrgId) continue;

    try {
      const tenantDb = await getTenantDbForWorkspace(env, workspace.clerkOrgId);
      const [member] = await tenantDb
        .select()
        .from(schema.workspaceMembers)
        .where(and(
          eq(schema.workspaceMembers.clerkInvitationId, token),
          isNull(schema.workspaceMembers.deletedAt),
        ))
        .limit(1);

      if (member) {
        return {
          workspaceId: workspace.clerkOrgId,
          workspaceName: workspace.name,
          role: member.role,
          inviteeEmail: member.email ?? '',
          inviteeName: member.name ?? '',
          isExpired: false,
          isUsed: member.status === 'ACTIVE',
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** The user's current Clerk org memberships; null when Clerk cannot be reached. */
async function fetchUserMemberships(env: Env, userId: string): Promise<ClerkOrgMembership[] | null> {
  const membershipsResp = await fetch(
    `https://api.clerk.com/v1/users/${userId}/organization_memberships?limit=100`,
    { headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` } },
  );

  if (!membershipsResp.ok) {
    console.error('[app-api/invitations] Failed to fetch user memberships from Clerk');
    return null;
  }

  const memberships = await membershipsResp.json() as { data: ClerkOrgMembership[] };
  return memberships.data || [];
}

/**
 * The PENDING member row this invitation refers to: by invitation ID first,
 * then by email (case-insensitive). Same broadened OR clause as the
 * workspace-worker webhook so the two paths agree on which row is "the
 * pending one" — otherwise the loser of the race creates a duplicate.
 */
async function findPendingMember(
  tenantDb: TenantDb,
  token: string,
  email: string,
): Promise<WorkspaceMemberRow | undefined> {
  const [byInvitation] = await tenantDb
    .select()
    .from(schema.workspaceMembers)
    .where(and(
      eq(schema.workspaceMembers.clerkInvitationId, token),
      eq(schema.workspaceMembers.status, 'PENDING'),
      isNull(schema.workspaceMembers.deletedAt),
    ))
    .limit(1);
  if (byInvitation) return byInvitation;

  const [byEmail] = await tenantDb
    .select()
    .from(schema.workspaceMembers)
    .where(and(
      sql`lower(${schema.workspaceMembers.email}) = lower(${email})`,
      or(
        eq(schema.workspaceMembers.status, 'PENDING'),
        sql`${schema.workspaceMembers.userId} LIKE 'invited_%'`,
        sql`${schema.workspaceMembers.userId} LIKE 'pending_clerk_%'`,
      ),
      isNull(schema.workspaceMembers.deletedAt),
    ))
    .limit(1);
  return byEmail;
}

/** Update PENDING → ACTIVE and drop the cached memberType. */
async function activatePendingMember(
  env: Env,
  tenantDb: TenantDb,
  orgId: string,
  userId: string,
  membership: ClerkOrgMembership,
  pending: WorkspaceMemberRow,
): Promise<void> {
  const name = [membership.public_user_data.first_name, membership.public_user_data.last_name]
    .filter(Boolean).join(' ') || null;
  const picture = membership.public_user_data.image_url;

  // Guests and EMPLOYEE members stay on VIEWER regardless of Clerk role —
  // guests are gated by per-channel membership and EMPLOYEE members by their
  // fixed permission set, not by role. memberType itself is on the row
  // already (set at invite time) and is intentionally not in the SET clause.
  const keepsInvitedRole = pending.memberType === 'EXTERNAL_GUEST' || pending.memberType === 'EMPLOYEE';
  const resolvedRole = keepsInvitedRole
    ? (pending.role || 'VIEWER')
    : (CLERK_ROLE_MAP[membership.role] || pending.role || 'MEMBER');

  await tenantDb
    .update(schema.workspaceMembers)
    .set({
      userId,
      name,
      picture,
      role: resolvedRole,
      status: 'ACTIVE',
      clerkMembershipId: membership.id,
      acceptedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.workspaceMembers.id, pending.id));

  // Invalidate the memberType cache so the next request reads the
  // freshly activated row instead of a stale (or missing) value.
  await env.WORKSPACE_CACHE.delete(`member-type:${orgId}:${userId}`).catch(() => {});
}

/** Join the freshly activated member to the workspace's public channels (non-fatal). */
async function joinPublicChannels(
  env: Env,
  tenantDb: TenantDb,
  orgId: string,
  userId: string,
  memberType: WorkspaceMemberRow['memberType'],
): Promise<void> {
  try {
    const joined = await autoJoinUserToPublicChannels(tenantDb, userId, memberType);
    await Promise.all(
      joined.map(async (ch) => {
        try {
          await publishChatUserChannelNew(env, orgId, userId, ch.id, ch.name);
        } catch (e) {
          console.error('[app-api/invitations] Realtime publish failed:', e);
        }
      }),
    );
  } catch (e) {
    console.error('[app-api/invitations] Failed to auto-join public channels:', e);
  }
}

type ChannelChange = Awaited<ReturnType<typeof applyRoleChangeToChannels>>['added'][number];

async function publishRoleChannelJoin(
  env: Env,
  orgId: string,
  change: ChannelChange,
  userId: string,
): Promise<void> {
  try {
    await publishChatMemberJoined(env, change.channelId, {
      channelId: change.channelId,
      userId,
    });
    await publishChatUserChannelNew(
      env,
      orgId,
      userId,
      change.channelId,
      change.channelName,
    );
  } catch (e) {
    console.error('[app-api/invitations] Role-channel publish failed:', e);
  }
}

/**
 * Apply the role-driven channel memberships for a pending member that already
 * has a custom workspace role. Today this is a no-op because invitations don't
 * carry `roleId`, but wiring it now means future invitation-with-role flows
 * pick up channel membership without further changes.
 */
async function applyRoleChannels(
  env: Env,
  tenantDb: TenantDb,
  orgId: string,
  userId: string,
  roleId: string,
): Promise<void> {
  try {
    const changes = await applyRoleChangeToChannels(tenantDb, userId, null, roleId);
    await Promise.all(
      changes.added.flatMap((change) =>
        change.userIds.map((uid) => publishRoleChannelJoin(env, orgId, change, uid)),
      ),
    );
  } catch (e) {
    console.error('[app-api/invitations] Failed to apply role-driven channels:', e);
  }
}

/**
 * If this org has a PENDING member matching the invitation or the user's
 * email, activate it and wire up channels. Null when there is nothing to
 * accept in this org (or the org could not be checked).
 */
async function acceptPendingInOrg(
  env: Env,
  masterDb: MasterDb,
  membership: ClerkOrgMembership,
  userId: string,
  token: string,
): Promise<AcceptedInvitation | null> {
  const orgId = membership.organization.id;

  try {
    const tenantDb = await getTenantDbForWorkspace(env, orgId);
    const pending = await findPendingMember(tenantDb, token, membership.public_user_data.identifier);
    if (!pending) return null;

    await activatePendingMember(env, tenantDb, orgId, userId, membership, pending);
    await joinPublicChannels(env, tenantDb, orgId, userId, pending.memberType);
    if (pending.roleId) await applyRoleChannels(env, tenantDb, orgId, userId, pending.roleId);

    // Get workspace name
    const [workspace] = await masterDb
      .select({ name: masterSchema.workspaces.name })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
      .limit(1);

    return {
      org: { id: orgId, name: workspace?.name || membership.organization.name },
      role: CLERK_ROLE_MAP[membership.role] || pending.role || 'MEMBER',
    };
  } catch (err) {
    console.warn(`[app-api/invitations] Error checking org ${orgId}:`, err);
    return null;
  }
}

/** First of the user's orgs that exists as a workspace (they may already be an active member). */
async function findExistingWorkspace(
  masterDb: MasterDb,
  memberships: ClerkOrgMembership[],
): Promise<AcceptedInvitation | null> {
  for (const membership of memberships) {
    const [workspace] = await masterDb
      .select({ name: masterSchema.workspaces.name })
      .from(masterSchema.workspaces)
      .where(eq(masterSchema.workspaces.clerkOrgId, membership.organization.id))
      .limit(1);

    if (workspace) {
      return {
        org: { id: membership.organization.id, name: workspace.name },
        role: CLERK_ROLE_MAP[membership.role] || 'MEMBER',
      };
    }
  }
  return null;
}

/**
 * GET /:token - Get invitation details
 *
 * Looks up an invitation by Clerk invitation ID.
 * Requires authentication to look up the invitee's pending invitations.
 */
app.get('/:token', async (c) => {
  const token = c.req.param('token');
  const userId = c.get('userId');

  if (!token) {
    return error.badRequest(c, 'Invitation token is required');
  }

  try {
    const masterDb = getMasterDb(c.env);

    const viaClerk = await findInvitationViaClerk(c.env, masterDb, userId, token);
    if (viaClerk) return success(c, viaClerk);

    const viaTenantDbs = await findInvitationInTenantDbs(c.env, masterDb, token);
    if (viaTenantDbs) return success(c, viaTenantDbs);

    return error.notFound(c, 'Invitation');
  } catch (err) {
    console.error('[app-api/invitations] Error fetching invitation details:', err);
    return error.internal(c, 'Failed to fetch invitation details');
  }
});

/**
 * POST /accept - Accept an invitation
 *
 * Syncs the user's Clerk org memberships to the tenant DB,
 * ensuring PENDING members are activated.
 */
app.post('/accept', zValidator('json', z.object({
  token: z.string().min(1),
})), async (c) => {
  const userId = c.get('userId');
  const { token } = c.req.valid('json');

  try {
    const masterDb = getMasterDb(c.env);

    // Get the user's current org memberships from Clerk
    const memberships = await fetchUserMemberships(c.env, userId);
    if (!memberships) return error.internal(c, 'Failed to verify membership');

    // Find the membership that matches this invitation
    // Try each org to find where this invitation belongs
    let matched: AcceptedInvitation | null = null;
    for (const membership of memberships) {
      matched = await acceptPendingInOrg(c.env, masterDb, membership, userId, token);
      if (matched) break;
    }

    // No PENDING member found - user might already be active or invitation not found
    // Check if user is already an active member in any org
    matched ??= await findExistingWorkspace(masterDb, memberships);

    if (!matched) {
      return error.notFound(c, 'Invitation');
    }

    return success(c, {
      workspaceId: matched.org.id,
      workspaceName: matched.org.name,
      role: matched.role,
    });
  } catch (err) {
    console.error('[app-api/invitations] Error accepting invitation:', err);
    return error.internal(c, 'Failed to accept invitation');
  }
});

export const invitationsRoutes = app;
