/**
 * WeldDesk conversation + message helpers.
 *
 * appendDeskMessage is the only writer for desk_messages and for
 * desk_conversations.state / waitingSince / lastMessage*.
 * updateDeskConversationAttributes is the only writer of the ticket fields
 * (type, priority, tags, team, custom fields). Callers inject generateId so
 * workers keep their own id format.
 */

import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  validateCustomFieldValue,
  type CustomFieldDefinitionLike,
  type CustomFieldValidationResult,
} from '@weldsuite/app-api-client/schemas/custom-fields';
import * as schema from '../schema';
import type { IdGenerator } from './mail-contacts';
import {
  getDefinitionsForTicket,
  getValuesForEntity,
  setValues,
  CustomFieldValidationError,
  type CustomFieldDefinitionRow,
  type CustomFieldMap,
} from './custom-field-values';
import type {
  DeskChannel,
  DeskConversation,
  DeskConversationState,
  DeskPriority,
} from '../schema/desk-conversations';
import type {
  DeskAttributeChange,
  DeskAuthorType,
  DeskMessage,
  DeskMessageAttachment,
  DeskMessageKind,
  DeskMessageMetadata,
} from '../schema/desk-messages';
import type { DeskVisitor } from '../schema/desk-visitors';
import { asText } from '@weldsuite/text';

export type { DeskConversation, DeskMessage, DeskVisitor };

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
      ? asText((err as { code: unknown }).code)
      : '';
  if (code === '42P01' || code === '42703') return true;
  const msg = err instanceof Error ? err.message : asText(err);
  return /column .+ does not exist/i.test(msg) || /relation .+ does not exist/i.test(msg);
}

function isUniqueViolation(err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? asText((err as { code: unknown }).code)
      : '';
  if (code === '23505') return true;
  const msg = err instanceof Error ? err.message : asText(err);
  return /duplicate key value/i.test(msg);
}

function previewOf(body: string | null | undefined): string | null {
  if (!body) return null;
  const trimmed = body.replace(/\s+/g, ' ').trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed;
}

/** List preview for a message that is only files: "📎 name" (+N more). */
function attachmentPreviewOf(attachments: DeskMessageAttachment[] | undefined): string | null {
  const [first] = attachments ?? [];
  if (!first || !attachments) return null;
  const more = attachments.length > 1 ? ` +${attachments.length - 1}` : '';
  return previewOf(`📎 ${first.name}${more}`);
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
    phone?: string | null;
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
        phone: input.phone !== undefined ? input.phone : existing[0].phone,
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
      phone: input.phone ?? null,
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
  attachments?: DeskMessageAttachment[];
  authorType?: DeskAuthorType;
  authorId?: string | null;
  metadata?: DeskMessageMetadata;
}

