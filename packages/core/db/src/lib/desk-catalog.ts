/**
 * WeldDesk service catalogue: request items, each with its own form (a
 * customer ticket type), approval steps and fulfilment tasks. The only writer
 * of `desk_catalog_items`, `desk_request_approvals` and
 * `desk_conversations.catalog_item_id` / `.approval_status`; every approval
 * step lands on the timeline as an internal event (`approval_requested`,
 * `approval_approved`, `approval_rejected`, `fulfilment_started`) through
 * appendDeskMessage.
 *
 * A request is an inbox conversation with `catalog_item_id` set:
 *   - from the help center: createDeskCatalogPortalRequest (the item's form
 *     is its ticket type, so the conversation is a normal portal request that
 *     is then started as a service request);
 *   - from the inbox: an agent attaches an item to an existing conversation
 *     (startDeskCatalogRequest, after setting its type, team and priority).
 *
 * Starting a request copies the item's steps into `desk_request_approvals`
 * (the approver resolved to a user id at that moment, a later change to the
 * item never changes a request under way). Steps are decided in order: the
 * first is `pending`, the rest `waiting`. Approving the last step approves the
 * request (fulfilment is due: the caller creates the item's tasks); a
 * rejection skips the remaining steps and rejects it. A request without steps
 * has `approval_status` null and fulfilment is due at once.
 *
 * Callers publish the changes (entity + realtime events) in order. Creating
 * the fulfilment tasks and notifying approvers is `@weldsuite/desk-domain/catalog`.
 * The Rust twin is `weldsuite_desk_domain::catalog`.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { TenantDb } from './any-db';
import type { DeskPortalCatalogItem, DeskPortalRequestType } from '@weldsuite/app-api-client/schemas/desk-portal';
import * as schema from '../schema';
import {
  DESK_CATALOG_APPROVER_TYPES,
  DESK_CATALOG_MAX_APPROVAL_STEPS,
  DESK_CATALOG_MAX_FULFILMENT_TASKS,
  type DeskCatalogApprovalStep,
  type DeskCatalogFulfilmentTask,
  type DeskCatalogItem,
  type DeskRequestApproval,
  type DeskRequestApprovalStatus,
} from '../schema/desk-catalog';
import type { DeskConversation, DeskPriority } from '../schema/desk-conversations';
import type { DeskAuthorType, DeskEventType, DeskMessage } from '../schema/desk-messages';
import type { DeskVisitor } from '../schema/desk-visitors';
import type { HelpdeskTicketType } from '../schema/helpdesk-ticket-types';
import type { IdGenerator } from './mail-contacts';
import { appendDeskMessage, DeskConversationNotFoundError } from './desk';
import { deskReaderOf } from './desk-articles';
import { memberUserId } from './desk-escalation';
import type { DeskLinkChange } from './desk-links';
import {
  createDeskPortalRequest,
  isCustomerType,
  toDeskPortalRequestType,
  type DeskPrincipal,
} from './desk-portal';

type AnyDb = TenantDb;

const items = schema.deskCatalogItems;
const approvals = schema.deskRequestApprovals;
const conversations = schema.deskConversations;
const ticketTypes = schema.helpdeskTicketTypes;
const departments = schema.helpdeskDepartments;
const members = schema.workspaceMembers;

export type { DeskCatalogItem, DeskRequestApproval };

const PRIORITIES: readonly string[] = ['low', 'medium', 'high', 'urgent'];

// ============================================================================
// Errors
// ============================================================================

/** An item that can't be saved; `field` names the input (`ticketTypeId`, `approvalSteps`, …). Routes answer 400 with `details.field`. */
export class DeskCatalogRejectedError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeskCatalogRejectedError';
  }
}

/** Why a request couldn't start or an approval couldn't be decided; routes answer 409 with `details.reason`. */
export type DeskCatalogRefusal =
  | 'already_request'
  | 'merged'
  | 'closed'
  | 'item_inactive'
  | 'not_pending'
  | 'not_approver';

export class DeskCatalogRefusedError extends Error {
  constructor(
    readonly reason: DeskCatalogRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'DeskCatalogRefusedError';
  }
}

export class DeskCatalogItemNotFoundError extends Error {
  constructor(readonly itemId: string) {
    super(`Catalogue item '${itemId}' not found`);
    this.name = 'DeskCatalogItemNotFoundError';
  }
}

