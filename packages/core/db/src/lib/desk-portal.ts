/**
 * WeldDesk end-user identity and help-center requests.
 *
 * A *principal* is who is asking on the customer side: the visitor row their
 * token names, plus the email they proved (null for an anonymous visitor). A
 * conversation is theirs when it is on their own visitor row, or, once they
 * have a verified email, when it is on any visitor verified for that email or
 * came in by email from it. That is how one person sees the same requests in
 * the widget (identity token) and on the help center (email code).
 *
 * An email a visitor merely typed is never a key: only `verifiedEmail` is.
 */

import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  validateCustomFieldValue,
  type CustomFieldDefinitionLike,
} from '@weldsuite/app-api-client/schemas/custom-fields';
import type {
  DeskPortalField,
  DeskPortalRequestSummary,
  DeskPortalRequestType,
  DeskPortalStatus,
} from '@weldsuite/app-api-client/schemas/desk-portal';
import * as schema from '../schema';
import type { DeskConversation, DeskConversationState } from '../schema/desk-conversations';
import type { DeskMessage } from '../schema/desk-messages';
import type { DeskVisitor } from '../schema/desk-visitors';
import type { HelpdeskTicketType, TicketTypeField } from '../schema/helpdesk-ticket-types';
import type { IdGenerator } from './mail-contacts';
import { getDefinitionsForTicket, getValuesForEntity, setValues, type CustomFieldMap } from './custom-field-values';
import { createDeskConversation, DESK_CONVERSATION_FIELD_ENTITY } from './desk';

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const conversations = schema.deskConversations;
const visitors = schema.deskVisitors;
const ticketTypes = schema.helpdeskTicketTypes;

export interface DeskPrincipal {
  visitorId: string;
  /** Lower-cased proven email; null for an anonymous visitor. */
  verifiedEmail: string | null;
}

export function normalizeDeskEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function deskPrincipalOf(visitor: Pick<DeskVisitor, 'id' | 'verifiedEmail'>): DeskPrincipal {
  return { visitorId: visitor.id, verifiedEmail: visitor.verifiedEmail ? normalizeDeskEmail(visitor.verifiedEmail) : null };
}

/** The SQL condition "this conversation belongs to the principal". */
export function deskConversationsOwnedBy(principal: DeskPrincipal): SQL {
  const own = eq(conversations.visitorId, principal.visitorId);
  const email = principal.verifiedEmail;
  if (!email) return own;
  return or(
    own,
    inArray(
      conversations.visitorId,
      sql`(SELECT ${visitors.id} FROM ${visitors} WHERE lower(${visitors.verifiedEmail}) = ${email})`,
    ),
    and(eq(conversations.channel, 'email'), sql`lower(${conversations.email}) = ${email}`),
  ) as SQL;
}

/** Whether the principal may read and write this conversation. */
export async function canAccessDeskConversation(
  db: AnyDb,
  conversation: Pick<DeskConversation, 'id' | 'visitorId' | 'channel' | 'email'>,
  principal: DeskPrincipal,
): Promise<boolean> {
  if (conversation.visitorId === principal.visitorId) return true;
  const email = principal.verifiedEmail;
  if (!email) return false;
  if (conversation.channel === 'email' && conversation.email && normalizeDeskEmail(conversation.email) === email) {
    return true;
  }
  if (!conversation.visitorId) return false;
  const [owner] = await db
    .select({ verifiedEmail: visitors.verifiedEmail })
    .from(visitors)
    .where(eq(visitors.id, conversation.visitorId))
    .limit(1);
  return Boolean(owner?.verifiedEmail && normalizeDeskEmail(owner.verifiedEmail) === email);
}