export async function createDeskConversation(
  db: AnyDb,
  input: CreateDeskConversationInput,
): Promise<{ conversation: DeskConversation; message: DeskMessage }> {
  const id = input.generateId('dconv');
  const now = new Date();
  const authorType: DeskAuthorType = input.authorType ?? 'visitor';
  const title = input.title ?? previewOf(input.body);

  // conversation_number is MAX+1 under a unique index, so two conversations
  // started in the same instant collide. Retry with a fresh number instead of
  // failing the visitor's first message.
  for (let attempt = 0; ; attempt++) {
    const conversationNumber = await nextConversationNumber(db);
    try {
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
      break;
    } catch (err) {
      if (attempt >= 4 || !isUniqueViolation(err)) throw err;
    }
  }

  return appendDeskMessage(db, {
    generateId: input.generateId,
    conversationId: id,
    kind: 'message',
    authorType,
    authorId: input.authorId ?? input.visitorId,
    body: input.body,
    attachments: input.attachments,
    metadata: input.metadata,
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

/** Conversation columns that a new message or event can change. */
interface DeskConversationProgress {
  state: DeskConversationState;
  waitingSince: Date | null;
  assigneeId: string | null;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
}

function progressOf(current: DeskConversation): DeskConversationProgress {
  return {
    state: current.state,
    waitingSince: current.waitingSince,
    assigneeId: current.assigneeId,
    lastMessageAt: current.lastMessageAt,
    lastMessagePreview: current.lastMessagePreview,
  };
}

/** Progress after a visitor/agent/bot chat message. */
function progressAfterMessage(
  current: DeskConversation,
  input: AppendDeskMessageInput,
  now: Date,
): DeskConversationProgress {
  const next: DeskConversationProgress = {
    ...progressOf(current),
    lastMessageAt: now,
    lastMessagePreview:
      previewOf(input.body) ?? attachmentPreviewOf(input.attachments) ?? current.lastMessagePreview,
  };
  if (input.authorType === 'visitor') {
    next.waitingSince = now;
    if (current.state === 'closed') next.state = 'open';
  } else if (input.authorType === 'agent' || input.authorType === 'bot') {
    next.waitingSince = null;
  }
  return next;
}

/** Progress after a conversation event (closed / reopened / assigned / unassigned). */
function progressAfterEvent(
  current: DeskConversation,
  input: AppendDeskMessageInput,
): DeskConversationProgress {
  const next = progressOf(current);
  switch (input.metadata?.eventType) {
    case 'closed':
      next.state = 'closed';
      next.waitingSince = null;
      break;
    case 'reopened':
      next.state = 'open';
      break;
    case 'assigned':
      next.assigneeId = input.assigneeId ?? input.metadata?.assigneeId ?? null;
      break;
    case 'unassigned':
      next.assigneeId = null;
      break;
  }
  return next;
}

function nextConversationProgress(
  current: DeskConversation,
  input: AppendDeskMessageInput,
  now: Date,
): DeskConversationProgress {
  if (input.kind === 'message') return progressAfterMessage(current, input, now);
  if (input.kind === 'event') return progressAfterEvent(current, input);
  return progressOf(current);
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
  const next = nextConversationProgress(current, input, now);
  // The owner is written back only by an event that changes it. Every other
  // append would put the value read above back over a claim another request
  // (auto-assignment runs right after a visitor message) made in between.
  const eventType = input.kind === 'event' ? input.metadata?.eventType : undefined;
  const ownerPatch =
    eventType === 'assigned' || eventType === 'unassigned' ? { assigneeId: next.assigneeId } : {};

  const messageId = input.generateId('dmsg');
  const assigneePatch = input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : null;
  const metadata: DeskMessageMetadata | null = input.metadata
    ? { ...input.metadata, ...assigneePatch }
    : assigneePatch;

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
      state: next.state,
      waitingSince: next.waitingSince,
      ...ownerPatch,
      lastMessageAt: next.lastMessageAt,
      lastMessagePreview: next.lastMessagePreview,
    })
    .where(eq(conversations.id, input.conversationId))
    .returning();

  return { conversation, message };
}

export const DESK_RATING_MIN = 1;
export const DESK_RATING_MAX = 5;

/** Why a rating was refused: the conversation is still open, or it was rated already. */
export class DeskRatingRejectedError extends Error {
  constructor(readonly reason: 'not_closed' | 'already_rated') {
    super(reason === 'not_closed' ? 'Only a closed conversation can be rated' : 'This conversation was already rated');
    this.name = 'DeskRatingRejectedError';
  }
}

export interface RateDeskConversationInput {
  generateId: IdGenerator;
  conversationId: string;
  /** Who rated: the widget visitor id. */
  authorId: string | null;
  rating: number;
  comment?: string | null;
}

/**
 * Store the visitor's CSAT answer on a closed conversation and put it on the
 * timeline as a `rated` event. One rating per conversation: the update only
 * lands while rated_at is still empty, so a double submit can't rate twice.
 */
export async function rateDeskConversation(
  db: AnyDb,
  input: RateDeskConversationInput,
): Promise<{ conversation: DeskConversation; message: DeskMessage }> {
  if (!Number.isInteger(input.rating) || input.rating < DESK_RATING_MIN || input.rating > DESK_RATING_MAX) {
    throw new RangeError(`Rating must be a whole number from ${DESK_RATING_MIN} to ${DESK_RATING_MAX}`);
  }
  const [current] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);
  if (!current) throw new DeskConversationNotFoundError(input.conversationId);
  if (current.state !== 'closed') throw new DeskRatingRejectedError('not_closed');
  if (current.ratedAt) throw new DeskRatingRejectedError('already_rated');

  const comment = input.comment?.trim() || null;
  const now = new Date();
  const [rated] = await db
    .update(conversations)
    .set({ rating: input.rating, ratingComment: comment, ratedAt: now, updatedAt: now })
    .where(and(eq(conversations.id, input.conversationId), isNull(conversations.ratedAt)))
    .returning({ id: conversations.id });
  if (!rated) throw new DeskRatingRejectedError('already_rated');

  return appendDeskMessage(db, {
    generateId: input.generateId,
    conversationId: input.conversationId,
    kind: 'event',
    authorType: 'visitor',
    authorId: input.authorId,
    metadata: { eventType: 'rated', rating: input.rating, ratingComment: comment },
  });
}

