/**
 * Access Requests Service
 *
 * Handles the "Request access" flow when a user lacks permission to a page.
 * Creates an access_requests row (idempotent on a pending row for the same
 * requester+permission) and notifies every workspace OWNER/ADMIN via the
 * shared notifications table. Realtime delivery is the caller's job — the
 * route layer publishes through the REALTIME service binding so a service
 * can stay HTTP-free.
 *
 * Ported from apps/core-api/src/services/access-requests.ts.
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from './../db';
import { generateId } from './../lib/id';

export interface CreateAccessRequestParams {
  requesterId: string;
  requesterName?: string | null;
  permission: string;
  pageLabel?: string;
  pagePath?: string;
}

export interface CreateAccessRequestResult {
  request: typeof schema.accessRequests.$inferSelect;
  /** True when an existing pending row was returned instead of inserting a new one. */
  deduped: boolean;
  /** UserIds of workspace admins who were notified for this insert. Empty when deduped. */
  notifiedAdminUserIds: string[];
  /** Inserted notification rows (one per admin) — for realtime fan-out by the route. */
  insertedNotifications: (typeof schema.notifications.$inferSelect)[];
}

const ADMIN_ROLES = ['OWNER', 'ADMIN'];

export async function createAccessRequest(
  db: Database,
  params: CreateAccessRequestParams,
): Promise<CreateAccessRequestResult> {
  const { accessRequests, workspaceMembers, notifications } = schema;

  const [existing] = await db
    .select()
    .from(accessRequests)
    .where(
      and(
        eq(accessRequests.requesterId, params.requesterId),
        eq(accessRequests.permission, params.permission),
        eq(accessRequests.status, 'pending'),
      ),
    )
    .orderBy(desc(accessRequests.createdAt))
    .limit(1);

  if (existing) {
    return {
      request: existing,
      deduped: true,
      notifiedAdminUserIds: [],
      insertedNotifications: [],
    };
  }

  const now = new Date();
  const [inserted] = await db
    .insert(accessRequests)
    .values({
      id: generateId('areq'),
      requesterId: params.requesterId,
      permission: params.permission,
      pageLabel: params.pageLabel ?? null,
      pagePath: params.pagePath ?? null,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  const admins = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        inArray(workspaceMembers.role, ADMIN_ROLES),
        isNull(workspaceMembers.deletedAt),
      ),
    );

  const notifyUserIds = admins
    .map((row) => row.userId)
    .filter((userId) => userId && userId !== params.requesterId);

  let insertedNotifications: (typeof schema.notifications.$inferSelect)[] = [];

  if (notifyUserIds.length > 0) {
    const requesterLabel = params.requesterName?.trim() || 'A team member';
    const pageRef = params.pageLabel ? ` to access ${params.pageLabel}` : '';
    const title = 'Access request';
    const body = `${requesterLabel} is requesting the "${params.permission}" permission${pageRef}.`;

    insertedNotifications = await db
      .insert(notifications)
      .values(
        notifyUserIds.map((userId) => ({
          id: generateId('ntf'),
          userId,
          title,
          body,
          category: 'security',
          notificationType: 'access_request',
          entityType: 'access_request',
          entityId: inserted.id,
          actionUrl: `/settings/team`,
          actorType: 'user',
          actorId: params.requesterId,
          icon: 'lock',
          severity: 'info',
          data: {
            accessRequestId: inserted.id,
            permission: params.permission,
            pageLabel: params.pageLabel ?? null,
            pagePath: params.pagePath ?? null,
            requesterId: params.requesterId,
          },
        })),
      )
      .returning();
  }

  return {
    request: inserted,
    deduped: false,
    notifiedAdminUserIds: notifyUserIds,
    insertedNotifications,
  };
}

export async function listMyPendingAccessRequests(
  db: Database,
  requesterId: string,
): Promise<(typeof schema.accessRequests.$inferSelect)[]> {
  const { accessRequests } = schema;

  return db
    .select()
    .from(accessRequests)
    .where(
      and(
        eq(accessRequests.requesterId, requesterId),
        eq(accessRequests.status, 'pending'),
      ),
    )
    .orderBy(desc(accessRequests.createdAt));
}

