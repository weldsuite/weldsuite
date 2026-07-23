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
import { clerkMiddleware } from '../../middleware/clerk';
import { schema, getMasterDb, masterSchema, getTenantDbForWorkspace } from '../../db';
import { success, error } from '../../lib/response';
import { autoJoinUserToPublicChannels } from '../../services/weldchat-auto-join';
import { applyRoleChangeToChannels } from '../../services/weldchat-role-links';
import {
  publishChatMemberJoined,
  publishChatUserChannelNew,
} from '../../services/realtime/weldchat-publisher';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', clerkMiddleware());

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

    // Strategy: Use Clerk API to get the user's pending invitations,
    // then match by invitation ID to find the right one.
    const userResp = await fetch(`https://api.clerk.com/v1/users/${userId}/organization_memberships?limit=100`, {
      headers: { Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}` },
    });

    if (userResp.ok) {
      const memberships = await userResp.json() as { data: Array<{ organization: { id: string; name: string; slug: string; image_url: string | null }; role: string }> };

      // Check each org for this invitation
      for (const membership of memberships.data || []) {
        const orgId = membership.organization.id;

        try {
          const invResp = await fetch(`https://api.clerk.com/v1/organizations/${orgId}/invitations/${token}`, {
            headers: { Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}` },
          });

          if (invResp.ok) {
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
              .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
              .limit(1);

            return success(c, {
              workspaceId: orgId,
              workspaceName: workspace?.name || membership.organization.name,
              role: invitation.role,
              inviteeEmail: invitation.email_address,
              inviteeName: '',
              isExpired: invitation.expires_at ? new Date(invitation.expires_at) < new Date() : false,
              isUsed: invitation.status === 'accepted' || invitation.status === 'revoked',
              expiresAt: invitation.expires_at ? new Date(invitation.expires_at).toISOString() : undefined,
            });
          }
        } catch {
          // Invitation not in this org, continue
          continue;
        }
      }
    }

    // Fallback: search tenant DBs for this invitation
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
        const tenantDb = await getTenantDbForWorkspace(c.env, workspace.clerkOrgId);
        const [member] = await tenantDb
          .select()
          .from(schema.workspaceMembers)
          .where(and(
            eq(schema.workspaceMembers.clerkInvitationId, token),
            isNull(schema.workspaceMembers.deletedAt),
          ))
          .limit(1);

        if (member) {
          return success(c, {
            workspaceId: workspace.clerkOrgId,
            workspaceName: workspace.name,
            role: member.role,
            inviteeEmail: member.email || '',
            inviteeName: member.name || '',
            isExpired: false,
            isUsed: member.status === 'ACTIVE',
          });
        }
      } catch {
        continue;
      }
    }

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
    const membershipsResp = await fetch(
      `https://api.clerk.com/v1/users/${userId}/organization_memberships?limit=100`,
      { headers: { Authorization: `Bearer ${c.env.CLERK_SECRET_KEY}` } },
    );

    if (!membershipsResp.ok) {
      console.error('[app-api/invitations] Failed to fetch user memberships from Clerk');
      return error.internal(c, 'Failed to verify membership');
    }

    const memberships = await membershipsResp.json() as {
      data: Array<{
        id: string;
        organization: { id: string; name: string; slug: string };
        role: string;
        public_user_data: { identifier: string; first_name: string | null; last_name: string | null; image_url: string | null };
      }>;
    };

    // Find the membership that matches this invitation
    // Try each org to find where this invitation belongs
    let matchedOrg: { id: string; name: string } | null = null;
    let matchedRole = 'MEMBER';

    for (const membership of memberships.data || []) {
      const orgId = membership.organization.id;

      try {
        // Check if this org has a PENDING member matching the invitation or user email
        const tenantDb = await getTenantDbForWorkspace(c.env, orgId);
        const email = membership.public_user_data.identifier;
        const name = [membership.public_user_data.first_name, membership.public_user_data.last_name]
          .filter(Boolean).join(' ') || null;
        const picture = membership.public_user_data.image_url;

        // Try to find by invitation ID first
        let [pending] = await tenantDb
          .select()
          .from(schema.workspaceMembers)
          .where(and(
            eq(schema.workspaceMembers.clerkInvitationId, token),
            eq(schema.workspaceMembers.status, 'PENDING'),
            isNull(schema.workspaceMembers.deletedAt),
          ))
          .limit(1);

        // Fallback: find by email (case-insensitive). Same broadened OR
        // clause as the workspace-worker webhook so the two paths agree on
        // which row is "the pending one" — otherwise the loser of the race
        // creates a duplicate.
        if (!pending) {
          [pending] = await tenantDb
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
        }

        if (pending) {
          // Update PENDING → ACTIVE
          const roleMap: Record<string, string> = {
            'org:admin': 'ADMIN',
            'org:member': 'MEMBER',
          };

          // Guests stay on VIEWER regardless of Clerk role — their access is
          // gated by the guest-scope middleware + per-channel membership,
          // not by role. memberType itself is on the row already (set at
          // invite time) and is intentionally not in the SET clause.
          const isGuest = pending.memberType === 'EXTERNAL_GUEST';
          const resolvedRole = isGuest
            ? (pending.role || 'VIEWER')
            : (roleMap[membership.role] || pending.role || 'MEMBER');

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
          await c.env.WORKSPACE_CACHE.delete(`member-type:${orgId}:${userId}`).catch(() => {});

          try {
            const joined = await autoJoinUserToPublicChannels(tenantDb, userId, pending.memberType);
            for (const ch of joined) {
              try {
                await publishChatUserChannelNew(c.env, orgId, userId, ch.id, ch.name);
              } catch (e) {
                console.error('[app-api/invitations] Realtime publish failed:', e);
              }
            }
          } catch (e) {
            console.error('[app-api/invitations] Failed to auto-join public channels:', e);
          }

          // If the pending member already has a custom workspace role
          // assigned, apply the role-driven channel memberships. Today this
          // is a no-op because invitations don't carry `roleId`, but wiring
          // it now means future invitation-with-role flows pick up channel
          // membership without further changes.
          if (pending.roleId) {
            try {
              const changes = await applyRoleChangeToChannels(
                tenantDb,
                userId,
                null,
                pending.roleId,
              );
              for (const change of changes.added) {
                for (const uid of change.userIds) {
                  try {
                    await publishChatMemberJoined(c.env, change.channelId, {
                      channelId: change.channelId,
                      userId: uid,
                    });
                    await publishChatUserChannelNew(
                      c.env,
                      orgId,
                      uid,
                      change.channelId,
                      change.channelName,
                    );
                  } catch (e) {
                    console.error('[app-api/invitations] Role-channel publish failed:', e);
                  }
                }
              }
            } catch (e) {
              console.error('[app-api/invitations] Failed to apply role-driven channels:', e);
            }
          }

          // Get workspace name
          const [workspace] = await masterDb
            .select({ name: masterSchema.workspaces.name })
            .from(masterSchema.workspaces)
            .where(eq(masterSchema.workspaces.clerkOrgId, orgId))
            .limit(1);

          matchedOrg = { id: orgId, name: workspace?.name || membership.organization.name };
          matchedRole = roleMap[membership.role] || pending.role || 'MEMBER';
          break;
        }
      } catch (err) {
        console.warn(`[app-api/invitations] Error checking org ${orgId}:`, err);
        continue;
      }
    }

    if (!matchedOrg) {
      // No PENDING member found - user might already be active or invitation not found
      // Check if user is already an active member in any org
      for (const membership of memberships.data || []) {
        const [workspace] = await masterDb
          .select({ name: masterSchema.workspaces.name })
          .from(masterSchema.workspaces)
          .where(eq(masterSchema.workspaces.clerkOrgId, membership.organization.id))
          .limit(1);

        if (workspace) {
          matchedOrg = { id: membership.organization.id, name: workspace.name };
          const roleMap: Record<string, string> = { 'org:admin': 'ADMIN', 'org:member': 'MEMBER' };
          matchedRole = roleMap[membership.role] || 'MEMBER';
          break;
        }
      }
    }

    if (!matchedOrg) {
      return error.notFound(c, 'Invitation');
    }

    return success(c, {
      workspaceId: matchedOrg.id,
      workspaceName: matchedOrg.name,
      role: matchedRole,
    });
  } catch (err) {
    console.error('[app-api/invitations] Error accepting invitation:', err);
    return error.internal(c, 'Failed to accept invitation');
  }
});

export const invitationsRoutes = app;