// ---------------------------------------------------------------------------
// Ticket fields
//
// The conversation is the ticket. Its type (helpdesk_ticket_types), priority,
// tags, team (helpdesk_departments) and the type's custom fields are set here
// and nowhere else, and every change lands on the timeline as an internal
// `attributes_changed` event.
// ---------------------------------------------------------------------------

/** custom_field_values.entity_type for a conversation's ticket fields. */
export const DESK_CONVERSATION_FIELD_ENTITY = 'desk_conversation';

export const DESK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const satisfies readonly DeskPriority[];
export const DESK_MAX_TAGS = 20;
export const DESK_MAX_TAG_LENGTH = 50;

/** Why an attribute change was refused; routes answer 400 with `message`. */
export class DeskAttributeRejectedError extends Error {
  constructor(
    readonly field: 'ticketTypeId' | 'departmentId' | 'customFields',
    message: string,
  ) {
    super(message);
    this.name = 'DeskAttributeRejectedError';
  }
}

export interface UpdateDeskConversationAttributesInput {
  generateId: IdGenerator;
  conversationId: string;
  authorType: DeskAuthorType;
  authorId?: string | null;
  /** undefined leaves a field alone; null clears it. */
  ticketTypeId?: string | null;
  priority?: DeskPriority | null;
  /** The full tag list (replaces the current one). */
  tags?: string[];
  departmentId?: string | null;
  /** Slug → value for the type's fields; null or '' clears one. */
  customFields?: CustomFieldMap;
}

export interface DeskConversationAttributesResult {
  conversation: DeskConversation;
  /** The `attributes_changed` event, or null when nothing changed. */
  message: DeskMessage | null;
  customFields: CustomFieldMap;
}

/** Trim, collapse spaces, drop empties and case-insensitive duplicates. */
export function normalizeDeskTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.replaceAll(/\s+/g, ' ').trim().slice(0, DESK_MAX_TAG_LENGTH);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out.slice(0, DESK_MAX_TAGS);
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function sameFieldValue(def: CustomFieldDefinitionRow, a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) || isEmptyValue(b)) return isEmptyValue(a) && isEmptyValue(b);
  if (def.fieldType === 'date') return new Date(a as string).getTime() === new Date(b as string).getTime();
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The custom field definitions that apply to a conversation of this type. */
export function getDeskConversationFieldDefinitions(
  db: AnyDb,
  ticketTypeId: string | null | undefined,
): Promise<CustomFieldDefinitionRow[]> {
  return getDefinitionsForTicket(db, ticketTypeId);
}

/** The conversation's custom field values (slug → value) for its current type. */
export async function getDeskConversationCustomFields(
  db: AnyDb,
  conversation: Pick<DeskConversation, 'id' | 'ticketTypeId'>,
): Promise<CustomFieldMap> {
  const definitions = await getDeskConversationFieldDefinitions(db, conversation.ticketTypeId);
  if (definitions.length === 0) return {};
  return getValuesForEntity(db, DESK_CONVERSATION_FIELD_ENTITY, conversation.id, definitions);
}

async function namesById(
  db: AnyDb,
  table: typeof schema.helpdeskTicketTypes | typeof schema.helpdeskDepartments,
  ids: Array<string | null>,
): Promise<Map<string, { name: string; usable: boolean }>> {
  const wanted = ids.filter((id): id is string => Boolean(id));
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: table.id, name: table.name, isActive: table.isActive, deletedAt: table.deletedAt })
    .from(table)
    .where(inArray(table.id, wanted));
  return new Map(rows.map((r) => [r.id, { name: r.name, usable: r.isActive !== false && !r.deletedAt }]));
}

/** Type and team changes, checked against their tables. */
async function referenceChanges(
  db: AnyDb,
  current: DeskConversation,
  input: UpdateDeskConversationAttributesInput,
): Promise<{ patch: Partial<DeskConversation>; changes: DeskAttributeChange[] }> {
  const patch: Partial<DeskConversation> = {};
  const changes: DeskAttributeChange[] = [];

  if (input.ticketTypeId !== undefined && input.ticketTypeId !== current.ticketTypeId) {
    const types = await namesById(db, schema.helpdeskTicketTypes, [current.ticketTypeId, input.ticketTypeId]);
    if (input.ticketTypeId && !types.get(input.ticketTypeId)?.usable) {
      throw new DeskAttributeRejectedError('ticketTypeId', `Ticket type '${input.ticketTypeId}' does not exist or is inactive`);
    }
    patch.ticketTypeId = input.ticketTypeId;
    changes.push({
      field: 'ticketType',
      from: current.ticketTypeId ? types.get(current.ticketTypeId)?.name ?? null : null,
      to: input.ticketTypeId ? types.get(input.ticketTypeId)?.name ?? null : null,
    });
  }

  if (input.departmentId !== undefined && input.departmentId !== current.departmentId) {
    const teams = await namesById(db, schema.helpdeskDepartments, [current.departmentId, input.departmentId]);
    if (input.departmentId && !teams.get(input.departmentId)?.usable) {
      throw new DeskAttributeRejectedError('departmentId', `Team '${input.departmentId}' does not exist or is inactive`);
    }
    patch.departmentId = input.departmentId;
    changes.push({
      field: 'team',
      from: current.departmentId ? teams.get(current.departmentId)?.name ?? null : null,
      to: input.departmentId ? teams.get(input.departmentId)?.name ?? null : null,
    });
  }

  return { patch, changes };
}

