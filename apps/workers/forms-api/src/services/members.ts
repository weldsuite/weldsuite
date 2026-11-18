/**
 * Member profiles for the DTOs: who owns a form, who published a version.
 */

import { and, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import type { FormUserRef } from '@weldsuite/app-api-client/schemas/weldforms';

const { workspaceMembers } = schema;

/** Profiles by user id. A user without a member row (removed, or from another system) gets a bare ref. */
export async function memberRefs(db: Database, userIds: string[]): Promise<Map<string, FormUserRef>> {
  const ids = [...new Set(userIds)].filter(Boolean);
  const refs = new Map<string, FormUserRef>();
  if (ids.length > 0) {
    const rows = await db
      .select({
        userId: workspaceMembers.userId,
        name: workspaceMembers.name,
        email: workspaceMembers.email,
        picture: workspaceMembers.picture,
      })
      .from(workspaceMembers)
      .where(and(inArray(workspaceMembers.userId, ids), isNull(workspaceMembers.deletedAt)));
    for (const row of rows) {
      refs.set(row.userId, { userId: row.userId, name: row.name || row.email || null, email: row.email ?? null, imageUrl: row.picture ?? null });
    }
  }
  for (const id of ids) if (!refs.has(id)) refs.set(id, { userId: id, name: null, email: null, imageUrl: null });
  return refs;
}

export async function memberRef(db: Database, userId: string): Promise<FormUserRef> {
  return (await memberRefs(db, [userId])).get(userId) ?? { userId, name: null, email: null, imageUrl: null };
}
