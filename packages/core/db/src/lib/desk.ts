/**
 * WeldDesk conversation + message helpers.
 *
 * appendDeskMessage is the only writer for desk_messages and for
 * desk_conversations.state / waitingSince / lastMessage*. Callers inject
 * generateId so workers keep their own id format.
 */

import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../schema';
import type { IdGenerator } from './mail-contacts';
import type {
  DeskChannel,
  DeskConversation,
  DeskConversationState,
} from '../schema/desk-conversations';
import type {
  DeskAuthorType,
  DeskMessage,
  DeskMessageAttachment,
  DeskMessageKind,
  DeskMessageMetadata,
} from '../schema/desk-messages';
import type { DeskVisitor } from '../schema/desk-visitors';

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const conversations = schema.deskConversations;
const messages = schema.deskMessages;
const visitors = schema.deskVisitors;

export class DeskConversationNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Conversation '${conversationId}' not found`);
    this.name = 'DeskConversationNotFoundError';
  }
}

/** Postgres undefined-table / undefined-column (migration 0185 not applied). */
export function isDeskSchemaMissing(err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  if (code === '42P01' || code === '42703') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /column .+ does not exist/i.test(msg) || /relation .+ does not exist/i.test(msg);
}

function previewOf(body: string | null | undefined): string | null {
  if (!body) return null;
  const trimmed = body.replace(/\s+/g, ' ').trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed;
}

async function nextConversationNumber(db: AnyDb): Promise<number> {
  const result = await db.execute<{ next: number }>(
    sql`SELECT COALESCE(MAX(${conversations.conversationNumber}), 0) + 1 AS next FROM ${conversations}`,
  );
  const rows =
    (result as unknown as { rows?: Array<{ next: number }> }).rows ??
    (result as unknown as Array<{ next: number }>);
  return Number(rows?.[0]?.next ?? 1);
}

export async function upsertDeskVisitor(
  db: AnyDb,
  input: {
    id: string;
    name?: string | null;
    email?: string | null;
    widgetId?: string | null;
  },
): Promise<DeskVisitor> {
  const now = new Date();
  const existing = await db
    .select()
    .from(visitors)
    .where(eq(visitors.id, input.id))
    .limit(1);

  if (existing[0]) {
    const [updated] = await db
      .update(visitors)
      .set({
        lastSeenAt: now,
        updatedAt: now,
        name: input.name !== undefined ? input.name : existing[0].name,
        email: input.email !== undefined ? input.email : existing[0].email,
        widgetId: input.widgetId !== undefined ? input.widgetId : existing[0].widgetId,
      })
      .where(eq(visitors.id, input.id))
      .returning();
    return updated ?? existing[0];
  }

  const [created] = await db
    .insert(visitors)
    .values({
      id: input.id,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      name: input.name ?? null,
      email: input.email ?? null,
      widgetId: input.widgetId ?? null,
    })
    .returning();
  return created;
}

export interface CreateDeskConversationInput {
  generateId: IdGenerator;
  channel?: DeskChannel;
  visitorId: string;
  name?: string | null;
  email?: string | null;
  contactId?: string | null;
  title?: string | null;
  body: string;
  authorType?: DeskAuthorType;
  authorId?: string | null;
}

export async function createDeskConversation(
  db: AnyDb,
  input: CreateDeskConversationInput,
): Promise<{ conversation: DeskConversation; message: DeskMessage }> {
  const id = input.generateId('dconv');
  const now = new Date();
  const conversationNumber = await nextConversationNumber(db);
  const authorType: DeskAuthorType = input.authorType ?? 'visitor';
  const title = input.title ?? previewOf(input.body);

  await db.insert(conversations).values({
    id,
    createdAt: now,
    updatedAt: now,
    conversationNumber,
    title,
    state: 'open',
    channel: input.channel ?? 'messenger',
    visitorId: input.visitorId,
    name: input.name ?? null,
    email: input.email ?? null,
    contactId: input.contactId ?? null,
    assigneeId: null,
    waitingSince: authorType === 'visitor' ? now : null,
    lastMessageAt: now,
    lastMessagePreview: previewOf(input.body),
  });

  return appendDeskMessage(db, {
    generateId: input.generateId,
    conversationId: id,
    kind: 'message',
    authorType,
    authorId: input.authorId ?? input.visitorId,
    body: input.body,
  });
}

export interface AppendDeskMessageInput {
  generateId: IdGenerator;
  conversationId: string;
  kind: DeskMessageKind;
  authorType: DeskAuthorType;
  authorId?: string | null;
  body?: string | null;
  attachments?: DeskMessageAttachment[];
  metadata?: DeskMessageMetadata;
  /** Required when kind=event and eventType is assigned. */
  assigneeId?: string | null;
}

export async function appendDeskMessage(
  db: AnyDb,
  input: AppendDeskMessageInput,
): Promise<{ conversation: DeskConversation; message: DeskMessage }> {
  const [current] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);

  if (!current) {
    throw new DeskConversationNotFoundError(input.conversationId);
  }

  const now = new Date();
  let nextState: DeskConversationState = current.state;
  let nextWaitingSince: Date | null = current.waitingSince;
  let nextAssigneeId: string | null = current.assigneeId;
  let nextLastMessageAt: Date | null = current.lastMessageAt;
  let nextLastMessagePreview: string | null = current.lastMessagePreview;

  const eventType = input.metadata?.eventType;

  if (input.kind === 'message') {
    nextLastMessageAt = now;
    nextLastMessagePreview = previewOf(input.body) ?? nextLastMessagePreview;
    if (input.authorType === 'visitor') {
      nextWaitingSince = now;
      if (current.state === 'closed') {
        nextState = 'open';
      }
    } else if (input.authorType === 'agent' || input.authorType === 'bot') {
      nextWaitingSince = null;
    }
  } else if (input.kind === 'event') {
    if (eventType === 'closed') {
      nextState = 'closed';
      nextWaitingSince = null;
    } else if (eventType === 'reopened') {
      nextState = 'open';
    } else if (eventType === 'assigned') {
      nextAssigneeId = input.assigneeId ?? input.metadata?.assigneeId ?? null;
    } else if (eventType === 'unassigned') {
      nextAssigneeId = null;
    }
  }

  const messageId = input.generateId('dmsg');
  const metadata: DeskMessageMetadata | null = input.metadata
    ? {
        ...input.metadata,
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      }
    : input.assigneeId !== undefined
      ? { assigneeId: input.assigneeId }
      : null;

  const [message] = await db
    .insert(messages)
    .values({
      id: messageId,
      createdAt: now,
      conversationId: input.conversationId,
      kind: input.kind,
      body: input.body ?? null,
      authorType: input.authorType,
      authorId: input.authorId ?? null,
      attachments: input.attachments ?? null,
      metadata,
    })
    .returning();

  const [conversation] = await db
    .update(conversations)
    .set({
      updatedAt: now,
      state: nextState,
      waitingSince: nextWaitingSince,
      assigneeId: nextAssigneeId,
      lastMessageAt: nextLastMessageAt,
      lastMessagePreview: nextLastMessagePreview,
    })
    .where(eq(conversations.id, input.conversationId))
    .returning();

  return { conversation, message };
}

export async function findOpenConversationForVisitor(
  db: AnyDb,
  visitorId: string,
): Promise<DeskConversation | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.visitorId, visitorId), eq(conversations.state, 'open')))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);
  return row ?? null;
}

export interface ListDeskConversationsQuery {
  state?: DeskConversationState;
  assigneeId?: string;
  unassigned?: boolean;
  channel?: DeskChannel;
  visitorId?: string;
  sort?: 'newest' | 'oldest' | 'waiting_longest';
  cursor?: string;
  limit?: number;
}

export async function listDeskConversations(
  db: AnyDb,
  query: ListDeskConversationsQuery,
): Promise<{ data: DeskConversation[]; totalCount: number; hasMore: boolean; cursor: string | null }> {
  const limit = Math.min(query.limit ?? 30, 100);
  const filters: SQL[] = [];

  if (query.state) filters.push(eq(conversations.state, query.state));
  if (query.assigneeId) filters.push(eq(conversations.assigneeId, query.assigneeId));
  if (query.unassigned) filters.push(isNull(conversations.assigneeId));
  if (query.channel) filters.push(eq(conversations.channel, query.channel));
  if (query.visitorId) filters.push(eq(conversations.visitorId, query.visitorId));

  const where = filters.length > 0 ? and(...filters) : undefined;

  const orderBy =
    query.sort === 'oldest'
      ? [conversations.createdAt, conversations.id]
      : query.sort === 'waiting_longest'
        ? [sql`${conversations.waitingSince} ASC NULLS LAST`, conversations.id]
        : [
            sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt}) DESC`,
            desc(conversations.id),
          ];

  const offset = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(conversations)
    .where(where);

  const totalCount = Number(count ?? 0);

  const data = await db
    .select()
    .from(conversations)
    .where(where)
    .orderBy(...orderBy)
    .limit(limit + 1)
    .offset(offset);

  const hasMore = data.length > limit;
  const page = hasMore ? data.slice(0, limit) : data;

  return {
    data: page,
    totalCount,
    hasMore,
    cursor: hasMore ? String(offset + limit) : null,
  };
}

export async function getDeskConversation(
  db: AnyDb,
  id: string,
  opts: { includeMessages?: boolean } = {},
): Promise<{ conversation: DeskConversation; messages: DeskMessage[] } | null> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);

  if (!conversation) return null;

  if (!opts.includeMessages) {
    return { conversation, messages: [] };
  }

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);

  return { conversation, messages: rows };
}

export async function listDeskMessages(
  db: AnyDb,
  conversationId: string,
): Promise<DeskMessage[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);
}