/**
 * Validate the custom field values against the type's definitions and work
 * out which ones change. Nothing is written yet.
 */
async function customFieldChanges(
  db: AnyDb,
  conversationId: string,
  definitions: CustomFieldDefinitionRow[],
  values: CustomFieldMap | undefined,
): Promise<{ changes: DeskAttributeChange[]; writes: CustomFieldMap }> {
  const changes: DeskAttributeChange[] = [];
  const writes: CustomFieldMap = {};
  if (!values || Object.keys(values).length === 0) return { changes, writes };

  const bySlug = new Map(definitions.map((d) => [d.slug, d]));
  const unknown = Object.keys(values).filter((slug) => !bySlug.has(slug));
  if (unknown.length > 0) {
    throw new DeskAttributeRejectedError('customFields', `Unknown field for this ticket type: ${unknown.join(', ')}`);
  }

  const stored = await getValuesForEntity(db, DESK_CONVERSATION_FIELD_ENTITY, conversationId, definitions);
  for (const [slug, raw] of Object.entries(values)) {
    const def = bySlug.get(slug);
    if (!def) continue;
    // Required is enforced by whoever closes or submits, not on every edit:
    // an agent may clear a field on the way to the right value.
    const result: CustomFieldValidationResult = isEmptyValue(raw)
      ? { ok: true, value: null }
      : validateCustomFieldValue(def as CustomFieldDefinitionLike, raw);
    if (!result.ok) {
      throw new DeskAttributeRejectedError('customFields', result.error ?? `Invalid value for '${slug}'`);
    }
    const next = result.value ?? null;
    const prev = stored[slug] ?? null;
    if (sameFieldValue(def, prev, next)) continue;
    writes[slug] = next;
    changes.push({ field: 'customField', key: slug, label: def.name, from: prev, to: next });
  }
  return { changes, writes };
}

/**
 * Set a conversation's ticket fields. Checks the type and team exist and are
 * active, validates custom field values against the (new) type, writes only
 * what changed, and appends one internal `attributes_changed` event listing
 * the changes. A call that changes nothing writes nothing.
 */
export async function updateDeskConversationAttributes(
  db: AnyDb,
  input: UpdateDeskConversationAttributesInput,
): Promise<DeskConversationAttributesResult> {
  const [current] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, input.conversationId))
    .limit(1);
  if (!current) throw new DeskConversationNotFoundError(input.conversationId);

  const { patch, changes } = await referenceChanges(db, current, input);

  if (input.priority !== undefined && input.priority !== current.priority) {
    patch.priority = input.priority;
    changes.push({ field: 'priority', from: current.priority, to: input.priority });
  }

  if (input.tags !== undefined) {
    const tags = normalizeDeskTags(input.tags);
    const before = current.tags ?? [];
    if (!sameTags(before, tags)) {
      patch.tags = tags;
      changes.push({ field: 'tags', from: before, to: tags });
    }
  }

  const ticketTypeId = patch.ticketTypeId !== undefined ? patch.ticketTypeId : current.ticketTypeId;
  const definitions = await getDeskConversationFieldDefinitions(db, ticketTypeId);
  const fields = await customFieldChanges(db, current.id, definitions, input.customFields);
  changes.push(...fields.changes);

  if (changes.length === 0) {
    const customFields = definitions.length
      ? await getValuesForEntity(db, DESK_CONVERSATION_FIELD_ENTITY, current.id, definitions)
      : {};
    return { conversation: current, message: null, customFields };
  }

  if (Object.keys(fields.writes).length > 0) {
    try {
      await setValues(db, DESK_CONVERSATION_FIELD_ENTITY, current.id, fields.writes, {
        generateId: input.generateId,
        definitions,
        enforceRequired: false,
      });
    } catch (err) {
      if (err instanceof CustomFieldValidationError) throw new DeskAttributeRejectedError('customFields', err.message);
      throw err;
    }
  }
  if (Object.keys(patch).length > 0) {
    await db
      .update(conversations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(conversations.id, current.id));
  }

  const { conversation, message } = await appendDeskMessage(db, {
    generateId: input.generateId,
    conversationId: current.id,
    kind: 'event',
    authorType: input.authorType,
    authorId: input.authorId ?? null,
    metadata: { eventType: 'attributes_changed', changes },
  });
  const customFields = definitions.length
    ? await getValuesForEntity(db, DESK_CONVERSATION_FIELD_ENTITY, current.id, definitions)
    : {};
  return { conversation, message, customFields };
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