// ============================================================================
// Items
// ============================================================================

export interface DeskCatalogApprovalStepInput {
  id?: string;
  name?: string | null;
  approverType: DeskCatalogApprovalStep['approverType'];
  approverId?: string | null;
  departmentId?: string | null;
}

export interface DeskCatalogFulfilmentTaskInput {
  id?: string;
  title: string;
  description?: string | null;
  assigneeId?: string | null;
  dueInDays?: number | null;
}

export interface DeskCatalogItemInput {
  name: string;
  summary?: string | null;
  description?: string | null;
  category?: string | null;
  icon?: string | null;
  ticketTypeId: string;
  departmentId?: string | null;
  priority?: DeskPriority | null;
  deliveryEstimate?: string | null;
  approvalSteps?: DeskCatalogApprovalStepInput[];
  fulfilmentTasks?: DeskCatalogFulfilmentTaskInput[];
  audienceCompanyIds?: string[];
  isActive?: boolean;
  sortOrder?: number;
}

export type DeskCatalogItemPatch = Partial<DeskCatalogItemInput>;

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** An active internal member, by user id. */
async function activeMemberUserId(db: AnyDb, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: members.userId })
    .from(members)
    .where(
      and(
        eq(members.userId, userId),
        isNull(members.deletedAt),
        sql`upper(${members.status}) = 'ACTIVE'`,
        sql`upper(${members.memberType}) = 'INTERNAL'`,
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

async function assertTicketType(db: AnyDb, id: string): Promise<void> {
  const [type] = await db.select().from(ticketTypes).where(eq(ticketTypes.id, id)).limit(1);
  if (!type || !isCustomerType(type)) {
    throw new DeskCatalogRejectedError('ticketTypeId', 'The form has to be an active customer ticket type');
  }
}

async function assertTeam(db: AnyDb, id: string, field: string): Promise<void> {
  const [team] = await db
    .select({ isActive: departments.isActive, deletedAt: departments.deletedAt })
    .from(departments)
    .where(eq(departments.id, id))
    .limit(1);
  if (!team || team.deletedAt || team.isActive === false) {
    throw new DeskCatalogRejectedError(field, 'This team does not exist or is not active');
  }
}

/** One step under its id: a member step needs an active member, a team named on a manager step has to be active. */
async function normalizeStep(db: AnyDb, id: string, step: DeskCatalogApprovalStepInput): Promise<DeskCatalogApprovalStep> {
  const name = text(step.name) ?? undefined;
  if (step.approverType === 'member') {
    const approverId = text(step.approverId);
    if (!approverId || !(await activeMemberUserId(db, approverId))) {
      throw new DeskCatalogRejectedError('approvalSteps', 'A member step needs an active member as approver');
    }
    return { id, ...(name ? { name } : {}), approverType: 'member', approverId };
  }
  const departmentId = text(step.departmentId);
  if (departmentId) await assertTeam(db, departmentId, 'approvalSteps');
  return { id, ...(name ? { name } : {}), approverType: 'team_manager', departmentId };
}

async function normalizeSteps(
  db: AnyDb,
  generateId: IdGenerator,
  input: DeskCatalogApprovalStepInput[],
): Promise<DeskCatalogApprovalStep[]> {
  if (input.length > DESK_CATALOG_MAX_APPROVAL_STEPS) {
    throw new DeskCatalogRejectedError('approvalSteps', `At most ${DESK_CATALOG_MAX_APPROVAL_STEPS} approval steps`);
  }
  const seen = new Set<string>();
  const out: DeskCatalogApprovalStep[] = [];
  for (const step of input) {
    if (!DESK_CATALOG_APPROVER_TYPES.includes(step.approverType)) {
      throw new DeskCatalogRejectedError('approvalSteps', 'Unknown approver type');
    }
    const id = step.id?.trim() || generateId('dstep');
    if (seen.has(id)) throw new DeskCatalogRejectedError('approvalSteps', 'Approval step ids must be unique');
    seen.add(id);
    out.push(await normalizeStep(db, id, step));
  }
  return out;
}

function normalizeTasks(generateId: IdGenerator, input: DeskCatalogFulfilmentTaskInput[]): DeskCatalogFulfilmentTask[] {
  if (input.length > DESK_CATALOG_MAX_FULFILMENT_TASKS) {
    throw new DeskCatalogRejectedError('fulfilmentTasks', `At most ${DESK_CATALOG_MAX_FULFILMENT_TASKS} fulfilment tasks`);
  }
  const seen = new Set<string>();
  const out: DeskCatalogFulfilmentTask[] = [];
  for (const task of input) {
    const title = text(task.title);
    if (!title) throw new DeskCatalogRejectedError('fulfilmentTasks', 'Every fulfilment task needs a title');
    const id = task.id?.trim() || generateId('dtask');
    if (seen.has(id)) throw new DeskCatalogRejectedError('fulfilmentTasks', 'Fulfilment task ids must be unique');
    seen.add(id);
    const description = text(task.description) ?? undefined;
    const assigneeId = text(task.assigneeId);
    out.push({
      id,
      title,
      ...(description ? { description } : {}),
      assigneeId,
      dueInDays: task.dueInDays ?? null,
    });
  }
  return out;
}

function requiredName(value: string): string {
  const name = text(value);
  if (!name) throw new DeskCatalogRejectedError('name', 'A name is required');
  return name;
}

/** The free-text columns an input carries, trimmed; an empty text clears the column. */
function textColumns(input: DeskCatalogItemPatch): Partial<typeof items.$inferInsert> {
  const columns: Partial<typeof items.$inferInsert> = {};
  if (input.summary !== undefined) columns.summary = text(input.summary);
  if (input.description !== undefined) columns.description = text(input.description);
  if (input.category !== undefined) columns.category = text(input.category);
  if (input.icon !== undefined) columns.icon = text(input.icon);
  if (input.deliveryEstimate !== undefined) columns.deliveryEstimate = text(input.deliveryEstimate);
  return columns;
}

/** The team an item goes to, when it names one: it has to exist and be active. */
async function teamColumn(db: AnyDb, value: string | null): Promise<string | null> {
  const teamId = text(value);
  if (teamId) await assertTeam(db, teamId, 'departmentId');
  return teamId;
}

function knownPriority(priority: DeskPriority | null): DeskPriority | null {
  if (priority !== null && !PRIORITIES.includes(priority)) {
    throw new DeskCatalogRejectedError('priority', 'Unknown priority');
  }
  return priority;
}

/** The columns an input writes (only the keys it carries), validated. */
async function itemColumns(
  db: AnyDb,
  generateId: IdGenerator,
  input: DeskCatalogItemPatch,
): Promise<Partial<typeof items.$inferInsert>> {
  const columns: Partial<typeof items.$inferInsert> = {};
  if (input.name !== undefined) columns.name = requiredName(input.name);
  Object.assign(columns, textColumns(input));
  if (input.ticketTypeId !== undefined) {
    await assertTicketType(db, input.ticketTypeId);
    columns.ticketTypeId = input.ticketTypeId;
  }
  if (input.departmentId !== undefined) columns.departmentId = await teamColumn(db, input.departmentId);
  if (input.priority !== undefined) columns.priority = knownPriority(input.priority);
  if (input.approvalSteps !== undefined) columns.approvalSteps = await normalizeSteps(db, generateId, input.approvalSteps);
  if (input.fulfilmentTasks !== undefined) columns.fulfilmentTasks = normalizeTasks(generateId, input.fulfilmentTasks);
  if (input.audienceCompanyIds !== undefined) {
    columns.audienceCompanyIds = [...new Set(input.audienceCompanyIds.map((id) => id.trim()).filter(Boolean))];
  }
  if (input.isActive !== undefined) columns.isActive = input.isActive;
  if (input.sortOrder !== undefined) columns.sortOrder = input.sortOrder;
  return columns;
}

/** The catalogue in the settings' order: by sort order, then name. `activeOnly` leaves out switched-off items. */
export async function listDeskCatalogItems(db: AnyDb, opts: { activeOnly?: boolean } = {}): Promise<DeskCatalogItem[]> {
  return db
    .select()
    .from(items)
    .where(opts.activeOnly ? eq(items.isActive, true) : undefined)
    .orderBy(asc(items.sortOrder), asc(items.name), asc(items.id));
}

export async function getDeskCatalogItem(db: AnyDb, id: string): Promise<DeskCatalogItem | null> {
  const [row] = await db.select().from(items).where(eq(items.id, id)).limit(1);
  return row ?? null;
}

export async function createDeskCatalogItem(
  db: AnyDb,
  input: DeskCatalogItemInput & { generateId: IdGenerator; createdById?: string | null },
): Promise<DeskCatalogItem> {
  const { generateId, createdById, ...rest } = input;
  const columns = await itemColumns(db, generateId, rest);
  const now = new Date();
  const [created] = await db
    .insert(items)
    .values({
      ...columns,
      id: generateId('dcat'),
      createdAt: now,
      updatedAt: now,
      name: columns.name as string,
      ticketTypeId: columns.ticketTypeId as string,
      createdById: createdById ?? null,
    })
    .returning();
  if (!created) throw new Error('desk_catalog_items insert returned no row');
  return created;
}

/** Change an item; only the keys present change. Null when it doesn't exist. */
export async function updateDeskCatalogItem(
  db: AnyDb,
  id: string,
  patch: DeskCatalogItemPatch & { generateId: IdGenerator },
): Promise<DeskCatalogItem | null> {
  const { generateId, ...rest } = patch;
  const current = await getDeskCatalogItem(db, id);
  if (!current) return null;
  const columns = await itemColumns(db, generateId, rest);
  const [updated] = await db
    .update(items)
    .set({ ...columns, updatedAt: new Date() })
    .where(eq(items.id, id))
    .returning();
  return updated ?? null;
}

/**
 * Delete an item. Requests made from it keep their `catalog_item_id` and
 * their approval rows (they just no longer name the item). Null when it
 * doesn't exist.
 */
export async function deleteDeskCatalogItem(db: AnyDb, id: string): Promise<DeskCatalogItem | null> {
  const [deleted] = await db.delete(items).where(eq(items.id, id)).returning();
  return deleted ?? null;
}

/** The names of these catalogue items, by id (an item that is gone has no entry). */
export async function deskCatalogItemNames(db: AnyDb, ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();
  const rows = await db.select({ id: items.id, name: items.name }).from(items).where(inArray(items.id, wanted));
  return new Map(rows.map((row) => [row.id, row.name]));
}

// ============================================================================
// Reader view (help center)
// ============================================================================

function toPortalItem(item: DeskCatalogItem, form: DeskPortalRequestType): DeskPortalCatalogItem {
  return {
    id: item.id,
    name: item.name,
    summary: item.summary,
    description: item.description,
    category: item.category,
    icon: item.icon,
    deliveryEstimate: item.deliveryEstimate,
    needsApproval: item.approvalSteps.length > 0,
    form,
  };
}

/** Active items in the catalogue's reading order: category (none last), sort order, name. */
async function activeItemsInOrder(db: AnyDb): Promise<DeskCatalogItem[]> {
  return db
    .select()
    .from(items)
    .where(eq(items.isActive, true))
    .orderBy(sql`${items.category} asc nulls last`, asc(items.sortOrder), asc(items.name), asc(items.id));
}

/** Items the reader's CRM companies may see: no audience, or one of the reader's companies. */
function visibleTo(item: DeskCatalogItem, companyIds: string[]): boolean {
  const audience = item.audienceCompanyIds;
  return audience.length === 0 || audience.some((id) => companyIds.includes(id));
}

async function usableTypes(db: AnyDb, list: DeskCatalogItem[]): Promise<Map<string, HelpdeskTicketType>> {
  const ids = [...new Set(list.map((item) => item.ticketTypeId))];
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(ticketTypes).where(inArray(ticketTypes.id, ids));
  return new Map(rows.filter(isCustomerType).map((type) => [type.id, type]));
}

/** The catalogue as this reader sees it; an item whose ticket type can no longer be used is left out. */
export async function listDeskCatalogForPrincipal(db: AnyDb, principal: DeskPrincipal): Promise<DeskPortalCatalogItem[]> {
  const reader = await deskReaderOf(db, principal);
  const visible = (await activeItemsInOrder(db)).filter((item) => visibleTo(item, reader.companyIds));
  const types = await usableTypes(db, visible);
  return visible.flatMap((item) => {
    const type = types.get(item.ticketTypeId);
    return type ? [toPortalItem(item, toDeskPortalRequestType(type))] : [];
  });
}

/** One item, when it is active and this reader may see it. */
export async function getDeskCatalogItemForPrincipal(
  db: AnyDb,
  principal: DeskPrincipal,
  id: string,
): Promise<{ item: DeskCatalogItem; portal: DeskPortalCatalogItem } | null> {
  const item = await getDeskCatalogItem(db, id);
  if (!item?.isActive) return null;
  const reader = await deskReaderOf(db, principal);
  if (!visibleTo(item, reader.companyIds)) return null;
  const type = (await usableTypes(db, [item])).get(item.ticketTypeId);
  return type ? { item, portal: toPortalItem(item, toDeskPortalRequestType(type)) } : null;
}

// ============================================================================
// Starting a request
// ============================================================================

export interface StartDeskCatalogRequestInput {
  generateId: IdGenerator;
  conversationId: string;
  item: DeskCatalogItem;
  /** Who started it (the timeline event's author): the agent, or the visitor for a help-center request. */
  actorType: DeskAuthorType;
  actorId?: string | null;
}

export interface StartDeskCatalogRequestResult {
  conversation: DeskConversation;
  /** The timeline entries written, in order (empty without approval steps). */
  changes: DeskLinkChange[];
  /** The first step, now with its approver; null when the item needs no approval. */
  pendingApproval: DeskRequestApproval | null;
  /** The item needs no approval: create its tasks now. */
  fulfilmentDue: boolean;
}

/** Who a step asks, as a user id: its member, or the manager of its team (else the request's team). */
async function resolveApprover(
  db: AnyDb,
  step: DeskCatalogApprovalStep,
  conversation: DeskConversation,
): Promise<string | null> {
  if (step.approverType === 'member') {
    return step.approverId ? activeMemberUserId(db, step.approverId) : null;
  }
  const teamId = step.departmentId || conversation.departmentId;
  if (!teamId) return null;
  const [team] = await db
    .select({ managerId: departments.managerId })
    .from(departments)
    .where(and(eq(departments.id, teamId), isNull(departments.deletedAt)))
    .limit(1);
  return memberUserId(db, team?.managerId);
}

interface ApprovalEventInput {
  generateId: IdGenerator;
  conversationId: string;
  eventType: DeskEventType;
  authorType: DeskAuthorType;
  authorId?: string | null;
  approval: DeskRequestApproval;
  catalogItemName: string | null;
  extra?: Record<string, unknown>;
}

function approvalEvent(db: AnyDb, input: ApprovalEventInput): Promise<DeskLinkChange> {
  const { approval } = input;
  return appendDeskMessage(db, {
    generateId: input.generateId,
    conversationId: input.conversationId,
    kind: 'event',
    authorType: input.authorType,
    authorId: input.authorId ?? null,
    metadata: {
      eventType: input.eventType,
      stepIndex: approval.stepIndex,
      stepName: approval.stepName,
      approverId: approval.approverId,
      catalogItemId: approval.catalogItemId,
      catalogItemName: input.catalogItemName,
      ...input.extra,
    },
  });
}

async function loadConversation(db: AnyDb, id: string): Promise<DeskConversation> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  if (!row) throw new DeskConversationNotFoundError(id);
  return row;
}

/**
 * Refuse a conversation that can't become a service request (409 `reason`):
 * `merged`, `already_request`, `closed`. A caller that changes the
 * conversation first (the inbox sets the item's type and team) checks before.
 */
export function assertDeskRequestStartable(
  conversation: Pick<DeskConversation, 'mergedIntoId' | 'catalogItemId' | 'state'>,
): void {
  if (conversation.mergedIntoId) {
    throw new DeskCatalogRefusedError('merged', 'This ticket was merged into another one');
  }
  if (conversation.catalogItemId) {
    throw new DeskCatalogRefusedError('already_request', 'This ticket is already a service request');
  }
  if (conversation.state === 'closed') {
    throw new DeskCatalogRefusedError('closed', 'A closed ticket cannot become a service request');
  }
}

/**
 * Make an existing conversation a service request of `item` and start its
 * flow. Refused (409 `reason`): `already_request` (one item per conversation),
 * `merged`, `closed`.
 */
export async function startDeskCatalogRequest(
  db: AnyDb,
  input: StartDeskCatalogRequestInput,
): Promise<StartDeskCatalogRequestResult> {
  const conversation = await loadConversation(db, input.conversationId);
  assertDeskRequestStartable(conversation);

  const steps = input.item.approvalSteps;
  // Claim the conversation first: a second start at the same moment finds it taken.
  const [claimed] = await db
    .update(conversations)
    .set({
      catalogItemId: input.item.id,
      approvalStatus: steps.length > 0 ? 'pending' : null,
      updatedAt: new Date(),
    })
    .where(and(eq(conversations.id, conversation.id), isNull(conversations.catalogItemId)))
    .returning();
  if (!claimed) throw new DeskCatalogRefusedError('already_request', 'This ticket is already a service request');

  if (steps.length === 0) {
    return { conversation: claimed, changes: [], pendingApproval: null, fulfilmentDue: true };
  }

  const rows: DeskRequestApproval[] = [];
  const now = new Date();
  for (const [index, step] of steps.entries()) {
    const [row] = await db
      .insert(approvals)
      .values({
        id: input.generateId('dappr'),
        createdAt: now,
        updatedAt: now,
        conversationId: conversation.id,
        catalogItemId: input.item.id,
        stepIndex: index,
        stepName: step.name ?? null,
        approverId: await resolveApprover(db, step, claimed),
        status: index === 0 ? 'pending' : 'waiting',
      })
      .returning();
    if (!row) throw new Error('desk_request_approvals insert returned no row');
    rows.push(row);
  }
  const first = rows[0] as DeskRequestApproval;
  const change = await approvalEvent(db, {
    generateId: input.generateId,
    conversationId: conversation.id,
    eventType: 'approval_requested',
    authorType: input.actorType,
    authorId: input.actorId,
    approval: first,
    catalogItemName: input.item.name,
  });
  return { conversation: change.conversation, changes: [change], pendingApproval: first, fulfilmentDue: false };
}

// ============================================================================
// Deciding
// ============================================================================

export interface DecideDeskRequestApprovalInput {
  generateId: IdGenerator;
  conversationId: string;
  /** The member deciding (a user id). */
  userId: string;
  /** May decide any step: holds the catalogue's manage permission. */
  canManage: boolean;
  decision: 'approved' | 'rejected';
  comment?: string | null;
}

export interface DecideDeskRequestApprovalResult {
  conversation: DeskConversation;
  changes: DeskLinkChange[];
  /** The step that went to its approver next (approve only); null when none did. */
  nextApproval: DeskRequestApproval | null;
  /** The last step was approved: create the item's tasks. */
  fulfilmentDue: boolean;
  /** The step that was decided. */
  decided: DeskRequestApproval;
}

/**
 * Decide the pending step of a request. Only its approver may, or anyone who
 * manages the catalogue (the only way to decide a step without an approver).
 * Refused (409 `reason`): `not_pending` (nothing waits for a decision, or it
 * was decided a moment ago), `not_approver`.
 */
export async function decideDeskRequestApproval(
  db: AnyDb,
  input: DecideDeskRequestApprovalInput,
): Promise<DecideDeskRequestApprovalResult> {
  await loadConversation(db, input.conversationId);
  const [pending] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.conversationId, input.conversationId), eq(approvals.status, 'pending')))
    .orderBy(asc(approvals.stepIndex))
    .limit(1);
  if (!pending) throw new DeskCatalogRefusedError('not_pending', 'No approval is waiting for a decision');
  if (pending.approverId !== input.userId && !input.canManage) {
    throw new DeskCatalogRefusedError('not_approver', 'Only the approver of this step can decide it');
  }

  const comment = text(input.comment);
  const now = new Date();
  const [decided] = await db
    .update(approvals)
    .set({ status: input.decision, decidedAt: now, decidedById: input.userId, comment, updatedAt: now })
    .where(and(eq(approvals.id, pending.id), eq(approvals.status, 'pending')))
    .returning();
  if (!decided) throw new DeskCatalogRefusedError('not_pending', 'This approval was already decided');

  const [item] = await db.select({ name: items.name }).from(items).where(eq(items.id, decided.catalogItemId)).limit(1);
  const catalogItemName = item?.name ?? null;
  const base = { generateId: input.generateId, conversationId: input.conversationId, catalogItemName };
  const decidedExtra = { decidedById: input.userId, comment };
  const changes: DeskLinkChange[] = [];

  if (input.decision === 'rejected') {
    await db
      .update(approvals)
      .set({ status: 'skipped', updatedAt: now })
      .where(and(eq(approvals.conversationId, input.conversationId), eq(approvals.status, 'waiting')));
    await setApprovalStatus(db, input.conversationId, 'rejected');
    changes.push(
      await approvalEvent(db, {
        ...base,
        eventType: 'approval_rejected',
        authorType: 'agent',
        authorId: input.userId,
        approval: decided,
        extra: decidedExtra,
      }),
    );
    return { conversation: lastConversation(changes), changes, nextApproval: null, fulfilmentDue: false, decided };
  }

  const [waiting] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.conversationId, input.conversationId), eq(approvals.status, 'waiting')))
    .orderBy(asc(approvals.stepIndex))
    .limit(1);
  const [next] = waiting
    ? await db
        .update(approvals)
        .set({ status: 'pending', updatedAt: now })
        .where(and(eq(approvals.id, waiting.id), eq(approvals.status, 'waiting')))
        .returning()
    : [];
  if (!next) await setApprovalStatus(db, input.conversationId, 'approved');
  changes.push(
    await approvalEvent(db, {
      ...base,
      eventType: 'approval_approved',
      authorType: 'agent',
      authorId: input.userId,
      approval: decided,
      extra: decidedExtra,
    }),
  );
  if (next) {
    changes.push(
      await approvalEvent(db, {
        ...base,
        eventType: 'approval_requested',
        authorType: 'agent',
        authorId: input.userId,
        approval: next,
      }),
    );
  }
  return {
    conversation: lastConversation(changes),
    changes,
    nextApproval: next ?? null,
    fulfilmentDue: !next,
    decided,
  };
}

