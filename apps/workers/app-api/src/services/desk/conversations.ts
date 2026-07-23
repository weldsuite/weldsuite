/**
 * WeldDesk v2 — conversation create/list/get service.
 *
 * Mutations here never touch desk_conversations' state/waitingSince/
 * statistics columns directly — creation delegates its initial part to
 * `appendPart` (via `parts.ts`) so the stats rollup starts consistent.
 */

import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import type {
  DeskChannel,
  DeskConversation,
  DeskConversationSource,
  DeskDeliveredAs,
} from '@weldsuite/db/schema/desk-conversations';
import type { DeskConversationPart } from '@weldsuite/db/schema/desk-conversation-parts';
import { appendPart, maybeTimerUnsnooze } from './parts';
import type { ListConversationsQuery } from '@weldsuite/core-api-client/schemas/desk-conversations';

const conversations = schema.deskConversations;
const parts = schema.deskConversationParts;

// ---------------------------------------------------------------------------
// conversationNumber — atomic per-tenant counter
// ---------------------------------------------------------------------------

/**
 * Allocate the next human-facing conversation number for this tenant DB.
 *
 * No dedicated counter table exists yet (adding one needs a migration, which
 * is out of scope for this phase — see plan §5/§7). Instead this runs a
 * single atomic INSERT ... SELECT statement against desk_conversations
 * itself: `next = COALESCE(MAX(conversation_number), 0) + 1`. It's one SQL
 * round trip (safe under the Neon HTTP driver, which has no multi-statement
 * transactions), but it is NOT safe against two concurrent inserts computing
 * the same MAX() before either commits — there is no unique index on
 * conversation_number to force a retry. Acceptable for Phase 1 (no live
 * traffic yet per the plan); revisit with a dedicated sequence table +
 * unique index migration before this ships to real users.
 */
