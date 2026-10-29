/**
 * Linking a Clerk user to their invited workspace_members row.
 *
 * An invitation creates a placeholder row (`userId` = `invited_<email>` or
 * `pending_clerk_<invitation>`). Accepting it in Clerk must swap in the real
 * Clerk user id: the clerk webhook (workspace-worker) does that on
 * `organizationMembership.created`, and POST /api/invitations/accept does it
 * too. If both miss — a failed or dropped webhook, the platform's invite page
 * accepts through Clerk directly and never calls /accept — the row stays on
 * its placeholder. `invitation.accepted` still flips it to ACTIVE, so the
 * member shows up in Settings with the right role, yet every lookup by user
 * id finds nothing: no permissions, no apps, and the app-access guard sends
 * them back to the home page on every app they open.
 *
 * `ensureMemberLinked` closes that gap from the API side: the caller's token
 * says Clerk has them in this org, so a missing row is always a sync miss,
 * and it is repaired on the spot.
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { schema, type getTenantDbForWorkspace } from '@weldsuite/worker-kit/db';
import { releaseRemovedMemberUserId } from '@weldsuite/db/lib/workspace-members';
import { bumpPermissionsVersion } from '@weldsuite/db/lib/permissions-cache';
import { autoJoinUserToPublicChannels } from '@weldsuite/chat-domain/weldchat-auto-join';
import { applyRoleChangeToChannels } from '@weldsuite/chat-domain/weldchat-role-links';
import {
  publishChatMemberJoined,
  publishChatUserChannelNew,
} from '@weldsuite/chat-domain/realtime/weldchat-publisher';
import type { Env } from '../types';

type TenantDb = Awaited<ReturnType<typeof getTenantDbForWorkspace>>;
type WorkspaceMemberRow = typeof schema.workspaceMembers.$inferSelect;

/** Clerk org role → tenant workspace role. */
export const CLERK_ROLE_MAP: Record<string, string> = {
  'org:admin': 'ADMIN',
  'org:member': 'MEMBER',
};

export interface ClerkOrgMembership {
  id: string;
  organization: { id: string; name: string; slug: string };
  role: string;
  public_user_data: { identifier: string; first_name: string | null; last_name: string | null; image_url: string | null };
}

/** How long a Clerk lookup may hold up the request that triggered it. */
const CLERK_TIMEOUT_MS = 5_000;

/** How long a caller with nothing to link skips the Clerk lookup (KV's minimum TTL is 60s). */
const LINK_MISS_TTL_SECONDS = 300;

function linkMissKey(orgId: string, userId: string): string {
  return `member-link-miss:${orgId}:${userId}`;
}

/** The user's current Clerk org memberships; null when Clerk cannot be reached. */
export async function fetchUserMemberships(env: Env, userId: string): Promise<ClerkOrgMembership[] | null> {
  let membershipsResp: Response;
  try {
    membershipsResp = await fetch(
      `https://api.clerk.com/v1/users/${userId}/organization_memberships?limit=100`,
      {
        headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
        signal: AbortSignal.timeout(CLERK_TIMEOUT_MS),
      },
    );
  } catch (err) {
    console.error('[app-api/member-link] Clerk memberships request failed:', err);
    return null;
  }

  if (!membershipsResp.ok) {
    console.error('[app-api/member-link] Failed to fetch user memberships from Clerk');
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
  token: string | null,
  email: string,
): Promise<WorkspaceMemberRow | undefined> {
  if (token) {
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
  }

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

/**
 * Move the placeholder row onto the real user and make it ACTIVE, then drop
 * the cached memberType. The update only applies while the row still holds
 * the userId it was read with, so two requests racing to link the same
 * member activate it once. Returns whether this call did the update.
 *
 * `workspaceId` (`workspaces.id`) is optional only because a couple of call
 * sites still scan multiple orgs without it resolved yet; when given, the
 * permission cache is bumped so this member's first resolution (previously
 * either absent or a cached "no member") isn't served stale.
 */
async function activatePendingMember(
  env: Env,
  tenantDb: TenantDb,
  orgId: string,
  userId: string,
  membership: ClerkOrgMembership,
  pending: WorkspaceMemberRow,
  workspaceId?: string,
): Promise<boolean> {
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

  // A returning member's removed row still holds their user id.
  await releaseRemovedMemberUserId(tenantDb, userId);
  const updated = await tenantDb
    .update(schema.workspaceMembers)
    .set({
      userId,
      // Keep the name/avatar entered at invite time when Clerk has none yet.
      name: name ?? pending.name,
      picture: picture ?? pending.picture,
      role: resolvedRole as WorkspaceMemberRow['role'],
      status: 'ACTIVE',
      clerkMembershipId: membership.id,
      acceptedAt: pending.acceptedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.workspaceMembers.id, pending.id),
      eq(schema.workspaceMembers.userId, pending.userId),
    ))
    .returning({ id: schema.workspaceMembers.id });

  // Invalidate the memberType cache so the next request reads the
  // freshly activated row instead of a stale (or missing) value.
  await env.WORKSPACE_CACHE.delete(`member-type:${orgId}:${userId}`).catch(() => {});
  const didUpdate = updated.length > 0;
  if (didUpdate && workspaceId) await bumpPermissionsVersion(env, workspaceId);
  return didUpdate;
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
          console.error('[app-api/member-link] Realtime publish failed:', e);
        }
      }),
    );
  } catch (e) {
    console.error('[app-api/member-link] Failed to auto-join public channels:', e);
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
    console.error('[app-api/member-link] Role-channel publish failed:', e);
  }
}