/** A visitor's conversations, most recent activity first (messenger history). */
export function listDeskConversationsForVisitor(
  db: AnyDb,
  visitorId: string,
  limit = 25,
): Promise<DeskConversation[]> {
  return Promise.resolve(
    db
      .select()
      .from(conversations)
      .where(eq(conversations.visitorId, visitorId))
      .orderBy(sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt}) DESC`)
      .limit(Math.min(limit, 100))
  );
}

/**
 * Copy contact details a visitor supplied mid-conversation onto their
 * conversations that don't have them yet, so the inbox stops showing
 * "Visitor" once they leave an email. Never overwrites existing values.
 */
export async function attachDeskVisitorContact(
  db: AnyDb,
  visitorId: string,
  contact: { name?: string | null; email?: string | null },
): Promise<DeskConversation[]> {
  const updated: DeskConversation[] = [];
  const email = contact.email?.trim().toLowerCase() || null;
  const name = contact.name?.trim() || null;
  if (!email && !name) return updated;

  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.visitorId, visitorId));

  // One visitor's conversations, each patched on its own row: independent writes.
  const results = await Promise.all(
    rows.map(async (row) => {
      const patch: Partial<DeskConversation> = {};
      if (email && !row.email) patch.email = email;
      if (name && !row.name) patch.name = name;
      if (Object.keys(patch).length === 0) return undefined;
      const [next] = await db
        .update(conversations)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(conversations.id, row.id))
        .returning();
      return next;
    }),
  );
  for (const next of results) {
    if (next) updated.push(next);
  }
  return updated;
}

export interface ListDeskConversationsQuery {
  state?: DeskConversationState;
  assigneeId?: string;
  unassigned?: boolean;
  channel?: DeskChannel;
  visitorId?: string;
  /** Exact (case-insensitive) customer email, for "other conversations". */
  email?: string;
  /** Free text over customer, subject, number and message text. */
  q?: string;
  /** A priority, or `none` for conversations without one. */
  priority?: DeskPriority | 'none';
  ticketTypeId?: string;
  departmentId?: string;
  /** Conversations carrying this tag (exact match). */
  tag?: string;
  sort?: 'newest' | 'oldest' | 'waiting_longest';
  cursor?: string;
  limit?: number;
}

/** `%term%` for ILIKE, with the user's own `%`, `_` and `\` taken literally. */
function likePattern(term: string): string {
  const escaped = term.replaceAll(/[\\%_]/g, String.raw`\$&`);
  return `%${escaped}%`;
}

/**
 * Inbox search: customer name / email, subject, last preview, the
 * conversation number ("#42" or "42") and the text of any message or note.
 */
function searchCondition(q: string | undefined): SQL | undefined {
  const term = q?.trim();
  if (!term) return undefined;
  const pattern = likePattern(term);
  const parts: SQL[] = [
    sql`${conversations.name} ILIKE ${pattern}`,
    sql`${conversations.email} ILIKE ${pattern}`,
    sql`${conversations.title} ILIKE ${pattern}`,
    sql`${conversations.lastMessagePreview} ILIKE ${pattern}`,
    sql`EXISTS (SELECT 1 FROM ${messages} WHERE ${messages.conversationId} = ${conversations.id} AND ${messages.kind} <> 'event' AND ${messages.body} ILIKE ${pattern})`,
  ];
  const number = /^#?(\d{1,9})$/.exec(term);
  if (number) parts.push(eq(conversations.conversationNumber, Number(number[1])));
  return or(...parts);
}

function conversationOrderBy(sort: ListDeskConversationsQuery['sort']) {
  if (sort === 'oldest') return [conversations.createdAt, conversations.id];
  if (sort === 'waiting_longest') return [sql`${conversations.waitingSince} ASC NULLS LAST`, conversations.id];
  return [
    sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt}) DESC`,
    desc(conversations.id),
  ];
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
  if (query.email) filters.push(sql`lower(${conversations.email}) = ${query.email.trim().toLowerCase()}`);
  if (query.priority === 'none') filters.push(isNull(conversations.priority));
  else if (query.priority) filters.push(eq(conversations.priority, query.priority));
  if (query.ticketTypeId) filters.push(eq(conversations.ticketTypeId, query.ticketTypeId));
  if (query.departmentId) filters.push(eq(conversations.departmentId, query.departmentId));
  if (query.tag) filters.push(sql`${conversations.tags} @> ${JSON.stringify([query.tag])}::jsonb`);
  const search = searchCondition(query.q);
  if (search) filters.push(search);

  const where = filters.length > 0 ? and(...filters) : undefined;

  const orderBy = conversationOrderBy(query.sort);

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

