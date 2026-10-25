import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { addFollowers } from './followers';
import { getEntityProvider, type PermissionCheck, type ResolvedEntityInfo } from './registry';

export interface GetOrCreateParams {
  db: Database;
  entityType: string;
  entityId: string;
  actingUserId: string;
  /** The acting user's permission check (providers may consult scope grants). */
  can: PermissionCheck;
}

export interface GetOrCreateResult {
  channel: typeof schema.chatChannels.$inferSelect;
  created: boolean;
  /** Users this call made follow the channel: its default members and the acting user. */
  newFollowerIds: string[];
}

function slugify(input: string, suffix: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 200);
  return `${base || 'entity'}-${suffix}`.slice(0, 255);
}

export async function findEntityChannel(
  db: Database,
  entityType: string,
  entityId: string,
): Promise<typeof schema.chatChannels.$inferSelect | null> {
  const { chatChannels } = schema;
  const [row] = await db
    .select()
    .from(chatChannels)
    .where(
      and(
        eq(chatChannels.entityType, entityType),
        eq(chatChannels.entityId, entityId),
        isNull(chatChannels.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Find a SOFT-DELETED entity channel for this entity, if one exists. Deleting
 * an entity channel only sets `deletedAt` and keeps the (entityType, entityId)
 * link, so a deleted row still occupies the entity's slot. We resurrect that
 * row rather than inserting a duplicate. Returns the most recently deleted
 * match.
 */
export async function findDeletedEntityChannel(
  db: Database,
  entityType: string,
  entityId: string,
): Promise<typeof schema.chatChannels.$inferSelect | null> {
  const { chatChannels } = schema;
  const [row] = await db
    .select()
    .from(chatChannels)
    .where(
      and(
        eq(chatChannels.entityType, entityType),
        eq(chatChannels.entityId, entityId),
        isNotNull(chatChannels.deletedAt),
      ),
    )
    .orderBy(desc(chatChannels.deletedAt))
    .limit(1);
  return row ?? null;
}

async function loadChannel(db: Database, channelId: string): Promise<typeof schema.chatChannels.$inferSelect> {
  const { chatChannels } = schema;
  const [channel] = await db
    .select()
    .from(chatChannels)
    .where(eq(chatChannels.id, channelId))
    .limit(1);
  return channel;
}

/**
 * Revive a soft-deleted entity channel: clear `deletedAt`, refresh the
 * entity-derived fields, and ensure the default members + acting user follow
 * it. Preserves the channel's id and message history.
 */
async function resurrectEntityChannel(
  db: Database,
  channelId: string,
  resolved: ResolvedEntityInfo,
  actingUserId: string,
): Promise<GetOrCreateResult> {
  const { chatChannels } = schema;

  // Members rows survive the channel soft-delete, but re-assert the expected
  // set so a reused channel always has its default members + the acting user.
  const newFollowerIds = await addFollowers(db, channelId, [...resolved.defaultMemberIds, actingUserId], {
    ownerId: actingUserId,
  });

  await db
    .update(chatChannels)
    .set({
      deletedAt: null,
      name: resolved.displayName,
      entityDisplayName: resolved.displayName,
      icon: resolved.icon ?? null,
      updatedAt: new Date(),
    })
    .where(eq(chatChannels.id, channelId));

  return { channel: await loadChannel(db, channelId), created: false, newFollowerIds };
}

export async function getOrCreateEntityChannel(params: GetOrCreateParams): Promise<GetOrCreateResult> {
  const { db, entityType, entityId, actingUserId, can } = params;

  const existing = await findEntityChannel(db, entityType, entityId);
  if (existing) return { channel: existing, created: false, newFollowerIds: [] };

  const provider = getEntityProvider(entityType);
  if (!provider) {
    throw new Error(`No entity channel provider registered for type "${entityType}"`);
  }

  const resolved = await provider.resolve({ db, actingUserId, entityId, can });
  if (!resolved) {
    throw new Error(`Entity ${entityType}:${entityId} not found`);
  }

  // A previously-deleted channel still holds this entity's (entityType,
  // entityId) slot (soft delete keeps the link). Resurrect it instead of
  // inserting a duplicate — otherwise every delete-then-reuse spawns a new
  // channel, and on tenants where the partial unique index is enforced the
  // insert below would instead fail with a constraint violation.
  const deleted = await findDeletedEntityChannel(db, entityType, entityId);
  if (deleted) return resurrectEntityChannel(db, deleted.id, resolved, actingUserId);

  const { chatChannels } = schema;
  const channelId = generateId('ch');
  const now = new Date();

  try {
    await db.insert(chatChannels).values({
      id: channelId,
      name: resolved.displayName,
      slug: slugify(resolved.displayName, channelId),
      type: 'entity',
      entityType,
      entityId,
      entityDisplayName: resolved.displayName,
      icon: resolved.icon ?? null,
      createdBy: actingUserId,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    // Unique index collision — a concurrent request created the channel, or a
    // soft-deleted row still holds the slot. Reuse the live row if there is
    // one, else resurrect the deleted row, else surface the error.
    const retry = await findEntityChannel(db, entityType, entityId);
    if (retry) return { channel: retry, created: false, newFollowerIds: [] };
    const retryDeleted = await findDeletedEntityChannel(db, entityType, entityId);
    if (retryDeleted) return resurrectEntityChannel(db, retryDeleted.id, resolved, actingUserId);
    throw err;
  }

  // The creator follows the chat, with the owner role.
  const newFollowerIds = await addFollowers(db, channelId, [...resolved.defaultMemberIds, actingUserId], {
    ownerId: actingUserId,
  });

  return { channel: await loadChannel(db, channelId), created: true, newFollowerIds };
}
