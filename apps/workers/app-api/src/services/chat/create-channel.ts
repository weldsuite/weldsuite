/**
 * WeldChat channel-create service (app-api).
 *
 * Ported from the obsolete api-worker `routes/chat/channels.ts` POST handler
 * (W5b legacy-worker phase-out). Channel creation is NOT a bare INSERT — the
 * legacy handler carried five pieces of behaviour the flat CRUD route dropped:
 *
 *   1. the creator is auto-joined as `owner` (without this the creator cannot
 *      see the private channel they just made),
 *   2. an explicit `memberIds` list is joined as `member`,
 *   3. a PUBLIC channel fans out to every ACTIVE INTERNAL workspace member —
 *      the workspace-wide membership invariant that powers #general,
 *   4. `chatChannels.memberCount` is denormalised to the real roster size,
 *   5. every added member is returned so the caller can publish `channel_new`.
 *
 * Pure functions only (no Hono context) — realtime + entity events are the
 * route's job.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

const { chatChannels, chatChannelMembers, workspaceMembers } = schema;

export interface CreateChannelInput {
  name: string;
  description?: string;
  topic?: string;
  type: 'public' | 'private';
  icon?: string;
  sectionId?: string;
  memberIds?: string[];
}

export interface CreateChannelResult {
  channel: typeof chatChannels.$inferSelect;
  /** Every user now holding a membership row — creator included. */
  memberUserIds: string[];
}

/**
 * `chatChannels.slug` is NOT NULL and carries a UNIQUE index. Mirrors the
 * legacy derivation; falls back to the generated id when the name slugifies to
 * an empty string (e.g. an emoji-only name).
 */
export function slugifyChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 255);
}

/** ACTIVE, non-deleted INTERNAL members of the workspace. */
async function listInternalMemberIds(db: Database): Promise<string[]> {
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.status, 'ACTIVE'),
        eq(workspaceMembers.memberType, 'INTERNAL'),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  return rows.map((m) => m.userId);
}

/**
 * Resolve the caller-supplied `memberIds` to real, ACTIVE workspace members.
 *
 * Deviation from the legacy handler (deliberate): legacy inserted whatever ids
 * the body carried, so any caller could seed a channel with arbitrary Clerk
 * user ids. That is the exact hole the legacy `members.ts` add-member handler
 * closes, so the same check is applied here. Unknown ids are dropped rather
 * than 400ing — a stale id in the member picker should not fail the whole
 * channel creation.
 */
async function filterToWorkspaceMembers(db: Database, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        inArray(workspaceMembers.userId, userIds),
        eq(workspaceMembers.status, 'ACTIVE'),
        isNull(workspaceMembers.deletedAt),
      ),
    );
  const valid = new Set(rows.map((m) => m.userId));
  return userIds.filter((id) => valid.has(id));
}

export async function createChannel(
  db: Database,
  creatorUserId: string,
  input: CreateChannelInput,
): Promise<CreateChannelResult> {
  const id = generateId('ch');
  const now = new Date();
  const slug = slugifyChannelName(input.name) || id;

  await db.insert(chatChannels).values({
    id,
    name: input.name,
    slug,
    description: input.description,
    topic: input.topic,
    type: input.type,
    icon: input.icon,
    sectionId: input.sectionId,
    createdBy: creatorUserId,
    memberCount: 1,
    createdAt: now,
    updatedAt: now,
  });

  // 1. Creator is always the owner.
  await db.insert(chatChannelMembers).values({
    id: generateId('cmb'),
    channelId: id,
    userId: creatorUserId,
    role: 'owner',
    joinedAt: now,
    createdAt: now,
  });
  const addedMemberIds = new Set<string>([creatorUserId]);

  // 2. Explicitly invited members.
  const explicitMemberIds = await filterToWorkspaceMembers(
    db,
    (input.memberIds ?? []).filter((m) => m !== creatorUserId),
  );
  for (const memberId of explicitMemberIds) {
    await db
      .insert(chatChannelMembers)
      .values({
        id: generateId('cmb'),
        channelId: id,
        userId: memberId,
        role: 'member',
        joinedAt: now,
        createdAt: now,
      })
      .onConflictDoNothing();
    addedMemberIds.add(memberId);
  }

  // 3. Public channels are workspace-wide.
  if (input.type === 'public') {
    const remaining = (await listInternalMemberIds(db)).filter((uid) => !addedMemberIds.has(uid));
    if (remaining.length > 0) {
      await db
        .insert(chatChannelMembers)
        .values(
          remaining.map((uid) => ({
            id: generateId('cmb'),
            channelId: id,
            userId: uid,
            role: 'member',
            joinedAt: now,
            createdAt: now,
          })),
        )
        .onConflictDoNothing();
      for (const uid of remaining) addedMemberIds.add(uid);
    }
  }

  // 4. Denormalised roster size.
  if (addedMemberIds.size > 1) {
    await db
      .update(chatChannels)
      .set({ memberCount: addedMemberIds.size, updatedAt: now })
      .where(eq(chatChannels.id, id));
  }

  const [channel] = await db.select().from(chatChannels).where(eq(chatChannels.id, id)).limit(1);

  return { channel, memberUserIds: Array.from(addedMemberIds) };
}
