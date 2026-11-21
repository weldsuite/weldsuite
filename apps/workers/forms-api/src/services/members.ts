/**
 * Member profiles for the DTOs: who owns a form, who published a version.
 * The name and email come from the member row; the picture is the person's
 * account picture (master `users.image_url`, ADR SEC-020), never the
 * `workspace_members.picture` copy.
 */

import { and, inArray, isNull } from 'drizzle-orm';
import { schema } from '@weldsuite/worker-kit/db';
import { accountPicture, loadAccountPictures } from '@weldsuite/worker-kit/account-pictures';
import type { FormUserRef } from '@weldsuite/app-api-client/schemas/weldforms';
import type { WorkspaceCtx } from './context';

const { workspaceMembers } = schema;

type MemberCtx = Pick<WorkspaceCtx, 'db' | 'env'>;

/** Profiles by user id. A user without a member row (removed, or from another system) gets a bare ref. */
export async function memberRefs(ctx: MemberCtx, userIds: string[]): Promise<Map<string, FormUserRef>> {
  const ids = [...new Set(userIds)].filter(Boolean);
  const refs = new Map<string, FormUserRef>();
  if (ids.length > 0) {
    const [rows, pictures] = await Promise.all([
      ctx.db
        .select({
          userId: workspaceMembers.userId,
          name: workspaceMembers.name,
          email: workspaceMembers.email,
        })
        .from(workspaceMembers)
        .where(and(inArray(workspaceMembers.userId, ids), isNull(workspaceMembers.deletedAt))),
      loadAccountPictures(ctx.env, ids),
    ]);
    for (const row of rows) {
      refs.set(row.userId, {
        userId: row.userId,
        name: row.name || row.email || null,
        email: row.email ?? null,
        imageUrl: accountPicture(pictures, row.userId),
      });
    }
  }
  for (const id of ids) if (!refs.has(id)) refs.set(id, { userId: id, name: null, email: null, imageUrl: null });
  return refs;
}

export async function memberRef(ctx: MemberCtx, userId: string): Promise<FormUserRef> {
  return (await memberRefs(ctx, [userId])).get(userId) ?? { userId, name: null, email: null, imageUrl: null };
}