export type ResolveStatus = 'approved' | 'denied';

export interface ResolveAccessRequestParams {
  requestId: string;
  resolverUserId: string;
  status: ResolveStatus;
}

export type ResolveOutcome =
  | { kind: 'not_found' }
  | { kind: 'already_resolved'; request: typeof schema.accessRequests.$inferSelect }
  | {
      kind: 'resolved';
      request: typeof schema.accessRequests.$inferSelect;
      requesterId: string;
      grantedPermission: string | null;
      /** Inserted "Your request was approved/denied" row sent to the requester. */
      requesterNotification: typeof schema.notifications.$inferSelect;
    };

export async function resolveAccessRequest(
  db: Database,
  params: ResolveAccessRequestParams,
): Promise<ResolveOutcome> {
  const { accessRequests, workspaceMembers, notifications } = schema;

  const [existing] = await db
    .select()
    .from(accessRequests)
    .where(eq(accessRequests.id, params.requestId))
    .limit(1);

  if (!existing) return { kind: 'not_found' };
  if (existing.status !== 'pending') return { kind: 'already_resolved', request: existing };

  let grantedPermission: string | null = null;

  if (params.status === 'approved') {
    const [member] = await db
      .select({
        id: workspaceMembers.id,
        permissions: workspaceMembers.permissions,
      })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, existing.requesterId),
          isNull(workspaceMembers.deletedAt),
        ),
      )
      .limit(1);

    if (member) {
      const current = Array.isArray(member.permissions) ? member.permissions : [];
      if (!current.includes(existing.permission)) {
        const next = [...current, existing.permission];
        await db
          .update(workspaceMembers)
          .set({ permissions: next, updatedAt: new Date() })
          .where(eq(workspaceMembers.id, member.id));
      }
      grantedPermission = existing.permission;
    }
  }

  const now = new Date();
  const [updated] = await db
    .update(accessRequests)
    .set({
      status: params.status,
      resolvedBy: params.resolverUserId,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(eq(accessRequests.id, params.requestId))
    .returning();

  // Stamp every admin's original "Access request" notification with the
  // resolved status so the panel can swap the buttons for an "Approved" /
  // "Denied" pill on next reload, and mark them read so the bell badge
  // settles.
  const existingAdminNotifications = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.entityType, 'access_request'),
        eq(notifications.entityId, params.requestId),
      ),
    );

  for (const n of existingAdminNotifications) {
    const nextData = {
      ...((n.data as Record<string, unknown> | null) ?? {}),
      resolvedStatus: params.status,
      resolvedBy: params.resolverUserId,
    };
    await db
      .update(notifications)
      .set({ data: nextData, isRead: true, readAt: now })
      .where(eq(notifications.id, n.id));
  }

  // Tell the requester the outcome.
  const title =
    params.status === 'approved' ? 'Access request approved' : 'Access request denied';
  const body =
    params.status === 'approved'
      ? `You now have the "${existing.permission}" permission.`
      : `Your request for "${existing.permission}" was denied.`;

  const [requesterNotification] = await db
    .insert(notifications)
    .values({
      id: generateId('ntf'),
      userId: existing.requesterId,
      title,
      body,
      category: 'security',
      notificationType: 'access_request_resolved',
      entityType: 'access_request',
      entityId: params.requestId,
      actionUrl: existing.pagePath ?? null,
      actorType: 'user',
      actorId: params.resolverUserId,
      icon: params.status === 'approved' ? 'check' : 'x',
      severity: params.status === 'approved' ? 'success' : 'info',
      data: {
        accessRequestId: params.requestId,
        permission: existing.permission,
        status: params.status,
      },
    })
    .returning();

  return {
    kind: 'resolved',
    request: updated,
    requesterId: existing.requesterId,
    grantedPermission,
    requesterNotification,
  };
}
