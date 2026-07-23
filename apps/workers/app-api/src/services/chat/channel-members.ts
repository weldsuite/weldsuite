/**
 * WeldChat channel-membership service (app-api).
 *
 * Ported from the obsolete api-worker `routes/chat/members.ts` (W5b
 * legacy-worker phase-out). The flat `/api/channel-members` CRUD route adds ONE
 * row at a time, hardcodes `memberType: 'user'`, never maintains the
 * denormalised `chatChannels.memberCount`, and publishes nothing — so other
 * clients stay stale and the sidebar member counts drift. These functions carry
 * the batch semantics + denorm the legacy handlers had.
 *
 * Pure functions (no Hono context): realtime publishing stays with the route.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

const { chatChannels, chatChannelMembers, workspaceMembers } = schema;

export type ChatMemberType = 'user' | 'agent';

export type AddChannelMembersResult =
  | { ok: true; addedCount: number; addedUserIds: string[] }
  | { ok: false; message: string };

/**
 * Validate the ids being invited.
 *
 * `user` → each id must resolve to an ACTIVE workspace member. Stops callers
 * "inviting" arbitrary Clerk user ids into a channel without going through the
 * team invite flow first.
 *
 * `agent` → legacy also probed an `agents` table for existence. That table was
 * physically removed in the 2026-07-08 AI teardown and is not exported from
 * `@weldsuite/db/schema` any more, so the legacy probe would throw on
 * `select().from(undefined)` — i.e. agent invites are broken on api-worker
 * today. Only the id-format half of the legacy check survives the port; the
 * existence probe is reported as a gap rather than faked.
 */
async function validateMemberIds(
  db: Database,
  userIds: string[],
  memberType: ChatMemberType,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (memberType === 'agent') {
    const invalidFormat = userIds.filter((id) => !id.startsWith('agt_'));
    if (invalidFormat.length > 0) {
      return { ok: false, message: `Invalid agent id(s): ${invalidFormat.join(', ')}` };
    }
    return { ok: true };
  }

  const existing = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        inArray(workspaceMembers.userId, userIds),
        eq(workspaceMembers.status, 'ACTIVE'),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  const found = new Set(existing.map((m) => m.userId));
  const missing = userIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return { ok: false, message: `User(s) not in this workspace: ${missing.join(', ')}` };
  }
  return { ok: true };
}

/**
 * Add a batch of members to a channel, honouring `memberType`, skipping people
 * who are already members, and keeping `chatChannels.memberCount` in step.
 *
 * Returns the ids that were actually inserted so the caller only publishes
 * `member_joined` / `channel_new` for real joins.
 */
export async function addChannelMembers(
  db: Database,
  params: { channelId: string; userIds: string[]; memberType?: ChatMemberType },
): Promise<AddChannelMembersResult> {
  const { channelId } = params;
  const memberType: ChatMemberType = params.memberType ?? 'user';
  const userIds = Array.from(new Set(params.userIds));
  if (userIds.length === 0) return { ok: true, addedCount: 0, addedUserIds: [] };

  const validation = await validateMemberIds(db, userIds, memberType);
  if (!validation.ok) return validation;

  const existing = await db
    .select({ userId: chatChannelMembers.userId })
    .from(chatChannelMembers)
    .where(
      and(eq(chatChannelMembers.channelId, channelId), inArray(chatChannelMembers.userId, userIds)),
    );
  const alreadyMember = new Set(existing.map((m) => m.userId));
  const toAdd = userIds.filter((uid) => !alreadyMember.has(uid));
  if (toAdd.length === 0) return { ok: true, addedCount: 0, addedUserIds: [] };

  const now = new Date();
  await db
    .insert(chatChannelMembers)
    .values(
      toAdd.map((uid) => ({
        id: generateId('cmb'),
        channelId,
        userId: uid,
        memberType,
        role: 'member',
        joinedAt: now,
        createdAt: now,
      })),
    )
    .onConflictDoNothing();

  await db
    .update(chatChannels)
    .set({
      memberCount: sql`${chatChannels.memberCount} + ${toAdd.length}`,
      updatedAt: now,
    })
    .where(eq(chatChannels.id, channelId));

  return { ok: true, addedCount: toAdd.length, addedUserIds: toAdd };
}

/**
 * Remove a member by USER id (the flat CRUD route keys off the membership row
 * id, which no caller holds) and decrement the denormalised count. `GREATEST`
 * floors the count at 0 so a drifted counter can never go negative.
 */
export async function removeChannelMemberByUserId(
  db: Database,
  channelId: string,
  userId: string,
): Promise<{ removed: boolean; role: string | null }> {
  const [membership] = await db
    .select({ id: chatChannelMembers.id, role: chatChannelMembers.role })
    .from(chatChannelMembers)
    .where(and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)))
    .limit(1);

  if (!membership) return { removed: false, role: null };

  await db.delete(chatChannelMembers).where(eq(chatChannelMembers.id, membership.id));
  await db
    .update(chatChannels)
    .set({
      memberCount: sql`GREATEST(${chatChannels.memberCount} - 1, 0)`,
      updatedAt: new Date(),
    })
    .where(eq(chatChannels.id, channelId));

  return { removed: true, role: membership.role };
}

/** The caller's own membership row for a channel, or null. */
export async function getMembership(
  db: Database,
  channelId: string,
  userId: string,
): Promise<{ id: string; role: string } | null> {
  const [row] = await db
    .select({ id: chatChannelMembers.id, role: chatChannelMembers.role })
    .from(chatChannelMembers)
    .where(and(eq(chatChannelMembers.channelId, channelId), eq(chatChannelMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Self-join a PUBLIC channel. Private channels require an invite, so this
 * mirrors the legacy `POST /members/join` public-only guard.
 */
export async function joinPublicChannel(
  db: Database,
  channelId: string,
  userId: string,
): Promise<{ ok: true; alreadyMember: boolean } | { ok: false; message: string }> {
  const [channel] = await db
    .select({ type: chatChannels.type })
    .from(chatChannels)
    .where(and(eq(chatChannels.id, channelId), isNull(chatChannels.deletedAt)))
    .limit(1);

  if (!channel || channel.type !== 'public') {
    return { ok: false, message: 'Channel not found or is not public' };
  }

  const existing = await getMembership(db, channelId, userId);
  if (existing) return { ok: true, alreadyMember: true };

  const now = new Date();
  await db
    .insert(chatChannelMembers)
    .values({
      id: generateId('cmb'),
      channelId,
      userId,
      role: 'member',
      joinedAt: now,
      createdAt: now,
    })
    .onConflictDoNothing();

  await db
    .update(chatChannels)
    .set({ memberCount: sql`${chatChannels.memberCount} + 1`, updatedAt: now })
    .where(eq(chatChannels.id, channelId));

  return { ok: true, alreadyMember: false };
}
