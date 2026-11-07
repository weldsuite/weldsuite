/**
 * WeldDesk linked tickets: parent/child links, major incidents and merging
 * duplicates. The only writer of `desk_conversations.parentConversationId`,
 * `isMajorIncident` and `mergedIntoId`; every change also lands on the
 * timeline as an internal event (`linked`, `unlinked`, `merged_into`,
 * `merged_from`, `incident_marked`, `incident_unmarked`) through
 * appendDeskMessage.
 *
 * Rules:
 *   - One level: a child can't have children and a parent can't have a
 *     parent; no self-links. A major incident is a parent that is flagged, so
 *     it can't be a child, and a child can't be one.
 *   - Unmarking a major incident unlinks its children (they stay as they are
 *     otherwise).
 *   - A duplicate merges into a kept conversation of the same customer (same
 *     visitor, same email or verified email, or same CRM person). It can't
 *     have children, be a major incident or be merged already, and the kept
 *     one can't be merged away itself. The duplicate is closed; a later
 *     customer message on it lands on the kept one (appendDeskMessage).
 *
 * Callers publish the realtime and entity events for each change, in order.
 * The Rust twin is `weldsuite_desk_domain::links`.
 */

import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../schema';
import type { IdGenerator } from './mail-contacts';
import type { DeskConversation } from '../schema/desk-conversations';
import type { DeskEventType, DeskMessage, DeskMessageMetadata } from '../schema/desk-messages';
import { appendDeskMessage, DeskConversationNotFoundError } from './desk';

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const conversations = schema.deskConversations;
const visitors = schema.deskVisitors;

/** Why a link, merge or incident change was refused; routes answer 409 with `reason`. */
export type DeskLinkRefusal =
  | 'self'
  | 'parent_is_child'
  | 'has_children'
  | 'is_incident'
  | 'incident_child'
  | 'merged'
  | 'target_merged'
  | 'different_customer'
  | 'not_incident';

export class DeskLinkRejectedError extends Error {
  constructor(
    readonly reason: DeskLinkRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'DeskLinkRejectedError';
  }
}

/** One timeline entry a link change appended, with the conversation after it. */
export interface DeskLinkChange {
  conversation: DeskConversation;
  message: DeskMessage;
  /** See AppendDeskMessageResult.slaCheckAt. */
  slaCheckAt: Date | null;
}

export interface DeskLinkResult {
  /** The conversation the request was about, as it stands now. */
  conversation: DeskConversation;
  /** Every timeline entry written, in order (empty when nothing changed). */
  changes: DeskLinkChange[];
}

/** A linked conversation as the details panel lists it. */
export interface DeskConversationLinkSummary {
  id: string;
  conversationNumber: number;
  title: string | null;
  state: DeskConversation['state'];
  channel: DeskConversation['channel'];
  name: string | null;
  email: string | null;
  assigneeId: string | null;
  isMajorIncident: boolean;
}

export interface DeskConversationLinks {
  parent: DeskConversationLinkSummary | null;
  /** Ordered by number. */
  children: DeskConversationLinkSummary[];
  mergedInto: DeskConversationLinkSummary | null;
  /** The duplicates merged into this one, by number. */
  mergedFrom: DeskConversationLinkSummary[];
}

function summaryOf(row: DeskConversation): DeskConversationLinkSummary {
  return {
    id: row.id,
    conversationNumber: row.conversationNumber,
    title: row.title,
    state: row.state,
    channel: row.channel,
    name: row.name,
    email: row.email,
    assigneeId: row.assigneeId,
    isMajorIncident: row.isMajorIncident,
  };
}

async function findConversation(db: AnyDb, id: string): Promise<DeskConversation | null> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  return row ?? null;
}

async function loadConversation(db: AnyDb, id: string): Promise<DeskConversation> {
  const row = await findConversation(db, id);
  if (!row) throw new DeskConversationNotFoundError(id);
  return row;
}

/** A conversation's children, by number; `openOnly` leaves out closed and merged ones. */
async function childrenOf(db: AnyDb, id: string, openOnly = false): Promise<DeskConversation[]> {
  const filters = [eq(conversations.parentConversationId, id)];
  if (openOnly) filters.push(eq(conversations.state, 'open'), isNull(conversations.mergedIntoId));
  return db
    .select()
    .from(conversations)
    .where(and(...filters))
    .orderBy(asc(conversations.conversationNumber), asc(conversations.id));
}

async function hasChildren(db: AnyDb, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.parentConversationId, id))
    .limit(1);
  return Boolean(row);
}