async function nextConversationNumber(db: Database): Promise<number> {
  const result = await db.execute<{ next: number }>(
    sql`SELECT COALESCE(MAX(${conversations.conversationNumber}), 0) + 1 AS next FROM ${conversations}`,
  );
  // neon-http and pglite return results in different shapes (`{ rows }` vs a
  // plain array) — normalise the same way project-labels does.
  const rows =
    (result as unknown as { rows?: Array<{ next: number }> }).rows ??
    (result as unknown as Array<{ next: number }>);
  return Number(rows?.[0]?.next ?? 1);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateConversationInput {
  channel: DeskChannel;
  deliveredAs?: DeskDeliveredAs;
  title?: string;
  subject?: string;
  body: string;
  contactId?: string | null;
  counterpartyId?: string | null;
  personId?: string | null;
  url?: string;
  customAttributes?: Record<string, unknown>;
  tags?: string[];
  /** The authenticated caller creating this conversation (admin-initiated). */
  authorUserId: string;
}

export async function createConversation(
  db: Database,
  input: CreateConversationInput,
): Promise<{ conversation: DeskConversation; part: DeskConversationPart }> {
  const id = generateId('dconv');
  const now = new Date();
  const conversationNumber = await nextConversationNumber(db);
  const deliveredAs: DeskDeliveredAs = input.deliveredAs ?? 'admin_initiated';
  const authorType = deliveredAs === 'customer_initiated' ? 'user' : 'admin';

  const source: DeskConversationSource = {
    type: input.channel,
    deliveredAs,
    subject: input.subject,
    body: input.body,
    authorType,
    authorId: input.authorUserId,
    url: input.url,
  };

  await db.insert(conversations).values({
    id,
    createdAt: now,
    updatedAt: now,
    conversationNumber,
    title: input.title ?? input.subject ?? null,
    state: 'open',
    read: authorType === 'admin',
    priority: false,
    waitingSince: null,
    snoozedUntil: null,
    adminAssigneeId: null,
    teamAssigneeId: null,
    contactId: input.contactId ?? null,
    counterpartyId: input.counterpartyId ?? null,
    personId: input.personId ?? null,
    channel: input.channel,
    source,
    customAttributes: input.customAttributes ?? null,
    tags: input.tags ?? null,
    conversationRating: null,
    statistics: {
      countReopens: 0,
      countAssignments: 0,
      countParts: 0,
      ...(deliveredAs === 'customer_initiated' ? { firstContactReplyAt: now.toISOString(), lastContactReplyAt: now.toISOString() } : {}),
    },
    aiAgentParticipated: false,
    aiAgent: null,
    ticketTypeId: null,
    ticketStateId: null,
    ticketCategory: null,
    ticketNumber: null,
    ticketAttributes: null,
    isShared: null,
  });

  // The initiating message is also the first timeline part. Route it through
  // appendPart so waitingSince/statistics start from a single consistent
  // source rather than being hand-rolled twice (here + in appendPart).
  const { conversation, part } = await appendPart(db, {
    conversationId: id,
    partType: 'comment',
    authorType,
    authorId: input.authorUserId,
    body: input.body,
  });

  return { conversation, part };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface ListConversationsResult {
  data: DeskConversation[];
  totalCount: number;
  hasMore: boolean;
  cursor: string | null;
}

function sortColumns(sort: ListConversationsQuery['sort']) {
  switch (sort) {
    case 'oldest':
      return [asc(conversations.createdAt), asc(conversations.id)];
    case 'waiting_longest':
      // NULLs (not waiting) sort last regardless of direction in Postgres by
      // default for ASC — explicit for clarity/portability.
      return [sql`${conversations.waitingSince} ASC NULLS LAST`, asc(conversations.id)];
    case 'priority_first':
      return [desc(conversations.priority), sql`${conversations.waitingSince} ASC NULLS LAST`, asc(conversations.id)];
    case 'newest':
    default:
      return [desc(conversations.createdAt), desc(conversations.id)];
  }
}

/**
 * Cursor format: opaque `o:<offset>`. Offset-based rather than keyset because
 * two of the four sorts order by mutable, nullable keys (waitingSince,
 * priority) where keyset gives no real stability anyway — the list refetches
 * on realtime events, so page drift self-heals.
 */
function parseCursor(cursor: string | undefined): number {
  if (!cursor?.startsWith('o:')) return 0;
  const offset = Number.parseInt(cursor.slice(2), 10);
  return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

export async function listConversations(
  db: Database,
  query: ListConversationsQuery,
): Promise<ListConversationsResult> {
  const limit = Math.min(query.limit ?? 25, 100);
  const offset = parseCursor(query.cursor);
  const conditions: SQL[] = [];

  if (query.state) conditions.push(eq(conversations.state, query.state));
  if (query.adminAssigneeId) conditions.push(eq(conversations.adminAssigneeId, query.adminAssigneeId));
  if (query.teamAssigneeId === 'unassigned') {
    conditions.push(isNull(conversations.teamAssigneeId));
  } else if (query.teamAssigneeId) {
    conditions.push(eq(conversations.teamAssigneeId, query.teamAssigneeId));
  }
  if (query.channel) conditions.push(eq(conversations.channel, query.channel));
  if (query.priority !== undefined) conditions.push(eq(conversations.priority, query.priority));
  if (query.tag) conditions.push(sql`${conversations.tags} @> ${JSON.stringify([query.tag])}::jsonb`);
  if (query.isTicket !== undefined) {
    conditions.push(
      query.isTicket ? sql`${conversations.ticketTypeId} IS NOT NULL` : isNull(conversations.ticketTypeId),
    );
  }
  if (query.contactId) conditions.push(eq(conversations.contactId, query.contactId));
  if (query.createdById) {
    // "Created by you" inbox — admin-initiated conversations authored by this user.
    // source is a jsonb snapshot ({ authorType, authorId, ... }); filter both fields.
    conditions.push(
      sql`${conversations.source} ->> 'authorType' = 'admin' AND ${conversations.source} ->> 'authorId' = ${query.createdById}`,
    );
  }
  if (query.mentionedUserId) {
    // Conversations with a note part whose metadata.mentionUserIds contains this user.
    // `?` is the jsonb "does array contain string element" containment operator —
    // written as a raw fragment since Drizzle's sql`` doesn't special-case it.
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${parts}
        WHERE ${parts.conversationId} = ${conversations.id}
          AND ${parts.partType} = 'note'
          AND ${parts.metadata} -> 'mentionUserIds' @> ${JSON.stringify([query.mentionedUserId])}::jsonb
      )`,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const order = sortColumns(query.sort);

  const [rows, countRes] = await Promise.all([
    db
      .select()
      .from(conversations)
      .where(where)
      .orderBy(...order)
      .offset(offset)
      .limit(limit + 1),
    db.select({ count: sql<number>`count(*)` }).from(conversations).where(where),
  ]);

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;

  // Lazy timer-unsnooze on the returned page (see parts.ts TODO for the
  // Phase-3 Durable Object alarm that will replace this).
  const resolved = await Promise.all(data.map((row) => maybeTimerUnsnooze(db, row)));

  const totalCount = Number(countRes[0]?.count ?? 0);
  const cursor = hasMore ? `o:${offset + limit}` : null;

  return { data: resolved, totalCount, hasMore, cursor };
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

export interface GetConversationResult {
  conversation: DeskConversation;
  parts?: DeskConversationPart[];
}

const MAX_PARTS = 500;

export async function getConversation(
  db: Database,
  id: string,
  options: { includeParts?: boolean } = {},
): Promise<GetConversationResult | null> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  if (!row) return null;

  const conversation = await maybeTimerUnsnooze(db, row);

  if (!options.includeParts) return { conversation };

  const partRows = await db
    .select()
    .from(parts)
    .where(eq(parts.conversationId, id))
    .orderBy(asc(parts.createdAt))
    .limit(MAX_PARTS);

  return { conversation, parts: partRows };
}
