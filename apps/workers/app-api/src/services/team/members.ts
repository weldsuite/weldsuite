/**
 * Members Service
 *
 * Team member queries with field-level projection based on visibility.
 *
 * Visibility levels:
 * - 'public'  → id, userId, name, picture, role, status, memberType
 * - 'self'    → public + email, roleId, permissions
 * - 'admin'   → self + invitedBy, invitedAt, acceptedAt, createdAt
 *
 * The service always fetches all fields, then projectMemberFields strips
 * per row based on visibility + whether the row is the viewer's own.
 *
 * Ported from apps/core-api/src/services/members.ts.
 */

import { eq, and, desc, isNull, like, or, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db';

// ============================================================================
// Types
// ============================================================================

export type Visibility = 'public' | 'admin';

export interface ListMembersParams {
  cursor?: string;
  limit?: number;
  search?: string;
  status?: string;
  /**
   * 'INTERNAL' (default) — only employees / paid seats.
   * 'EXTERNAL_GUEST'      — only external guests.
   * 'all'                  — both. Used by the channel "available members" picker.
   */
  memberType?: 'INTERNAL' | 'EXTERNAL_GUEST' | 'all';
}

export interface ListResult<T> {
  data: T[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

// Fields exposed at each visibility level. memberType is public so the UI
// can render the "Guest" badge without needing admin access.
const PUBLIC_KEYS = ['id', 'userId', 'name', 'picture', 'role', 'status', 'memberType'] as const;
const SELF_KEYS = [...PUBLIC_KEYS, 'email', 'roleId', 'permissions'] as const;
const ADMIN_KEYS = [...SELF_KEYS, 'invitedBy', 'invitedAt', 'acceptedAt', 'createdAt'] as const;

/**
 * Strip a member row to only the fields allowed by the visibility level.
 * The viewer's own row is always enriched to at least 'self' level.
 */
export function projectMemberFields(
  member: Record<string, unknown>,
  visibility: Visibility,
  viewerUserId: string,
): Record<string, unknown> {
  const isSelf = member.userId === viewerUserId;

  let allowedKeys: readonly string[];
  if (visibility === 'admin') {
    allowedKeys = ADMIN_KEYS;
  } else if (isSelf) {
    allowedKeys = SELF_KEYS;
  } else {
    allowedKeys = PUBLIC_KEYS;
  }

  const projected: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (key in member) {
      projected[key] = member[key];
    }
  }
  return projected;
}

// ============================================================================
// Queries
// ============================================================================

export async function listMembers(
  db: Database,
  params: ListMembersParams,
): Promise<ListResult<typeof schema.workspaceMembers.$inferSelect>> {
  const { workspaceMembers } = schema;
  const limit = Math.min(params.limit ?? 25, 100);

  const conditions: ReturnType<typeof eq>[] = [isNull(workspaceMembers.deletedAt)];

  // Filter by status
  if (params.status) {
    conditions.push(eq(workspaceMembers.status, params.status));
  }

  // Filter by member type. Defaults to INTERNAL — preserves the pre-guest
  // behaviour of the team directory (don't surface guests in member admin
  // unless explicitly asked).
  const memberTypeFilter = params.memberType ?? 'INTERNAL';
  if (memberTypeFilter !== 'all') {
    conditions.push(eq(workspaceMembers.memberType, memberTypeFilter));
  }

  // Search by name or email
  if (params.search) {
    const term = `%${params.search}%`;
    conditions.push(
      or(
        like(workspaceMembers.name, term),
        like(workspaceMembers.email, term),
      )!,
    );
  }

  // Cursor keyset
  if (params.cursor) {
    const [cursorRow] = await db
      .select({ createdAt: workspaceMembers.createdAt, id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.id, params.cursor))
      .limit(1);

    if (cursorRow?.createdAt) {
      conditions.push(
        sql`(${workspaceMembers.createdAt} < ${cursorRow.createdAt} OR (${workspaceMembers.createdAt} = ${cursorRow.createdAt} AND ${workspaceMembers.id} < ${cursorRow.id}))`,
      );
    }
  }

  const where = and(...conditions);

  // Count without cursor condition
  const countConditions = params.cursor ? conditions.slice(0, -1) : conditions;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(workspaceMembers)
      .where(where)
      .orderBy(desc(workspaceMembers.createdAt), desc(workspaceMembers.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)` })
      .from(workspaceMembers)
      .where(and(...countConditions)),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
  const totalCount = Number(countResult[0]?.count ?? 0);

  return { data, totalCount, hasMore, cursor: nextCursor };
}

export async function getMember(
  db: Database,
  id: string,
): Promise<typeof schema.workspaceMembers.$inferSelect | null> {
  const { workspaceMembers } = schema;

  const [member] = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.id, id), isNull(workspaceMembers.deletedAt)))
    .limit(1);

  return member ?? null;
}