async function setApprovalStatus(db: AnyDb, conversationId: string, status: DeskRequestApprovalStatus): Promise<void> {
  await db
    .update(conversations)
    .set({ approvalStatus: status, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

function lastConversation(changes: DeskLinkChange[]): DeskConversation {
  const last = changes.at(-1);
  if (!last) throw new Error('an approval decision always writes a timeline entry');
  return last.conversation;
}

// ============================================================================
// Reading a request
// ============================================================================

/** A step as the request view lists it: the row without the request's own ids and its row timestamps. */
export type DeskRequestApprovalView = Pick<
  DeskRequestApproval,
  'id' | 'stepIndex' | 'stepName' | 'approverId' | 'status' | 'decidedAt' | 'decidedById' | 'comment'
>;

export interface DeskConversationRequest {
  /** The item the request was made from; null when it was deleted since. */
  item: { id: string; name: string; category: string | null; icon: string | null; deliveryEstimate: string | null } | null;
  approvalStatus: DeskRequestApprovalStatus | null;
  /** The request's steps, in order. */
  approvals: DeskRequestApprovalView[];
}

/** The service request a conversation is; null when it isn't one (or doesn't exist). */
export async function getDeskConversationRequest(db: AnyDb, conversationId: string): Promise<DeskConversationRequest | null> {
  const [conversation] = await db
    .select({ catalogItemId: conversations.catalogItemId, approvalStatus: conversations.approvalStatus })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conversation?.catalogItemId) return null;
  const [item] = await db
    .select({
      id: items.id,
      name: items.name,
      category: items.category,
      icon: items.icon,
      deliveryEstimate: items.deliveryEstimate,
    })
    .from(items)
    .where(eq(items.id, conversation.catalogItemId))
    .limit(1);
  const rows = await db
    .select({
      id: approvals.id,
      stepIndex: approvals.stepIndex,
      stepName: approvals.stepName,
      approverId: approvals.approverId,
      status: approvals.status,
      decidedAt: approvals.decidedAt,
      decidedById: approvals.decidedById,
      comment: approvals.comment,
    })
    .from(approvals)
    .where(eq(approvals.conversationId, conversationId))
    .orderBy(asc(approvals.stepIndex), asc(approvals.id));
  return { item: item ?? null, approvalStatus: conversation.approvalStatus, approvals: rows };
}

export interface DeskPendingApproval {
  approvalId: string;
  conversationId: string;
  conversationNumber: number;
  title: string | null;
  requesterName: string | null;
  conversationCreatedAt: Date;
  catalogItemId: string;
  catalogItemName: string | null;
  stepIndex: number;
  stepName: string | null;
  approverId: string | null;
  /** When the step went to its approver. */
  requestedAt: Date;
}

/**
 * Steps waiting for a decision, oldest first. `approverId` limits them to
 * one member's; absent lists everyone's, steps without an approver included.
 */
export async function listDeskPendingApprovals(
  db: AnyDb,
  opts: { approverId?: string; limit: number },
): Promise<DeskPendingApproval[]> {
  const filters = [eq(approvals.status, 'pending')];
  if (opts.approverId) filters.push(eq(approvals.approverId, opts.approverId));
  const rows = await db
    .select({
      approvalId: approvals.id,
      conversationId: conversations.id,
      conversationNumber: conversations.conversationNumber,
      title: conversations.title,
      name: conversations.name,
      email: conversations.email,
      conversationCreatedAt: conversations.createdAt,
      catalogItemId: approvals.catalogItemId,
      catalogItemName: items.name,
      stepIndex: approvals.stepIndex,
      stepName: approvals.stepName,
      approverId: approvals.approverId,
      requestedAt: approvals.updatedAt,
    })
    .from(approvals)
    .innerJoin(conversations, eq(conversations.id, approvals.conversationId))
    .leftJoin(items, eq(items.id, approvals.catalogItemId))
    .where(and(...filters))
    .orderBy(asc(approvals.updatedAt), asc(approvals.id))
    .limit(opts.limit);
  return rows.map(({ name, email, ...row }) => ({ ...row, requesterName: name ?? email ?? null }));
}

// ============================================================================
// Fulfilment
// ============================================================================

/** Whether the request's tasks were created already (a `fulfilment_started` event exists). */
export async function hasDeskFulfilmentStarted(db: AnyDb, conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.deskMessages.id })
    .from(schema.deskMessages)
    .where(
      and(
        eq(schema.deskMessages.conversationId, conversationId),
        eq(schema.deskMessages.kind, 'event'),
        sql`${schema.deskMessages.metadata}->>'eventType' = 'fulfilment_started'`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

export interface RecordDeskRequestFulfilmentInput {
  generateId: IdGenerator;
  conversationId: string;
  /** The member whose action started it; absent for the system. */
  authorId?: string | null;
  taskIds: string[];
}

/** The internal `fulfilment_started` event, naming the tasks that were created. */
export function recordDeskRequestFulfilment(db: AnyDb, input: RecordDeskRequestFulfilmentInput): Promise<DeskLinkChange> {
  return appendDeskMessage(db, {
    generateId: input.generateId,
    conversationId: input.conversationId,
    kind: 'event',
    authorType: input.authorId ? 'agent' : 'system',
    authorId: input.authorId ?? null,
    metadata: { eventType: 'fulfilment_started', taskIds: input.taskIds },
  });
}

// ============================================================================
// Help center
// ============================================================================

export interface CreateDeskCatalogPortalRequestInput {
  generateId: IdGenerator;
  visitor: Pick<DeskVisitor, 'id' | 'name' | 'email' | 'verifiedEmail'>;
  item: DeskCatalogItem;
  title?: string;
  description?: string;
  fields?: Record<string, unknown>;
}

export interface CreateDeskCatalogPortalRequestResult extends StartDeskCatalogRequestResult {
  /** The requester's first message. */
  message: DeskMessage;
  type: HelpdeskTicketType;
  /** See AppendDeskMessageResult.slaCheckAt (of the first message). */
  slaCheckAt: Date | null;
}

/**
 * Submit a catalogue item from the help center: a portal request of the
 * item's ticket type (its team and priority overridden by the item's when
 * set; the title defaults to the item's name), started as a service request.
 */
export async function createDeskCatalogPortalRequest(
  db: AnyDb,
  input: CreateDeskCatalogPortalRequestInput,
): Promise<CreateDeskCatalogPortalRequestResult> {
  const created = await createDeskPortalRequest(db, {
    generateId: input.generateId,
    visitor: input.visitor,
    ticketTypeId: input.item.ticketTypeId,
    title: input.title?.trim() || input.item.name,
    description: input.description,
    fields: input.fields,
    departmentId: input.item.departmentId,
    priority: input.item.priority,
  });
  const started = await startDeskCatalogRequest(db, {
    generateId: input.generateId,
    conversationId: created.conversation.id,
    item: input.item,
    actorType: 'visitor',
    actorId: input.visitor.id,
  });
  return { ...started, message: created.message, type: created.type, slaCheckAt: created.slaCheckAt };
}