type LinkColumns = Partial<Pick<DeskConversation, 'parentConversationId' | 'isMajorIncident' | 'mergedIntoId'>>;

async function writeLinkColumns(db: AnyDb, id: string, columns: LinkColumns): Promise<void> {
  await db
    .update(conversations)
    .set({ ...columns, updatedAt: new Date() })
    .where(eq(conversations.id, id));
}

interface EventInput {
  generateId: IdGenerator;
  authorId: string | null;
}

/** An internal link event on `conversationId`, naming the other conversation. */
async function linkEvent(
  db: AnyDb,
  input: EventInput,
  conversationId: string,
  eventType: DeskEventType,
  extra: DeskMessageMetadata = {},
): Promise<DeskLinkChange> {
  const result = await appendDeskMessage(db, {
    generateId: input.generateId,
    conversationId,
    kind: 'event',
    authorType: 'agent',
    authorId: input.authorId,
    metadata: { eventType, ...extra },
  });
  return result;
}

function otherOf(other: Pick<DeskConversation, 'id' | 'conversationNumber'>, linkRole?: 'parent' | 'child') {
  return {
    linkedConversationId: other.id,
    linkedConversationNumber: other.conversationNumber,
    ...(linkRole ? { linkRole } : {}),
  };
}

function lastFor(id: string, changes: DeskLinkChange[], fallback: DeskConversation): DeskConversation {
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    if (change?.conversation.id === id) return change.conversation;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The parent, children and merges of a conversation; null when it doesn't exist. */
export async function getDeskConversationLinks(db: AnyDb, id: string): Promise<DeskConversationLinks | null> {
  const conversation = await findConversation(db, id);
  if (!conversation) return null;
  const parent = conversation.parentConversationId
    ? await findConversation(db, conversation.parentConversationId)
    : null;
  const mergedInto = conversation.mergedIntoId ? await findConversation(db, conversation.mergedIntoId) : null;
  const children = await childrenOf(db, id);
  const mergedFrom = await db
    .select()
    .from(conversations)
    .where(eq(conversations.mergedIntoId, id))
    .orderBy(asc(conversations.conversationNumber), asc(conversations.id));
  return {
    parent: parent ? summaryOf(parent) : null,
    children: children.map(summaryOf),
    mergedInto: mergedInto ? summaryOf(mergedInto) : null,
    mergedFrom: mergedFrom.map(summaryOf),
  };
}

// ---------------------------------------------------------------------------
// Parent / child
// ---------------------------------------------------------------------------

export interface SetDeskConversationParentInput extends EventInput {
  conversationId: string;
  /** The new parent; null unlinks. */
  parentId: string | null;
}

/** Unlink `child` from `previousId`: an `unlinked` event on both (the parent's only if it still exists). */
async function unlinkFromParent(
  db: AnyDb,
  input: EventInput,
  child: DeskConversation,
  previousId: string,
): Promise<DeskLinkChange[]> {
  const previous = await findConversation(db, previousId);
  const changes: DeskLinkChange[] = [];
  changes.push(
    await linkEvent(db, input, child.id, 'unlinked', {
      linkedConversationId: previousId,
      linkedConversationNumber: previous?.conversationNumber ?? null,
      linkRole: 'parent',
    }),
  );
  if (previous) changes.push(await linkEvent(db, input, previous.id, 'unlinked', otherOf(child, 'child')));
  return changes;
}

/** Refuse a parent link the one-level rule doesn't allow. */
async function assertLinkable(db: AnyDb, child: DeskConversation, parent: DeskConversation): Promise<void> {
  if (child.mergedIntoId) {
    throw new DeskLinkRejectedError('merged', 'This ticket was merged into another one');
  }
  if (parent.mergedIntoId) {
    throw new DeskLinkRejectedError('target_merged', `Ticket #${parent.conversationNumber} was merged into another ticket`);
  }
  if (parent.parentConversationId) {
    throw new DeskLinkRejectedError(
      'parent_is_child',
      `Ticket #${parent.conversationNumber} is a child ticket itself, so it can't have child tickets`,
    );
  }
  if (child.isMajorIncident) {
    throw new DeskLinkRejectedError('is_incident', "A major incident can't be a child ticket");
  }
  if (await hasChildren(db, child.id)) {
    throw new DeskLinkRejectedError('has_children', "This ticket has child tickets, so it can't become a child ticket");
  }
}

/**
 * Set or clear a conversation's parent. Linking to another parent first
 * unlinks the current one. Each side gets its own `linked` / `unlinked` event.
 */
export async function setDeskConversationParent(
  db: AnyDb,
  input: SetDeskConversationParentInput,
): Promise<DeskLinkResult> {
  const child = await loadConversation(db, input.conversationId);
  const previousId = child.parentConversationId;

  if (input.parentId === null) {
    if (!previousId) return { conversation: child, changes: [] };
    await writeLinkColumns(db, child.id, { parentConversationId: null });
    const changes = await unlinkFromParent(db, input, child, previousId);
    return { conversation: lastFor(child.id, changes, child), changes };
  }

  if (input.parentId === child.id) {
    throw new DeskLinkRejectedError('self', "A ticket can't be linked to itself");
  }
  if (previousId === input.parentId) return { conversation: child, changes: [] };
  const parent = await loadConversation(db, input.parentId);
  await assertLinkable(db, child, parent);

  await writeLinkColumns(db, child.id, { parentConversationId: parent.id });
  const changes: DeskLinkChange[] = [];
  if (previousId) changes.push(...(await unlinkFromParent(db, input, child, previousId)));
  changes.push(await linkEvent(db, input, child.id, 'linked', otherOf(parent, 'parent')));
  changes.push(await linkEvent(db, input, parent.id, 'linked', otherOf(child, 'child')));
  return { conversation: lastFor(child.id, changes, child), changes };
}

// ---------------------------------------------------------------------------
// Major incidents
// ---------------------------------------------------------------------------

export interface SetDeskMajorIncidentInput extends EventInput {
  conversationId: string;
  isMajorIncident: boolean;
}

/**
 * Mark or unmark a major incident. A child or a merged duplicate can't be
 * one. Unmarking unlinks its children: each gets an `unlinked` event, and the
 * incident one `incident_unmarked` event with `unlinkedCount`.
 */
export async function setDeskMajorIncident(db: AnyDb, input: SetDeskMajorIncidentInput): Promise<DeskLinkResult> {
  const conversation = await loadConversation(db, input.conversationId);
  if (conversation.isMajorIncident === input.isMajorIncident) return { conversation, changes: [] };

  if (input.isMajorIncident) {
    if (conversation.parentConversationId) {
      throw new DeskLinkRejectedError('incident_child', "A child ticket can't be a major incident");
    }
    if (conversation.mergedIntoId) {
      throw new DeskLinkRejectedError('merged', 'This ticket was merged into another one');
    }
    await writeLinkColumns(db, conversation.id, { isMajorIncident: true });
    const change = await linkEvent(db, input, conversation.id, 'incident_marked');
    return { conversation: change.conversation, changes: [change] };
  }

  const children = await childrenOf(db, conversation.id);
  await writeLinkColumns(db, conversation.id, { isMajorIncident: false });
  const changes: DeskLinkChange[] = [];
  for (const child of children) {
    await writeLinkColumns(db, child.id, { parentConversationId: null });
    changes.push(await linkEvent(db, input, child.id, 'unlinked', otherOf(conversation, 'parent')));
  }
  changes.push(
    await linkEvent(db, input, conversation.id, 'incident_unmarked', { unlinkedCount: children.length }),
  );
  return { conversation: lastFor(conversation.id, changes, conversation), changes };
}

export interface PostDeskIncidentUpdateInput extends EventInput {
  incidentId: string;
  body: string;
}

/**
 * "Post an update to all linked customers": one agent reply, appended on the
 * incident and on each of its open children, with `metadata.incidentId`. The
 * caller delivers each one on its conversation's channel, as a reply.
 */
export async function postDeskIncidentUpdate(db: AnyDb, input: PostDeskIncidentUpdateInput): Promise<DeskLinkResult> {
  const incident = await loadConversation(db, input.incidentId);
  if (!incident.isMajorIncident) {
    throw new DeskLinkRejectedError('not_incident', 'This ticket is not a major incident');
  }
  const children = await childrenOf(db, incident.id, true);
  const changes: DeskLinkChange[] = [];
  for (const target of [incident, ...children]) {
    changes.push(
      await appendDeskMessage(db, {
        generateId: input.generateId,
        conversationId: target.id,
        kind: 'message',
        authorType: 'agent',
        authorId: input.authorId,
        body: input.body,
        metadata: { incidentId: incident.id },
      }),
    );
  }
  return { conversation: lastFor(incident.id, changes, incident), changes };
}

/**
 * Close a major incident's open children (the close action's `closeChildren`),
 * each with its normal `closed` event. Nothing for a conversation that isn't
 * an incident.
 */
export async function closeDeskIncidentChildren(
  db: AnyDb,
  input: EventInput & { incidentId: string },
): Promise<DeskLinkChange[]> {
  const incident = await findConversation(db, input.incidentId);
  if (!incident?.isMajorIncident) return [];
  const changes: DeskLinkChange[] = [];
  for (const child of await childrenOf(db, incident.id, true)) {
    changes.push(
      await linkEvent(db, input, child.id, 'closed', { assigneeId: null, incidentId: incident.id }),
    );
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Merging duplicates
// ---------------------------------------------------------------------------

function emailOf(value: string | null | undefined): string | null {
  return value?.trim().toLowerCase() || null;
}

/** The emails a conversation's customer is known by: its own and its visitor's verified one. */
async function customerEmails(db: AnyDb, rows: DeskConversation[]): Promise<Map<string, Set<string>>> {
  const visitorIds = rows.map((row) => row.visitorId).filter((id): id is string => Boolean(id));
  const verified = new Map<string, string>();
  if (visitorIds.length > 0) {
    const found = await db
      .select({ id: visitors.id, verifiedEmail: visitors.verifiedEmail })
      .from(visitors)
      .where(inArray(visitors.id, visitorIds));
    for (const visitor of found) {
      const email = emailOf(visitor.verifiedEmail);
      if (email) verified.set(visitor.id, email);
    }
  }
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const emails = new Set<string>();
    const own = emailOf(row.email);
    if (own) emails.add(own);
    const proven = row.visitorId ? verified.get(row.visitorId) : undefined;
    if (proven) emails.add(proven);
    out.set(row.id, emails);
  }
  return out;
}

/** Same customer: the same visitor, an email in common (own or verified), or the same CRM person. */
export async function isSameDeskCustomer(db: AnyDb, a: DeskConversation, b: DeskConversation): Promise<boolean> {
  if (a.visitorId && a.visitorId === b.visitorId) return true;
  if (a.contactId && a.contactId === b.contactId) return true;
  const emails = await customerEmails(db, [a, b]);
  const ofB = emails.get(b.id) ?? new Set<string>();
  return [...(emails.get(a.id) ?? [])].some((email) => ofB.has(email));
}

export interface MergeDeskConversationsInput extends EventInput {
  /** The duplicate, closed and marked merged. */
  sourceId: string;
  /** The conversation that is kept. */
  targetId: string;
}

export interface MergeDeskConversationsResult extends DeskLinkResult {
  /** The kept conversation after the merge. */
  target: DeskConversation;
}

/**
 * Merge duplicate `sourceId` into kept `targetId`: the duplicate gets
 * `mergedIntoId` and a `merged_into` event, is closed (its normal `closed`
 * event) when open, and the kept one gets a `merged_from` event.
 */
export async function mergeDeskConversations(
  db: AnyDb,
  input: MergeDeskConversationsInput,
): Promise<MergeDeskConversationsResult> {
  const source = await loadConversation(db, input.sourceId);
  if (input.targetId === source.id) {
    throw new DeskLinkRejectedError('self', "A ticket can't be merged into itself");
  }
  const target = await loadConversation(db, input.targetId);
  if (source.mergedIntoId) {
    throw new DeskLinkRejectedError('merged', 'This ticket was already merged into another one');
  }
  if (target.mergedIntoId) {
    throw new DeskLinkRejectedError('target_merged', `Ticket #${target.conversationNumber} was merged into another ticket`);
  }
  if (source.isMajorIncident) {
    throw new DeskLinkRejectedError('is_incident', "A major incident can't be merged");
  }
  if (await hasChildren(db, source.id)) {
    throw new DeskLinkRejectedError('has_children', "A ticket with child tickets can't be merged; unlink them first");
  }
  if (!(await isSameDeskCustomer(db, source, target))) {
    throw new DeskLinkRejectedError(
      'different_customer',
      'Only tickets of the same customer can be merged; link them to a major incident instead',
    );
  }

  await writeLinkColumns(db, source.id, { mergedIntoId: target.id });
  const changes: DeskLinkChange[] = [];
  changes.push(await linkEvent(db, input, source.id, 'merged_into', otherOf(target)));
  if (source.state === 'open') {
    changes.push(await linkEvent(db, input, source.id, 'closed', { assigneeId: null }));
  }
  changes.push(await linkEvent(db, input, target.id, 'merged_from', otherOf(source)));
  return {
    conversation: lastFor(source.id, changes, source),
    target: lastFor(target.id, changes, target),
    changes,
  };
}
