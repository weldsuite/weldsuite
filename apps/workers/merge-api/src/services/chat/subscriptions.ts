/**
 * Chat subscriptions: which WeldChat channel hears about which events of a
 * team or repository (`merge_chat_subscriptions`).
 *
 * A subscription with no team and no repository covers everything. A team
 * covers the team's issues and its repositories' pull requests; a repository
 * covers its pull requests and releases (issues belong to no repository, so a
 * repository subscription never hears about issues).
 */

import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { generateId } from '@weldsuite/worker-kit/id';
import type {
  CreateMergeChatSubscriptionInput,
  ListMergeChatSubscriptionsQuery,
  MergeChatEvent,
  MergeChatSubscriptionDto,
  UpdateMergeChatSubscriptionInput,
} from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { iso, mergeChatSubscriptions, mergeRepositories, mergeTeams, type Db, type MergeChatSubscriptionRow } from '../db';

export function subscriptionDto(row: MergeChatSubscriptionRow): MergeChatSubscriptionDto {
  return {
    id: row.id,
    channelId: row.channelId,
    teamId: row.teamId,
    repositoryId: row.repositoryId,
    events: row.events ?? [],
    digestHour: row.digestHour,
    createdByUserId: row.createdByUserId,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

export function subscriptionEventData(row: MergeChatSubscriptionRow) {
  return { id: row.id, channelId: row.channelId, teamId: row.teamId, repositoryId: row.repositoryId, events: row.events ?? [] };
}

export const SUBSCRIPTION_CHANGE_FIELDS = ['teamId', 'repositoryId', 'events', 'digestHour'] as const;

export async function findSubscription(db: Db, id: string): Promise<MergeChatSubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(mergeChatSubscriptions)
    .where(and(eq(mergeChatSubscriptions.id, id), isNull(mergeChatSubscriptions.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function listSubscriptions(db: Db, query: ListMergeChatSubscriptionsQuery): Promise<MergeChatSubscriptionRow[]> {
  const where = [isNull(mergeChatSubscriptions.deletedAt)];
  if (query.channelId) where.push(eq(mergeChatSubscriptions.channelId, query.channelId));
  if (query.teamId) where.push(eq(mergeChatSubscriptions.teamId, query.teamId));
  return db
    .select()
    .from(mergeChatSubscriptions)
    .where(and(...where))
    .orderBy(asc(mergeChatSubscriptions.createdAt), asc(mergeChatSubscriptions.id));
}

export type SubscriptionRefFailure = 'team_not_found' | 'repository_not_found';

async function checkRefs(
  db: Db,
  teamId: string | null | undefined,
  repositoryId: string | null | undefined,
): Promise<SubscriptionRefFailure | null> {
  if (teamId) {
    const [team] = await db
      .select({ id: mergeTeams.id })
      .from(mergeTeams)
      .where(and(eq(mergeTeams.id, teamId), isNull(mergeTeams.deletedAt)))
      .limit(1);
    if (!team) return 'team_not_found';
  }
  if (repositoryId) {
    const [repository] = await db
      .select({ id: mergeRepositories.id })
      .from(mergeRepositories)
      .where(and(eq(mergeRepositories.id, repositoryId), isNull(mergeRepositories.deletedAt)))
      .limit(1);
    if (!repository) return 'repository_not_found';
  }
  return null;
}

const uniqueEvents = (events: MergeChatEvent[]): MergeChatEvent[] => [...new Set(events)];

export type SubscriptionCreateResult =
  | { ok: true; subscription: MergeChatSubscriptionRow }
  | { ok: false; reason: SubscriptionRefFailure };

export async function createSubscription(
  db: Db,
  input: CreateMergeChatSubscriptionInput,
  userId: string,
): Promise<SubscriptionCreateResult> {
  const failure = await checkRefs(db, input.teamId, input.repositoryId);
  if (failure) return { ok: false, reason: failure };
  const now = new Date();
  const [subscription] = await db
    .insert(mergeChatSubscriptions)
    .values({
      id: generateId('mcs'),
      channelId: input.channelId,
      teamId: input.teamId ?? null,
      repositoryId: input.repositoryId ?? null,
      events: uniqueEvents(input.events),
      digestHour: input.digestHour ?? 9,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { ok: true, subscription: subscription! };
}

export type SubscriptionUpdateResult =
  | { ok: true; before: MergeChatSubscriptionRow; subscription: MergeChatSubscriptionRow }
  | { ok: false; reason: 'not_found' | SubscriptionRefFailure };

export async function updateSubscription(
  db: Db,
  id: string,
  input: UpdateMergeChatSubscriptionInput,
): Promise<SubscriptionUpdateResult> {
  const before = await findSubscription(db, id);
  if (!before) return { ok: false, reason: 'not_found' };
  const failure = await checkRefs(db, input.teamId, input.repositoryId);
  if (failure) return { ok: false, reason: failure };
  const patch: Partial<typeof mergeChatSubscriptions.$inferInsert> = { updatedAt: new Date() };
  if (input.teamId !== undefined) patch.teamId = input.teamId;
  if (input.repositoryId !== undefined) patch.repositoryId = input.repositoryId;
  if (input.events !== undefined) patch.events = uniqueEvents(input.events);
  if (input.digestHour !== undefined) patch.digestHour = input.digestHour;
  const [subscription] = await db.update(mergeChatSubscriptions).set(patch).where(eq(mergeChatSubscriptions.id, id)).returning();
  return { ok: true, before, subscription: subscription! };
}

export async function deleteSubscription(db: Db, id: string): Promise<MergeChatSubscriptionRow | null> {
  const now = new Date();
  const [row] = await db
    .update(mergeChatSubscriptions)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(mergeChatSubscriptions.id, id), isNull(mergeChatSubscriptions.deletedAt)))
    .returning();
  return row ?? null;
}

/** What an event is about, to match subscriptions against. */
export interface EventScope {
  teamId: string | null;
  repositoryId: string | null;
}

/** Subscriptions whose team and repository filters fit the scope, as distinct channel ids. */
export function subscribedChannels(rows: MergeChatSubscriptionRow[], scope: EventScope): string[] {
  const channels = new Set<string>();
  for (const row of rows) {
    if (row.teamId && row.teamId !== scope.teamId) continue;
    if (row.repositoryId && row.repositoryId !== scope.repositoryId) continue;
    channels.add(row.channelId);
  }
  return [...channels];
}

/** The channels subscribed to `event` for this scope, each once. */
export async function channelsFor(db: Db, event: MergeChatEvent, scope: EventScope): Promise<string[]> {
  const rows = await db
    .select()
    .from(mergeChatSubscriptions)
    .where(
      and(
        isNull(mergeChatSubscriptions.deletedAt),
        sql`${mergeChatSubscriptions.events} @> ${JSON.stringify([event])}::jsonb`,
      ),
    )
    .orderBy(asc(mergeChatSubscriptions.createdAt), asc(mergeChatSubscriptions.id));
  return subscribedChannels(rows, scope);
}

/** The subscriptions that post a daily digest. */
export async function digestSubscriptions(db: Db): Promise<MergeChatSubscriptionRow[]> {
  return db
    .select()
    .from(mergeChatSubscriptions)
    .where(
      and(
        isNull(mergeChatSubscriptions.deletedAt),
        sql`${mergeChatSubscriptions.events} @> ${JSON.stringify(['daily_digest'])}::jsonb`,
      ),
    )
    .orderBy(asc(mergeChatSubscriptions.createdAt), asc(mergeChatSubscriptions.id));
}

/** The next UTC `hour`:00 strictly after `from`. */
export function nextDigestAt(hour: number, from: Date): Date {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour, 0, 0, 0));
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
