/**
 * Account self-service — /api/account/*.
 *
 *   GET  /deletion-status — what deleting the account would do / what blocks it
 *   POST /delete          — permanently delete the caller's WeldSuite account
 *
 * Required for Google Play's account-deletion policy (and GDPR): every user
 * that can create an account must be able to delete it, from a web page and
 * from the mobile apps, without contacting support.
 *
 * Deletion cascades through the Clerk `user.deleted` / `organization.deleted`
 * webhooks in workspace-worker (master user deactivation, membership removal,
 * tenant member soft-delete, Neon teardown for deleted orgs). This route also
 * applies the master-DB cleanup directly so the account is unusable even if a
 * webhook delivery is delayed or dropped.
 *
 * Deletion is REFUSED while the caller is the only admin of a workspace that
 * still has other members — ownership must be transferred first so a team is
 * never orphaned. Workspaces where the caller is the sole member are deleted
 * together with the account (Clerk org deletion → webhook soft-delete + Neon
 * cleanup).
 *
 * IMPORTANT — middleware: Clerk auth but NOT workspaceDbMiddleware. A user
 * may have no workspace at all (or none selected) and must still be able to
 * delete their account, so this router applies `clerkMiddleware()` itself and
 * is mounted on the root app BEFORE the global `/api/*` guard (same pattern
 * as /api/auth-desktop).
 *
 * Master-DB-only, no tenant entities are mutated here — exempt from the
 * entity-event coverage sweep.
 */

import { Hono } from 'hono';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { createClerkClient } from '@clerk/backend';
import { zValidator } from '@hono/zod-validator';
import { deleteAccountInput } from '@weldsuite/app-api-client/schemas/account';
import type {
  AccountDeletionBlocker,
  AccountDeletionStatus,
  AccountDeletionWorkspaceRef,
} from '@weldsuite/app-api-client/schemas/account';
import type { Env, Variables } from '../../types';
import { clerkMiddleware } from '../../middleware/clerk';
import { error, success } from '../../lib/response';
import { getMasterDb, masterSchema, type MasterDatabase } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Clerk auth only — deliberately NOT workspaceDbMiddleware (no org required).
app.use('*', clerkMiddleware());

const { users, userWorkspaces, workspaces } = masterSchema;

async function computeDeletionStatus(
  db: MasterDatabase,
  userId: string,
): Promise<AccountDeletionStatus> {
  const memberships = await db
    .select({
      workspaceId: userWorkspaces.workspaceId,
      role: userWorkspaces.role,
      name: workspaces.name,
      clerkOrgId: workspaces.clerkOrgId,
    })
    .from(userWorkspaces)
    .innerJoin(workspaces, eq(userWorkspaces.workspaceId, workspaces.id))
    .where(
      and(
        eq(userWorkspaces.userId, userId),
        eq(userWorkspaces.status, 'ACTIVE'),
        eq(workspaces.isActive, true),
      ),
    );

  const blockers: AccountDeletionBlocker[] = [];
  const workspacesToDelete: AccountDeletionWorkspaceRef[] = [];

  if (memberships.length > 0) {
    const others = await db
      .select({
        workspaceId: userWorkspaces.workspaceId,
        role: userWorkspaces.role,
      })
      .from(userWorkspaces)
      .where(
        and(
          inArray(userWorkspaces.workspaceId, memberships.map((m) => m.workspaceId)),
          ne(userWorkspaces.userId, userId),
          eq(userWorkspaces.status, 'ACTIVE'),
        ),
      );

    for (const membership of memberships) {
      const otherMembers = others.filter((o) => o.workspaceId === membership.workspaceId);

      if (otherMembers.length === 0) {
        workspacesToDelete.push({ workspaceId: membership.workspaceId, name: membership.name });
        continue;
      }

      const hasOtherAdmin = otherMembers.some((o) => o.role === 'org:admin');
      if (membership.role === 'org:admin' && !hasOtherAdmin) {
        blockers.push({
          workspaceId: membership.workspaceId,
          name: membership.name,
          reason: 'sole_admin_with_members',
          otherMemberCount: otherMembers.length,
        });
      }
    }
  }

  return { canDelete: blockers.length === 0, blockers, workspacesToDelete };
}

app.get('/deletion-status', async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c, 'No user');

  try {
    const status = await computeDeletionStatus(getMasterDb(c.env), userId);
    return success(c, status);
  } catch (err) {
    console.error('[app-api/account] deletion-status failed:', err);
    return error.internal(c, 'Failed to compute account deletion status');
  }
});

app.post('/delete', zValidator('json', deleteAccountInput), async (c) => {
  const userId = c.get('userId');
  if (!userId) return error.unauthorized(c, 'No user');

  const db = getMasterDb(c.env);

  try {
    const status = await computeDeletionStatus(db, userId);
    if (!status.canDelete) {
      return c.json(
        {
          error: {
            code: 'CONFLICT',
            message:
              'You are the only admin of a workspace that still has other members. Transfer ownership or remove the members before deleting your account.',
            details: { blockers: status.blockers },
          },
        },
        409,
      );
    }

    const clerk = createClerkClient({ secretKey: c.env.CLERK_SECRET_KEY });

    // Delete the Clerk org of every workspace the caller was the sole member
    // of. The `organization.deleted` webhook soft-deletes the workspace and
    // tears down its Neon database; the direct isActive flip below covers
    // workspaces without a Clerk org (or a missed webhook).
    for (const ws of status.workspacesToDelete) {
      const [row] = await db
        .select({ clerkOrgId: workspaces.clerkOrgId })
        .from(workspaces)
        .where(eq(workspaces.id, ws.workspaceId));

      if (row?.clerkOrgId) {
        try {
          await clerk.organizations.deleteOrganization(row.clerkOrgId);
        } catch (err) {
          console.error(
            `[app-api/account] Failed to delete Clerk org for workspace ${ws.workspaceId}:`,
            err,
          );
        }
      }

      await db
        .update(workspaces)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(workspaces.id, ws.workspaceId));
    }

    // Delete the Clerk user — removes credentials, sessions, and remaining
    // org memberships at Clerk, and fires the `user.deleted` webhook.
    await clerk.users.deleteUser(userId);

    // Direct master cleanup so the account is gone even before the webhook
    // lands: deactivate, scrub profile PII, drop membership rows.
    await db
      .update(users)
      .set({
        isActive: false,
        email: `${userId}@deleted.weldsuite.org`,
        firstName: null,
        lastName: null,
        imageUrl: null,
        phone: null,
        nickname: null,
        jobTitle: null,
        bio: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    await db.delete(userWorkspaces).where(eq(userWorkspaces.userId, userId));

    return success(c, { deleted: true });
  } catch (err) {
    console.error('[app-api/account] Account deletion failed:', err);
    return error.internal(c, 'Failed to delete account');
  }
});

export const accountRoutes = app;
