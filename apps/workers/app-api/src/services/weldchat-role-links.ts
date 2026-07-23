/**
 * WeldChat role-link helpers.
 *
 * Channels can be linked to one or more workspace roles. Members holding a
 * linked role are auto-added to the channel; when their role changes (or the
 * link is removed) their role-driven membership is removed. Manual joins are
 * sticky — identified by `addedByRoleId IS NULL` they are never touched.
 *
 * All helpers are pure DB operations. The HTTP layer is responsible for
 * publishing realtime events using the returned change-sets.
 *
 * Ported verbatim from api-worker `src/services/weldchat-role-links.ts`
 * (W3 legacy-worker phase-out). The invitations accept flow consumes
 * `applyRoleChangeToChannels`; the remaining helpers are carried over so the
 * settings/roles surfaces can reuse them when they migrate.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '../db';
import { generateId } from '../lib/id';

export interface ChannelChange {
  channelId: string;
  channelName: string;
  userIds: string[];
}

/**
 * Link a role to a channel and backfill memberships for every current
 * INTERNAL ACTIVE member holding that role. Idempotent — re-running with the
 * same args is a no-op.
 */
export async function linkRoleToChannel(
  db: Database,
  channelId: string,
  roleId: string,
  createdBy: string | null,
): Promise<string[]> {
  const { chatChannels, chatChannelMembers, chatChannelRoleLinks, workspaceMembers } = schema;

  await db
    .insert(chatChannelRoleLinks)
    .values({
      id: generateId('crl'),
      channelId,
      roleId,
      createdBy: createdBy ?? null,
    })
    .onConflictDoNothing();

  const members = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.roleId, roleId),
        eq(workspaceMembers.status, 'ACTIVE'),
        eq(workspaceMembers.memberType, 'INTERNAL'),
        isNull(workspaceMembers.deletedAt),
      ),
    );

  const userIds = members
    .map((m) => m.userId)
    .filter((uid): uid is string => !!uid && uid.length > 0);

  if (userIds.length === 0) return [];

  const existing = await db
    .select({ userId: chatChannelMembers.userId })
    .from(chatChannelMembers)
    .where(
      and(
        eq(chatChannelMembers.channelId, channelId),
        inArray(chatChannelMembers.userId, userIds),
      ),
    );
  const existingSet = new Set(existing.map((r) => r.userId));
  const toInsert = userIds.filter((uid) => !existingSet.has(uid));

  if (toInsert.length === 0) return [];

  const now = new Date();
  await db
    .insert(chatChannelMembers)
    .values(
      toInsert.map((userId) => ({
        id: generateId('cmb'),
        channelId,
        userId,
        memberType: 'user',
        role: 'member',
        addedByRoleId: roleId,
        joinedAt: now,
        createdAt: now,
      })),
    )
    .onConflictDoNothing();

  await db
    .update(chatChannels)
    .set({
      memberCount: sql`(SELECT count(*)::int FROM ${chatChannelMembers} WHERE ${chatChannelMembers.channelId} = ${channelId})`,
      updatedAt: now,
    })
    .where(eq(chatChannels.id, channelId));

  return toInsert;
}

/**
 * Unlink a role from a channel and remove every role-driven membership for
 * that (channel, role) pair. Manual joins (addedByRoleId IS NULL) and joins
 * via a different role are left intact.
 */
export async function unlinkRoleFromChannel(
  db: Database,
  channelId: string,
  roleId: string,
): Promise<string[]> {
  const { chatChannels, chatChannelMembers, chatChannelRoleLinks } = schema;

  await db
    .delete(chatChannelRoleLinks)
    .where(
      and(
        eq(chatChannelRoleLinks.channelId, channelId),
        eq(chatChannelRoleLinks.roleId, roleId),
      ),
    );

  const toRemove = await db
    .select({ userId: chatChannelMembers.userId })
    .from(chatChannelMembers)
    .where(
      and(
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.addedByRoleId, roleId),
      ),
    );
  const removedUserIds = toRemove.map((r) => r.userId);

  if (removedUserIds.length === 0) return [];

  await db
    .delete(chatChannelMembers)
    .where(
      and(
        eq(chatChannelMembers.channelId, channelId),
        eq(chatChannelMembers.addedByRoleId, roleId),
      ),
    );

  await db
    .update(chatChannels)
    .set({
      memberCount: sql`(SELECT count(*)::int FROM ${chatChannelMembers} WHERE ${chatChannelMembers.channelId} = ${channelId})`,
      updatedAt: new Date(),
    })
    .where(eq(chatChannels.id, channelId));

  return removedUserIds;
}

/**
 * Apply a workspace member's role change to channel memberships.
 *
 * Removes the user from channels linked to oldRoleId (only where
 * addedByRoleId = oldRoleId — manual joins are sticky) and adds the user to
 * channels linked to newRoleId. A no-op when oldRoleId === newRoleId.
 *
 * Note on the new-role insert: if a manual row already exists we leave its
 * addedByRoleId alone (null). We do NOT promote a manual join to a
 * role-driven one — that would make it auto-removable on the next role
 * change.
 */