export function listDeskMessages(
  db: AnyDb,
  conversationId: string,
): Promise<DeskMessage[]> {
  return Promise.resolve(
    db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt)
  );
}

/** Strip RFC 5322 angle brackets so In-Reply-To / References match stored ids. */
export function normalizeRfcMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim().replace(/^<|>$/g, '').trim();
  return trimmed || null;
}

export function normalizeEmailSubject(subject: string | null | undefined): string {
  if (!subject) return '';
  return subject.replace(/^(Re|Fwd|Fw):\s*/gi, '').trim();
}

export async function findDeskVisitorByEmail(
  db: AnyDb,
  email: string,
): Promise<DeskVisitor | null> {
  const [row] = await db
    .select()
    .from(visitors)
    .where(eq(visitors.email, email.toLowerCase()))
    .limit(1);
  return row ?? null;
}

export async function findDeskVisitorByPhone(
  db: AnyDb,
  phone: string,
): Promise<DeskVisitor | null> {
  const [row] = await db
    .select()
    .from(visitors)
    .where(eq(visitors.phone, phone))
    .limit(1);
  return row ?? null;
}

export async function findOpenPhoneConversationByPhone(
  db: AnyDb,
  phone: string,
): Promise<DeskConversation | null> {
  const visitor = await findDeskVisitorByPhone(db, phone);
  if (!visitor) return null;
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.visitorId, visitor.id),
        eq(conversations.channel, 'phone'),
        eq(conversations.state, 'open'),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);
  return row ?? null;
}

export interface IngestDeskPhoneInput {
  generateId: IdGenerator;
  fromNumber: string;
  toNumber: string;
  /** voip_calls.id */
  callId: string;
  callControlId?: string | null;
  body?: string;
  name?: string | null;
  contactId?: string | null;
  title?: string | null;
}

export async function ingestDeskPhone(
  db: AnyDb,
  input: IngestDeskPhoneInput,
): Promise<{ conversation: DeskConversation; message: DeskMessage; created: boolean }> {
  const fromNumber = input.fromNumber.trim();
  const displayName = input.name?.trim() || fromNumber;
  const title = input.title?.trim() || `Call from ${displayName}`;
  const body =
    input.body ??
    `Inbound call from ${displayName} to ${input.toNumber}`;

  let conversation = await findOpenPhoneConversationByPhone(db, fromNumber);

  let visitor = await findDeskVisitorByPhone(db, fromNumber);
  visitor = await upsertDeskVisitor(db, {
    id: visitor?.id ?? input.generateId('dvis'),
    name: input.name?.trim() || visitor?.name || fromNumber,
    phone: fromNumber,
  });

  const phoneMeta: DeskMessageMetadata = {
    callId: input.callId,
    callControlId: input.callControlId ?? undefined,
    fromNumber,
    toNumber: input.toNumber,
    event: 'call_started',
  };

  if (conversation) {
    const result = await appendDeskMessage(db, {
      generateId: input.generateId,
      conversationId: conversation.id,
      kind: 'message',
      authorType: 'visitor',
      authorId: visitor.id,
      body,
      metadata: phoneMeta,
    });
    return { ...result, created: false };
  }

  const result = await createDeskConversation(db, {
    generateId: input.generateId,
    channel: 'phone',
    visitorId: visitor.id,
    name: displayName,
    contactId: input.contactId ?? null,
    title,
    body,
    authorType: 'visitor',
    authorId: visitor.id,
    metadata: phoneMeta,
  });
  return { ...result, created: true };
}