/** Apply the role-driven channel memberships for a member with a custom role (non-fatal). */
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
    console.error('[app-api/member-link] Failed to apply role-driven channels:', e);
  }
}

/**
 * Link `userId` to its invited row in this org (found by invitation `token`
 * when given, else by the membership's email) and wire up channels. Returns
 * the row as it was before linking, or null when nothing was linked.
 *
 * `workspaceId` (`workspaces.id`), when known, bumps the permission cache
 * after the activating write (see `activatePendingMember`).
 */
export async function linkInvitedMember(
  env: Env,
  tenantDb: TenantDb,
  membership: ClerkOrgMembership,
  userId: string,
  token: string | null,
  workspaceId?: string,
): Promise<WorkspaceMemberRow | null> {
  const orgId = membership.organization.id;
  const pending = await findPendingMember(tenantDb, token, membership.public_user_data.identifier);
  if (!pending) return null;

  if (!(await activatePendingMember(env, tenantDb, orgId, userId, membership, pending, workspaceId))) return null;
  await joinPublicChannels(env, tenantDb, orgId, userId, pending.memberType);
  if (pending.roleId) await applyRoleChannels(env, tenantDb, orgId, userId, pending.roleId);
  return pending;
}

/**
 * Make sure the caller has a member row in this workspace, linking their
 * invited row when the Clerk sync missed it. Cheap when the row exists (one
 * indexed read); only a miss asks Clerk. A caller Clerk answered for but with
 * nothing to link (added in the Clerk dashboard, a removed tenant row) is
 * remembered for a few minutes, so their page loads don't each ask Clerk
 * again. A failed lookup is not remembered. Never throws — a failed repair
 * just leaves the caller as unknown, which is what they were already.
 */
export async function ensureMemberLinked(
  env: Env,
  tenantDb: TenantDb,
  orgId: string,
  userId: string,
  workspaceId?: string,
): Promise<void> {
  try {
    const [existing] = await tenantDb
      .select({ id: schema.workspaceMembers.id })
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.userId, userId), isNull(schema.workspaceMembers.deletedAt)))
      .limit(1);
    if (existing) return;

    const missKey = linkMissKey(orgId, userId);
    if (await env.WORKSPACE_CACHE.get(missKey).catch(() => null)) return;

    const memberships = await fetchUserMemberships(env, userId);
    if (!memberships) return;

    const membership = memberships.find((m) => m.organization.id === orgId);
    if (membership && (await linkInvitedMember(env, tenantDb, membership, userId, null, workspaceId))) {
      console.log(`[app-api/member-link] Linked unlinked invited member for user ${userId} in org ${orgId}`);
      return;
    }
    await env.WORKSPACE_CACHE.put(missKey, '1', { expirationTtl: LINK_MISS_TTL_SECONDS }).catch(() => {});
  } catch (err) {
    console.error('[app-api/member-link] Failed to link member:', err);
  }
}