/** The principal's conversations, most recent activity first. */
export async function listDeskConversationsForPrincipal(
  db: AnyDb,
  principal: DeskPrincipal,
  opts: { state?: DeskConversationState; cursor?: string; limit?: number } = {},
): Promise<{ rows: DeskConversation[]; hasMore: boolean; cursor: string | null }> {
  const limit = Math.min(opts.limit ?? 25, 100);
  const activity = sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt})`;
  const filters: SQL[] = [deskConversationsOwnedBy(principal)];
  if (opts.state) filters.push(eq(conversations.state, opts.state));
  if (opts.cursor) {
    const [cur] = await db
      .select({ at: activity, id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, opts.cursor))
      .limit(1);
    if (cur) {
      filters.push(
        or(sql`${activity} < ${cur.at}`, and(sql`${activity} = ${cur.at}`, lt(conversations.id, cur.id))) as SQL,
      );
    }
  }
  const rows = await db
    .select()
    .from(conversations)
    .where(and(...filters))
    .orderBy(desc(activity), desc(conversations.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { rows: page, hasMore, cursor: hasMore ? page.at(-1)?.id ?? null : null };
}

// ── visitors ────────────────────────────────────────────────────────────────

function insertedVisitor(row: DeskVisitor | undefined): DeskVisitor {
  if (!row) throw new Error('desk_visitors insert returned no row');
  return row;
}

/** A fresh anonymous visitor (the widget's first visit). */
export async function createAnonymousDeskVisitor(
  db: AnyDb,
  generateId: IdGenerator,
  widgetId: string | null,
): Promise<DeskVisitor> {
  const now = new Date();
  const [created] = await db
    .insert(visitors)
    .values({ id: generateId('dvis'), createdAt: now, updatedAt: now, lastSeenAt: now, widgetId })
    .returning();
  return insertedVisitor(created);
}

/**
 * The visitor for a person the customer's site vouched for (identity token):
 * one row per (widget, external user id). The token's email becomes the
 * verified email, so a changed address on their side follows here.
 */
export async function upsertIdentifiedDeskVisitor(
  db: AnyDb,
  generateId: IdGenerator,
  input: { widgetId: string; externalId: string; email?: string | null; name?: string | null },
): Promise<DeskVisitor> {
  const now = new Date();
  const email = input.email ? normalizeDeskEmail(input.email) : null;
  const name = input.name?.trim() || null;
  const [existing] = await db
    .select()
    .from(visitors)
    .where(and(eq(visitors.widgetId, input.widgetId), eq(visitors.externalId, input.externalId)))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(visitors)
      .set({
        lastSeenAt: now,
        updatedAt: now,
        name: name ?? existing.name,
        email: email ?? existing.email,
        verifiedEmail: email,
        verifiedAt: email && email !== existing.verifiedEmail ? now : existing.verifiedAt,
      })
      .where(eq(visitors.id, existing.id))
      .returning();
    return updated ?? existing;
  }

  try {
    const [created] = await db
      .insert(visitors)
      .values({
        id: generateId('dvis'),
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        widgetId: input.widgetId,
        externalId: input.externalId,
        name,
        email,
        verifiedEmail: email,
        verifiedAt: email ? now : null,
      })
      .returning();
    return insertedVisitor(created);
  } catch (err) {
    // Two first visits at once: the unique (widget, external id) index let one in.
    const [raced] = await db
      .select()
      .from(visitors)
      .where(and(eq(visitors.widgetId, input.widgetId), eq(visitors.externalId, input.externalId)))
      .limit(1);
    if (raced) return raced;
    throw err;
  }
}

/**
 * The visitor behind a help-center sign-in: the most recently seen visitor
 * verified for this email that no site identity owns, else a new one.
 */
export async function findOrCreateVerifiedDeskVisitor(
  db: AnyDb,
  generateId: IdGenerator,
  rawEmail: string,
): Promise<DeskVisitor> {
  const email = normalizeDeskEmail(rawEmail);
  const now = new Date();
  const [existing] = await db
    .select()
    .from(visitors)
    .where(and(sql`lower(${visitors.verifiedEmail}) = ${email}`, isNull(visitors.externalId)))
    .orderBy(desc(visitors.lastSeenAt))
    .limit(1);
  if (existing) {
    const [updated] = await db
      .update(visitors)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(eq(visitors.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  const [created] = await db
    .insert(visitors)
    .values({
      id: generateId('dvis'),
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      email,
      verifiedEmail: email,
      verifiedAt: now,
    })
    .returning();
  return insertedVisitor(created);
}

// ── status ──────────────────────────────────────────────────────────────────

/**
 * The customer-facing state group. Conversations only know open/closed, so
 * the last speaker and the owner pick the group until ticket states exist.
 */
export function deskPortalStatus(
  conversation: Pick<DeskConversation, 'state' | 'waitingSince' | 'lastMessageAt' | 'assigneeId'>,
): DeskPortalStatus {
  if (conversation.state === 'closed') return 'resolved';
  if (conversation.waitingSince === null && conversation.lastMessageAt !== null) return 'waiting_on_customer';
  return conversation.assigneeId ? 'in_progress' : 'submitted';
}

/** The type's own customer wording for a status group, if it has one. */
export function deskPortalStatusLabel(type: Pick<HelpdeskTicketType, 'states'> | undefined, status: DeskPortalStatus): string | null {
  const group = type?.states?.find((g) => g.groupKey === status);
  return group?.customerGroupLabel?.trim() || null;
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toDeskPortalSummary(
  conversation: DeskConversation,
  type: HelpdeskTicketType | undefined,
): DeskPortalRequestSummary {
  const status = deskPortalStatus(conversation);
  return {
    id: conversation.id,
    number: conversation.conversationNumber,
    title: conversation.title,
    status,
    statusLabel: deskPortalStatusLabel(type, status),
    typeName: type?.name ?? null,
    createdAt: toIso(conversation.createdAt),
    updatedAt: toIso(conversation.lastMessageAt ?? conversation.updatedAt),
    lastMessagePreview: conversation.lastMessagePreview,
  };
}

/** The ticket types of these conversations, by id (deleted ones included, for history). */
export async function deskTicketTypesById(
  db: AnyDb,
  ids: Array<string | null>,
): Promise<Map<string, HelpdeskTicketType>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select().from(ticketTypes).where(inArray(ticketTypes.id, wanted));
  return new Map(rows.map((row) => [row.id, row]));
}

// ── request form ────────────────────────────────────────────────────────────

const TITLE_KEY = 'title';
const DESCRIPTION_KEY = 'description';

function customerFields(type: Pick<HelpdeskTicketType, 'fields'>): TicketTypeField[] {
  return [...(type.fields ?? [])]
    .filter((f) => f.customerVisible !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function toPortalField(field: TicketTypeField): DeskPortalField {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: Boolean(field.required),
    placeholder: field.placeholder ?? null,
    helpText: field.helpText ?? null,
    options: field.options ?? [],
    conditions: field.conditions ?? [],
  };
}

/** A type a customer may pick: active, not deleted, in the `customer` category. */
function isCustomerType(type: HelpdeskTicketType): boolean {
  return type.isActive !== false && !type.deletedAt && (type.category ?? 'customer') === 'customer';
}

export function toDeskPortalRequestType(type: HelpdeskTicketType): DeskPortalRequestType {
  const all = type.fields ?? [];
  const title = all.find((f) => f.key === TITLE_KEY);
  const description = all.find((f) => f.key === DESCRIPTION_KEY);
  const showDescription = !description || description.customerVisible !== false;
  return {
    id: type.id,
    name: type.name,
    description: type.description ?? null,
    icon: type.icon ?? null,
    color: type.color ?? null,
    titleLabel: title?.label || 'Subject',
    descriptionLabel: showDescription ? description?.label || 'Description' : null,
    descriptionRequired: showDescription && Boolean(description?.required),
    fields: customerFields(type)
      .filter((f) => !f.isDefault && f.key !== TITLE_KEY && f.key !== DESCRIPTION_KEY)
      .map(toPortalField),
  };
}

/** The types offered on the request form, in the team's order. */
export async function listDeskPortalRequestTypes(db: AnyDb): Promise<DeskPortalRequestType[]> {
  const rows = await db
    .select()
    .from(ticketTypes)
    .where(and(isNull(ticketTypes.deletedAt), eq(ticketTypes.isActive, true)))
    .orderBy(asc(ticketTypes.sortOrder), asc(ticketTypes.name));
  return rows.filter(isCustomerType).map(toDeskPortalRequestType);
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function conditionText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(',');
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Whether a field is shown, given the answers so far (all its conditions must hold). */
export function isDeskPortalFieldShown(
  field: Pick<DeskPortalField, 'conditions'>,
  answers: Record<string, unknown>,
): boolean {
  return field.conditions.every((cond) => {
    const answer = answers[cond.field];
    switch (cond.operator) {
      case 'is_set':
        return !isBlank(answer);
      case 'is_not_set':
        return isBlank(answer);
      case 'equals':
        return Array.isArray(answer) ? answer.map(String).includes(cond.value ?? '') : conditionText(answer) === (cond.value ?? '');
      case 'not_equals':
        return Array.isArray(answer) ? !answer.map(String).includes(cond.value ?? '') : conditionText(answer) !== (cond.value ?? '');
      default:
        return true;
    }
  });
}

/** A field problem on submit; `field` is the form key. */
export class DeskPortalRequestRejectedError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeskPortalRequestRejectedError';
  }
}

function fieldTypeOf(field: DeskPortalField): CustomFieldDefinitionLike['fieldType'] {
  switch (field.type) {
    case 'select':
      return 'single_select';
    case 'multiselect':
      return 'multi_select';
    case 'checkbox':
      return 'boolean';
    default:
      return field.type;
  }
}

/**
 * Check the answers against the type: unknown keys refused, hidden fields
 * dropped, required fields of the shown ones enforced, each value validated
 * like a custom field. Returns the values to store, by field key.
 */
export function validateDeskPortalAnswers(
  type: DeskPortalRequestType,
  input: { title: string; description?: string; fields?: Record<string, unknown> },
): CustomFieldMap {
  const raw = input.fields ?? {};
  const byKey = new Map(type.fields.map((f) => [f.key, f]));
  const unknown = Object.keys(raw).filter((key) => !byKey.has(key));
  if (unknown.length > 0) throw new DeskPortalRequestRejectedError(unknown[0] ?? 'fields', `Unknown field: ${unknown.join(', ')}`);
  if (type.descriptionRequired && !input.description?.trim()) {
    throw new DeskPortalRequestRejectedError(DESCRIPTION_KEY, `${type.descriptionLabel ?? 'Description'} is required`);
  }

  const answers: Record<string, unknown> = { ...raw, [TITLE_KEY]: input.title, [DESCRIPTION_KEY]: input.description };
  const values: CustomFieldMap = {};
  for (const field of type.fields) {
    if (!isDeskPortalFieldShown(field, answers)) continue;
    const value = raw[field.key];
    if (isBlank(value)) {
      if (field.required) throw new DeskPortalRequestRejectedError(field.key, `${field.label} is required`);
      continue;
    }
    const result = validateCustomFieldValue(
      { slug: field.key, fieldType: fieldTypeOf(field), options: field.options },
      value,
    );
    if (!result.ok) throw new DeskPortalRequestRejectedError(field.key, `${field.label}: ${result.error ?? 'invalid value'}`);
    values[field.key] = result.value ?? null;
  }
  return values;
}

export interface CreateDeskPortalRequestInput {
  generateId: IdGenerator;
  visitor: Pick<DeskVisitor, 'id' | 'name' | 'email' | 'verifiedEmail'>;
  ticketTypeId: string;
  title: string;
  description?: string;
  fields?: Record<string, unknown>;
}

/**
 * Submit a help-center request: a `portal` conversation of the chosen type,
 * with the type's default priority and team, the description as the first
 * message and the other answers as the conversation's custom field values.
 */
export async function createDeskPortalRequest(
  db: AnyDb,
  input: CreateDeskPortalRequestInput,
): Promise<{ conversation: DeskConversation; message: DeskMessage; type: HelpdeskTicketType }> {
  const [type] = await db.select().from(ticketTypes).where(eq(ticketTypes.id, input.ticketTypeId)).limit(1);
  if (!type || !isCustomerType(type)) {
    throw new DeskPortalRequestRejectedError('ticketTypeId', 'This request type is not available');
  }
  const form = toDeskPortalRequestType(type);
  const values = validateDeskPortalAnswers(form, input);

  const departmentId = type.defaultDepartmentId ? await activeDepartment(db, type.defaultDepartmentId) : null;
  const priority = ['low', 'medium', 'high', 'urgent'].includes(type.defaultPriority ?? '')
    ? (type.defaultPriority as DeskConversation['priority'])
    : null;
  const email = input.visitor.verifiedEmail ?? input.visitor.email ?? null;

  const { conversation, message } = await createDeskConversation(db, {
    generateId: input.generateId,
    channel: 'portal',
    visitorId: input.visitor.id,
    name: input.visitor.name,
    email: email ? normalizeDeskEmail(email) : null,
    title: input.title.trim(),
    body: input.description?.trim() || input.title.trim(),
    authorType: 'visitor',
    authorId: input.visitor.id,
    ticketTypeId: type.id,
    priority,
    departmentId,
  });

  if (Object.keys(values).length > 0) {
    const definitions = await getDefinitionsForTicket(db, type.id);
    const known = new Set(definitions.map((d) => d.slug));
    const storable = Object.fromEntries(Object.entries(values).filter(([key]) => known.has(key)));
    const missing = Object.keys(values).filter((key) => !known.has(key));
    if (missing.length > 0) {
      console.warn(`[desk-portal] no custom field definition for ${missing.join(', ')} on type ${type.id}`);
    }
    if (Object.keys(storable).length > 0) {
      await setValues(db, DESK_CONVERSATION_FIELD_ENTITY, conversation.id, storable, {
        generateId: input.generateId,
        definitions,
        enforceRequired: false,
      });
    }
  }
  return { conversation, message, type };
}

async function activeDepartment(db: AnyDb, id: string): Promise<string | null> {
  const [row] = await db
    .select({ id: schema.helpdeskDepartments.id, isActive: schema.helpdeskDepartments.isActive, deletedAt: schema.helpdeskDepartments.deletedAt })
    .from(schema.helpdeskDepartments)
    .where(eq(schema.helpdeskDepartments.id, id))
    .limit(1);
  return row && row.isActive !== false && !row.deletedAt ? row.id : null;
}

function displayValue(field: DeskPortalField, value: unknown): string {
  const label = (v: unknown) => field.options.find((o) => o.value === String(v))?.label ?? String(v);
  if (Array.isArray(value)) return value.map(label).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field.type === 'date' && value) return String(value).slice(0, 10);
  if (field.type === 'select') return label(value);
  return String(value);
}

/** The customer-visible answers of a request, in form order, ready to show. */
export async function getDeskPortalRequestFields(
  db: AnyDb,
  conversation: Pick<DeskConversation, 'id' | 'ticketTypeId'>,
  type: HelpdeskTicketType | undefined,
): Promise<Array<{ key: string; label: string; value: string }>> {
  if (!type || !conversation.ticketTypeId) return [];
  const form = toDeskPortalRequestType(type);
  if (form.fields.length === 0) return [];
  const definitions = await getDefinitionsForTicket(db, type.id);
  const stored = await getValuesForEntity(db, DESK_CONVERSATION_FIELD_ENTITY, conversation.id, definitions);
  return form.fields
    .filter((field) => !isBlank(stored[field.key]))
    .map((field) => ({ key: field.key, label: field.label, value: displayValue(field, stored[field.key]) }));
}