export async function findDeskConversationByRfcMessageIds(
  db: AnyDb,
  ids: Array<string | null | undefined>,
): Promise<DeskConversation | null> {
  const normalized = ids
    .map((id) => normalizeRfcMessageId(id))
    .filter((id): id is string => Boolean(id));

  for (const id of normalized) {
    const [row] = await db
      .select({ conversationId: messages.conversationId })
      .from(messages)
      .where(
        sql`(${messages.metadata}->>'emailMessageId' = ${id} OR ${messages.metadata}->>'emailThreadMessageId' = ${id})`,
      )
      .limit(1);
    if (!row) continue;
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, row.conversationId))
      .limit(1);
    if (conversation) return conversation;
  }
  return null;
}

export async function findOpenEmailConversationByEmail(
  db: AnyDb,
  email: string,
): Promise<DeskConversation | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.channel, 'email'),
        eq(conversations.state, 'open'),
        eq(conversations.email, email.toLowerCase()),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);
  return row ?? null;
}

export async function findRecentEmailConversation(
  db: AnyDb,
  email: string,
  title: string,
): Promise<DeskConversation | null> {
  if (!title) return null;
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.channel, 'email'),
        eq(conversations.email, email.toLowerCase()),
        eq(conversations.title, title),
        sql`${conversations.lastMessageAt} > NOW() - INTERVAL '30 days'`,
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);
  return row ?? null;
}

export interface DeskEmailReplyContext {
  helpdeskAddress: string | null;
  lastEmailMessageId: string | null;
  references: string[];
  subject: string | null;
  customerEmail: string | null;
}

export async function getDeskEmailReplyContext(
  db: AnyDb,
  conversationId: string,
): Promise<DeskEmailReplyContext | null> {
  const result = await getDeskConversation(db, conversationId, { includeMessages: true });
  if (!result) return null;

  const references: string[] = [];
  let helpdeskAddress: string | null = null;
  let lastEmailMessageId: string | null = null;

  for (const message of result.messages) {
    const meta = (message.metadata ?? {}) as DeskMessageMetadata;
    if (typeof meta.helpdeskAddress === 'string' && meta.helpdeskAddress) {
      helpdeskAddress = meta.helpdeskAddress;
    }
    if (typeof meta.emailMessageId === 'string' && meta.emailMessageId) {
      lastEmailMessageId = meta.emailMessageId;
      references.push(meta.emailMessageId);
    }
  }

  return {
    helpdeskAddress,
    lastEmailMessageId,
    references: references.slice(-20),
    subject: result.conversation.title,
    customerEmail: result.conversation.email,
  };
}

/** Stamp the RFC Message-ID after an outbound send so later replies can thread. */
export async function stampDeskMessageEmailId(
  db: AnyDb,
  messageId: string,
  emailMessageId: string,
): Promise<void> {
  const rfcId = normalizeRfcMessageId(emailMessageId) ?? emailMessageId;
  const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!message) return;
  const metadata: DeskMessageMetadata = {
    ...message.metadata,
    emailMessageId: rfcId,
  };
  await db.update(messages).set({ metadata }).where(eq(messages.id, messageId));
}

export interface IngestDeskEmailInput {
  generateId: IdGenerator;
  fromName?: string | null;
  fromEmail: string;
  toAddress: string;
  subject: string;
  body: string;
  /** Files from the email, already stored where the inbox can open them. */
  attachments?: DeskMessageAttachment[];
  rfcMessageId: string;
  inReplyTo?: string | null;
  references?: string[];
  toEmails?: string[];
  ccEmails?: string[];
}

export async function ingestDeskEmail(
  db: AnyDb,
  input: IngestDeskEmailInput,
): Promise<{ conversation: DeskConversation; message: DeskMessage; created: boolean }> {
  const fromEmail = input.fromEmail.toLowerCase();
  const rfcMessageId = normalizeRfcMessageId(input.rfcMessageId) ?? input.rfcMessageId;
  const title = normalizeEmailSubject(input.subject) || input.subject || previewOf(input.body) || fromEmail;

  let conversation =
    (await findDeskConversationByRfcMessageIds(db, [input.inReplyTo, ...(input.references ?? [])])) ??
    (await findOpenEmailConversationByEmail(db, fromEmail)) ??
    (await findRecentEmailConversation(db, fromEmail, title));

  let visitor = await findDeskVisitorByEmail(db, fromEmail);
  visitor = await upsertDeskVisitor(db, {
    id: visitor?.id ?? input.generateId('dvis'),
    name: input.fromName ?? visitor?.name ?? fromEmail,
    email: fromEmail,
  });

  const emailMeta: DeskMessageMetadata = {
    emailMessageId: rfcMessageId,
    emailThreadMessageId: rfcMessageId,
    helpdeskAddress: input.toAddress,
    emailFrom: fromEmail,
    emailTo: input.toEmails ?? [input.toAddress],
    emailCc: input.ccEmails ?? [],
    emailSubject: input.subject,
  };

  if (conversation) {
    const result = await appendDeskMessage(db, {
      generateId: input.generateId,
      conversationId: conversation.id,
      kind: 'message',
      authorType: 'visitor',
      authorId: visitor.id,
      body: input.body,
      attachments: input.attachments,
      metadata: {
        ...emailMeta,
        emailThreadMessageId: undefined,
      },
    });
    return { ...result, created: false };
  }

  const result = await createDeskConversation(db, {
    generateId: input.generateId,
    channel: 'email',
    visitorId: visitor.id,
    name: input.fromName ?? fromEmail,
    email: fromEmail,
    title,
    body: input.body,
    attachments: input.attachments,
    authorType: 'visitor',
    authorId: visitor.id,
    metadata: emailMeta,
  });
  return { ...result, created: true };
}