export async function applyRoleChangeToChannels(
  db: Database,
  userId: string,
  oldRoleId: string | null,
  newRoleId: string | null,
): Promise<{ added: ChannelChange[]; removed: ChannelChange[] }> {
  const result = { added: [] as ChannelChange[], removed: [] as ChannelChange[] };
  if (!userId || oldRoleId === newRoleId) return result;

  const { chatChannels, chatChannelMembers, chatChannelRoleLinks } = schema;
  const touchedChannels = new Set<string>();

  if (oldRoleId) {
    const oldChannels = await db
      .select({ id: chatChannels.id, name: chatChannels.name })
      .from(chatChannelRoleLinks)
      .innerJoin(chatChannels, eq(chatChannels.id, chatChannelRoleLinks.channelId))
      .where(
        and(
          eq(chatChannelRoleLinks.roleId, oldRoleId),
          isNull(chatChannels.deletedAt),
        ),
      );

    for (const ch of oldChannels) {
      const deleted = await db
        .delete(chatChannelMembers)
        .where(
          and(
            eq(chatChannelMembers.channelId, ch.id),
            eq(chatChannelMembers.userId, userId),
            eq(chatChannelMembers.addedByRoleId, oldRoleId),
          ),
        )
        .returning({ id: chatChannelMembers.id });

      if (deleted.length > 0) {
        result.removed.push({ channelId: ch.id, channelName: ch.name, userIds: [userId] });
        touchedChannels.add(ch.id);
      }
    }
  }

  if (newRoleId) {
    const newChannels = await db
      .select({ id: chatChannels.id, name: chatChannels.name })
      .from(chatChannelRoleLinks)
      .innerJoin(chatChannels, eq(chatChannels.id, chatChannelRoleLinks.channelId))
      .where(
        and(
          eq(chatChannelRoleLinks.roleId, newRoleId),
          isNull(chatChannels.deletedAt),
        ),
      );

    if (newChannels.length > 0) {
      const channelIds = newChannels.map((c) => c.id);
      const existing = await db
        .select({ channelId: chatChannelMembers.channelId })
        .from(chatChannelMembers)
        .where(
          and(
            inArray(chatChannelMembers.channelId, channelIds),
            eq(chatChannelMembers.userId, userId),
          ),
        );
      const existingSet = new Set(existing.map((r) => r.channelId));
      const toInsert = newChannels.filter((ch) => !existingSet.has(ch.id));

      if (toInsert.length > 0) {
        const now = new Date();
        await db
          .insert(chatChannelMembers)
          .values(
            toInsert.map((ch) => ({
              id: generateId('cmb'),
              channelId: ch.id,
              userId,
              memberType: 'user',
              role: 'member',
              addedByRoleId: newRoleId,
              joinedAt: now,
              createdAt: now,
            })),
          )
          .onConflictDoNothing();

        for (const ch of toInsert) {
          result.added.push({ channelId: ch.id, channelName: ch.name, userIds: [userId] });
          touchedChannels.add(ch.id);
        }
      }
    }
  }

  const now = new Date();
  for (const channelId of touchedChannels) {
    await db
      .update(chatChannels)
      .set({
        memberCount: sql`(SELECT count(*)::int FROM ${chatChannelMembers} WHERE ${chatChannelMembers.channelId} = ${channelId})`,
        updatedAt: now,
      })
      .where(eq(chatChannels.id, channelId));
  }

  return result;
}

/**
 * Called when a workspace role is (soft-)deleted. Removes every link
 * referencing it and clears role-driven memberships across all affected
 * channels. Members whose workspaceMembers.roleId matched the deleted role
 * should be updated by the caller.
 */
export async function cleanupRoleLinksOnRoleDelete(
  db: Database,
  roleId: string,
): Promise<ChannelChange[]> {
  const { chatChannels, chatChannelRoleLinks } = schema;

  const affected = await db
    .select({ channelId: chatChannelRoleLinks.channelId })
    .from(chatChannelRoleLinks)
    .where(eq(chatChannelRoleLinks.roleId, roleId));

  if (affected.length === 0) return [];

  const changes: ChannelChange[] = [];
  for (const link of affected) {
    const channelInfo = await db
      .select({ id: chatChannels.id, name: chatChannels.name })
      .from(chatChannels)
      .where(eq(chatChannels.id, link.channelId))
      .limit(1);
    const channelName = channelInfo[0]?.name ?? '';

    const removed = await unlinkRoleFromChannel(db, link.channelId, roleId);
    if (removed.length > 0) {
      changes.push({ channelId: link.channelId, channelName, userIds: removed });
    }
  }

  return changes;
}