// ---------------------------------------------------------------------------
// Visitor-facing wire format
//
// The messenger widget and the realtime ConversationRoom (which visitors are
// connected to) only ever see these shapes. Both helpdesk-widget-api and
// app-api build them here so the two writers can't drift apart. Internal
// notes are never converted — callers must filter them out first.
// ---------------------------------------------------------------------------

export interface DeskAuthorInfo {
  name: string;
  avatar: string | null;
}

export interface PublicDeskMessage {
  id: string;
  conversationId: string;
  kind: 'message' | 'event';
  body: string | null;
  authorType: DeskAuthorType;
  authorName: string | null;
  authorAvatar: string | null;
  attachments: DeskMessageAttachment[] | null;
  eventType: string | null;
  clientId: string | null;
  createdAt: string;
}

export interface PublicDeskConversation {
  id: string;
  conversationNumber: number;
  title: string | null;
  state: DeskConversationState;
  createdAt: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  /** True when the last public message came from the team (ball in the visitor's court). */
  lastMessageFromTeam: boolean;
  assignee: DeskAuthorInfo | null;
  /** The visitor's CSAT answer (1–5), null until they rate a closed conversation. */
  rating: number | null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Teammates are shown to visitors by first name only — never by email. */
export function deskAuthorFromMember(member: {
  name: string | null;
  picture: string | null;
}): DeskAuthorInfo {
  const firstName = member.name?.trim().split(/\s+/)[0];
  return { name: firstName || 'Support', avatar: member.picture ?? null };
}

/** Notes and ticket-field changes stay with the team. */
export function isPublicDeskMessage(message: DeskMessage): boolean {
  if (message.kind === 'note') return false;
  return !(message.kind === 'event' && message.metadata?.eventType === 'attributes_changed');
}

export function toPublicDeskMessage(
  message: DeskMessage,
  authors: Map<string, DeskAuthorInfo>,
): PublicDeskMessage {
  const author =
    message.authorType === 'agent' && message.authorId ? authors.get(message.authorId) : undefined;
  const metadata = message.metadata ?? {};
  let authorName: string | null = null;
  if (message.authorType === 'agent') authorName = author?.name ?? 'Support';
  else if (message.authorType === 'bot') authorName = 'Bot';
  return {
    id: message.id,
    conversationId: message.conversationId,
    kind: message.kind === 'event' ? 'event' : 'message',
    body: message.body,
    authorType: message.authorType,
    authorName,
    authorAvatar: author?.avatar ?? null,
    attachments: message.attachments,
    eventType: typeof metadata.eventType === 'string' ? metadata.eventType : null,
    clientId: typeof metadata.clientId === 'string' ? metadata.clientId : null,
    createdAt: toIso(message.createdAt) ?? new Date().toISOString(),
  };
}

export function toPublicDeskConversation(
  conversation: DeskConversation,
  authors: Map<string, DeskAuthorInfo>,
): PublicDeskConversation {
  return {
    id: conversation.id,
    conversationNumber: conversation.conversationNumber,
    title: conversation.title,
    state: conversation.state,
    createdAt: toIso(conversation.createdAt) ?? new Date().toISOString(),
    lastMessageAt: toIso(conversation.lastMessageAt),
    lastMessagePreview: conversation.lastMessagePreview,
    lastMessageFromTeam: conversation.waitingSince === null && conversation.lastMessageAt !== null,
    assignee: conversation.assigneeId ? authors.get(conversation.assigneeId) ?? null : null,
    rating: conversation.rating ?? null,
  };
}
