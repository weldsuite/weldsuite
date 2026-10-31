/**
 * The live inbox for writers outside it: external-api and the MCP server
 * (`/v1/conversations`, `POST /v1/tickets`), WeldAgent's ticket tools and
 * WeldConnect workflows. Before this they wrote `helpdesk_tickets` /
 * `helpdesk_conversations`, which no screen shows, so an alert or a ticket the
 * AI opened reached nobody.
 *
 * The rows are written by `@weldsuite/db/lib/desk` (the single writer, ADR
 * DESK-001). This adds what the widget and email paths do after a customer
 * message lands: auto-assignment, a notification for the assignee or else the
 * team, and the `desk_conversation` / `desk_message` entity events that update
 * every agent's inbox (through the entity-realtime queue) and start workflows.
 * Pure functions; each worker brings its db, bindings and event publisher.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  createAndDeliverNotification,
  helpdeskPreview,
  sendTicketAssignedNotification,
  type NotificationEnv,
} from '@weldsuite/notifications';
import {
  appendDeskMessage,
  ingestDeskApi,
  updateDeskConversationAttributes,
  DeskAttributeRejectedError,
  DeskConversationNotFoundError,
  type DeskConversation,
  type DeskMessage,
  type IngestDeskApiInput,
  type IngestDeskApiResult,
} from '@weldsuite/db/lib/desk';
import {
  autoAssignDeskConversation,
  deskAssignmentRouterPicker,
  type FetcherLike,
} from '@weldsuite/db/lib/desk-assignment';
import type { DeskPriority } from '@weldsuite/db/schema/desk-conversations';
import type { DeskAuthorType, DeskEventType } from '@weldsuite/db/schema/desk-messages';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export { DeskAttributeRejectedError, DeskConversationNotFoundError };

/**
 * The ticket fields of a conversation (ADR DESK-007) a writer outside the
 * inbox may set. Written by `updateDeskConversationAttributes`, so every
 * change is an internal `attributes_changed` event on the timeline.
 */
export interface DeskTicketFields {
  ticketTypeId?: string | null;
  priority?: DeskPriority | null;
  tags?: string[];
  departmentId?: string | null;
  /** By slug, against the conversation's type. Only on update, where a refusal writes nothing. */
  customFields?: Record<string, unknown>;
}

function hasTicketFields(fields: DeskTicketFields | undefined): fields is DeskTicketFields {
  return fields !== undefined && Object.values(fields).some((value) => value !== undefined);
}

/**
 * Refuse a ticket type or team that doesn't exist or is inactive before a
 * conversation is opened, so a bad id never leaves one behind without its
 * fields. The same rule `updateDeskConversationAttributes` applies.
 */
async function assertUsableReferences(db: Database, fields: DeskTicketFields): Promise<void> {
  const refs = [
    { table: schema.helpdeskTicketTypes, id: fields.ticketTypeId, input: 'ticketTypeId', noun: 'Ticket type' },
    { table: schema.helpdeskDepartments, id: fields.departmentId, input: 'departmentId', noun: 'Team' },
  ] as const;
  for (const ref of refs) {
    if (!ref.id) continue;
    const [row] = await db
      .select({ isActive: ref.table.isActive, deletedAt: ref.table.deletedAt })
      .from(ref.table)
      .where(eq(ref.table.id, ref.id))
      .limit(1);
    if (!row || row.isActive === false || row.deletedAt) {
      throw new DeskAttributeRejectedError(ref.input, `${ref.noun} '${ref.id}' does not exist or is inactive`);
    }
  }
}

export type DeskInboxEvent =
  | {
      entityType: 'desk_conversation';
      action: 'created' | 'updated' | 'state_changed' | 'assigned';
      entityId: string;
      data: Record<string, unknown>;
    }
  | { entityType: 'desk_message'; action: 'created'; entityId: string; data: Record<string, unknown> };

/** Bindings the follow-ups use when the worker has them; any may be missing. */
export interface DeskInboxEnv extends NotificationEnv {
  /** helpdesk-workflow-worker: the per-workspace AssignmentRouter. Without it the pick runs locally. */
  HELPDESK_WORKFLOW?: FetcherLike;
}

export interface DeskInboxDeps {
  db: Database;
  env: DeskInboxEnv;
  /** Clerk org id: what notifications, realtime topics and the assignment router key on. */
  clerkOrgId: string;
  generateId: (prefix: string) => string;
  /** Publish one entity event with the worker's own publisher. */
  emit: (event: DeskInboxEvent) => void | Promise<void>;
  /** Run notifications in the background; they are awaited when absent. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** Who acts on a conversation from outside the inbox. */
export interface DeskInboxActor {
  /** `agent` for a person (personal API key, MCP), `bot` for an integration, the AI or a workflow. */
  authorType: Extract<DeskAuthorType, 'agent' | 'bot' | 'system'>;
  /** The member's user id for `agent`; the key, agent or workflow id otherwise. */
  authorId: string | null;
}

const NOTIFY_BATCH = 10;
const MAX_RECIPIENTS = 200;

function asRecord(row: DeskConversation | DeskMessage): Record<string, unknown> {
  return row as unknown as Record<string, unknown>;
}

function conversationEvent(
  action: Extract<DeskInboxEvent, { entityType: 'desk_conversation' }>['action'],
  conversation: DeskConversation,
  extra?: Record<string, unknown>,
): DeskInboxEvent {
  return { entityType: 'desk_conversation', action, entityId: conversation.id, data: { ...asRecord(conversation), ...extra } };
}

function messageEvent(message: DeskMessage): DeskInboxEvent {
  return { entityType: 'desk_message', action: 'created', entityId: message.id, data: asRecord(message) };
}

/** Set ticket fields as `actor` (the system when absent): one `attributes_changed` event when anything changed. */
function setTicketFields(
  deps: DeskInboxDeps,
  conversationId: string,
  fields: DeskTicketFields,
  actor: DeskInboxActor | undefined,
) {
  return updateDeskConversationAttributes(deps.db, {
    generateId: deps.generateId,
    conversationId,
    authorType: actor?.authorType ?? 'system',
    authorId: actor?.authorId ?? null,
    ...fields,
  });
}

async function emitAll(deps: DeskInboxDeps, events: DeskInboxEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await deps.emit(event);
    } catch (err) {
      console.error(`[desk-inbox] ${event.entityType}.${event.action} event failed:`, err);
    }
  }
}

function inBackground(deps: DeskInboxDeps, work: Promise<unknown>): Promise<void> {
  const guarded = work.then(
    () => undefined,
    (err: unknown) => console.error('[desk-inbox] notification failed:', err),
  );
  if (deps.waitUntil) {
    deps.waitUntil(guarded);
    return Promise.resolve();
  }
  return guarded;
}

/** Active internal teammates who can work the inbox (viewers cannot). */
async function teamRecipients(db: Database): Promise<string[]> {
  const m = schema.workspaceMembers;
  const rows = await db
    .select({ userId: m.userId })
    .from(m)
    .where(
      and(
        isNull(m.deletedAt),
        sql`upper(${m.status}) = 'ACTIVE'`,
        sql`upper(${m.memberType}) = 'INTERNAL'`,
        sql`upper(coalesce(${m.role}, '')) <> 'VIEWER'`,
      ),
    )
    .limit(MAX_RECIPIENTS);
  return Array.from(new Set(rows.map((r) => r.userId)));
}

async function notifyTeam(
  deps: DeskInboxDeps,
  conversation: DeskConversation,
  content: { title: string; body: string },
): Promise<void> {
  const recipients = conversation.assigneeId ? [conversation.assigneeId] : await teamRecipients(deps.db);
  for (let i = 0; i < recipients.length; i += NOTIFY_BATCH) {
    await Promise.allSettled(
      recipients.slice(i, i + NOTIFY_BATCH).map((userId) =>
        createAndDeliverNotification({
          db: deps.db,
          env: deps.env,
          workspaceId: deps.clerkOrgId,
          userId,
          title: content.title,
          body: content.body,
          category: 'helpdesk',
          notificationType: 'message_received',
          entityType: 'desk_conversation',
          entityId: conversation.id,
          actionUrl: `/welddesk/inbox/${conversation.id}`,
          severity: 'info',
          actorType: 'system',
          actorId: null,
          data: { conversationId: conversation.id },
        }),
      ),
    );
  }
}

/**
 * Whether the team hears about this message. Same rule as the widget and
 * email: a new conversation, or one where the ball moves back to the team. A
 * flapping alert that repeats while the conversation already waits on the team
 * is one notification, not one per repeat.
 */
export function shouldNotifyDeskTeam(result: Pick<IngestDeskApiResult, 'created' | 'prior'>): boolean {
  if (result.created || !result.prior) return true;
  return !(result.prior.state === 'open' && result.prior.waitingSince !== null);
}

export interface OpenDeskApiConversationInput extends Omit<IngestDeskApiInput, 'generateId'> {
  /** Type, team, priority and tags; applied on a repeat too, so an alert can escalate. */
  fields?: Omit<DeskTicketFields, 'customFields'>;
  /** A member to hand it to instead of auto-assignment (on a repeat too). */
  assigneeId?: string | null;
  /** Who set the fields and the assignee; defaults to the system. */
  actor?: DeskInboxActor;
}

/** A new conversation is `created`; a closed one the message reopened changed state; any other was `updated`. */
function openedAction(result: IngestDeskApiResult, conversation: DeskConversation): 'created' | 'updated' | 'state_changed' {
  if (result.created) return 'created';
  return result.prior?.state === 'closed' && conversation.state === 'open' ? 'state_changed' : 'updated';
}

/**
 * Hand an open, unowned conversation out by the workspace's assignment rules,
 * through the AssignmentRouter when the worker has it (ADR DESK-005). A failed
 * pick leaves it unassigned for the team.
 */
async function autoAssignOpened(
  deps: DeskInboxDeps,
  conversation: DeskConversation,
): Promise<{ conversation: DeskConversation; events: DeskInboxEvent[] }> {
  if (conversation.assigneeId || conversation.state !== 'open') return { conversation, events: [] };
  try {
    const assigned = await autoAssignDeskConversation(deps.db, {
      generateId: deps.generateId,
      conversationId: conversation.id,
      pick: deskAssignmentRouterPicker(deps.env.HELPDESK_WORKFLOW, deps.clerkOrgId),
    });
    if (!assigned) return { conversation, events: [] };
    return {
      conversation: assigned.conversation,
      events: [conversationEvent('assigned', assigned.conversation), messageEvent(assigned.message)],
    };
  } catch (err) {
    console.error(`[desk-inbox] auto-assignment failed for ${conversation.id}:`, err);
    return { conversation, events: [] };
  }
}

/** The member the caller named, or else the workspace's assignment rules. */
async function assignOpened(
  deps: DeskInboxDeps,
  conversation: DeskConversation,
  assigneeId: string | null | undefined,
  actor: DeskInboxActor | undefined,
): Promise<{ conversation: DeskConversation; events: DeskInboxEvent[] }> {
  if (!assigneeId) return autoAssignOpened(deps, conversation);
  if (conversation.assigneeId === assigneeId) return { conversation, events: [] };
  const result = await appendDeskMessage(deps.db, {
    generateId: deps.generateId,
    conversationId: conversation.id,
    kind: 'event',
    authorType: actor?.authorType ?? 'system',
    authorId: actor?.authorId ?? null,
    metadata: { eventType: 'assigned', assigneeId },
    assigneeId,
  });
  return {
    conversation: result.conversation,
    events: [conversationEvent('assigned', result.conversation), messageEvent(result.message)],
  };
}

function openedNotice(created: boolean, conversation: DeskConversation, body: string): { title: string; body: string } {
  const who = conversation.name?.trim() || conversation.email?.trim() || 'An integration';
  return {
    title: created ? `New conversation from ${who}` : `${who} replied`,
    body: helpdeskPreview(body) || helpdeskPreview(conversation.title) || `#${conversation.conversationNumber}`,
  };
}

/**
 * Open a conversation in the live inbox, or add to the one that already
 * carries `externalId` (reopening it when closed), and set its ticket fields.
 * Then assign it to `assigneeId`, or auto-assign it when the workspace has
 * that on, notify, and emit the entity events. A bad ticket type or team is refused before anything is
 * written (DeskAttributeRejectedError).
 */
export async function openDeskApiConversation(
  deps: DeskInboxDeps,
  input: OpenDeskApiConversationInput,
): Promise<IngestDeskApiResult> {
  const { fields, assigneeId, actor, ...ingest } = input;
  const withFields = hasTicketFields(fields);
  if (withFields) await assertUsableReferences(deps.db, fields);

  const result = await ingestDeskApi(deps.db, { ...ingest, generateId: deps.generateId });
  const set = withFields ? await setTicketFields(deps, result.conversation.id, fields, actor) : null;
  const opened = set?.conversation ?? result.conversation;
  const messages = set?.message ? [result.message, set.message] : [result.message];

  const { conversation, events: assignEvents } = await assignOpened(deps, opened, assigneeId, actor);
  await emitAll(deps, [
    conversationEvent(openedAction(result, opened), opened),
    ...messages.map(messageEvent),
    ...assignEvents,
  ]);

  // A repeat that hands the conversation to someone new tells them, even when
  // the team already had it.
  if (shouldNotifyDeskTeam(result) || conversation.assigneeId !== opened.assigneeId) {
    await inBackground(deps, notifyTeam(deps, conversation, openedNotice(result.created, conversation, input.body)));
  }

  return { ...result, conversation };
}

/** Replies only reach customers on these channels from outside the inbox; email and phone go out from it. */
const REPLYABLE_CHANNELS = new Set<DeskConversation['channel']>(['api', 'messenger']);

/** A reply was refused because it could not reach the customer on this channel. */
export class DeskReplyChannelError extends Error {
  constructor(readonly channel: DeskConversation['channel']) {
    super(`Replies to ${channel} conversations are sent from the WeldDesk inbox; add a note instead`);
    this.name = 'DeskReplyChannelError';
  }
}

/** Nothing to change: no state, assignee or ticket field was given. */
export class DeskEmptyUpdateError extends Error {
  constructor() {
    super('Give a state, an assigneeId or a ticket field to change');
    this.name = 'DeskEmptyUpdateError';
  }
}

export interface UpdateDeskConversationInput {
  conversationId: string;
  state?: 'open' | 'closed';
  /** A member's user id, or null to unassign. */
  assigneeId?: string | null;
  fields?: DeskTicketFields;
  actor: DeskInboxActor;
}

async function loadConversation(db: Database, id: string): Promise<DeskConversation> {
  const [row] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, id)).limit(1);
  if (!row) throw new DeskConversationNotFoundError(id);
  return row;
}

interface Applied {
  conversation: DeskConversation;
  messages: DeskMessage[];
  events: DeskInboxEvent[];
}

/** Ticket fields first, so a refused one (DeskAttributeRejectedError) writes nothing at all. */
async function applyTicketFields(
  deps: DeskInboxDeps,
  conversation: DeskConversation,
  input: UpdateDeskConversationInput,
): Promise<Applied & { customFields?: Record<string, unknown> }> {
  if (!hasTicketFields(input.fields)) return { conversation, messages: [], events: [] };
  const set = await setTicketFields(deps, conversation.id, input.fields, input.actor);
  if (!set.message) return { conversation: set.conversation, customFields: set.customFields, messages: [], events: [] };
  return {
    conversation: set.conversation,
    customFields: set.customFields,
    messages: [set.message],
    events: [
      conversationEvent('updated', set.conversation, { customFields: set.customFields }),
      messageEvent(set.message),
    ],
  };
}

/** Assign or unassign, then close or reopen, each as the timeline event the inbox itself writes. */
async function applyTransitions(
  deps: DeskInboxDeps,
  start: DeskConversation,
  input: UpdateDeskConversationInput,
): Promise<Applied> {
  const applied: Applied = { conversation: start, messages: [], events: [] };
  const append = async (eventType: DeskEventType, assigneeId?: string | null) => {
    const result = await appendDeskMessage(deps.db, {
      generateId: deps.generateId,
      conversationId: applied.conversation.id,
      kind: 'event',
      authorType: input.actor.authorType,
      authorId: input.actor.authorId,
      metadata: { eventType, assigneeId: assigneeId ?? null },
      assigneeId,
    });
    applied.conversation = result.conversation;
    applied.messages.push(result.message);
    const action = eventType === 'assigned' || eventType === 'unassigned' ? 'assigned' : 'state_changed';
    applied.events.push(conversationEvent(action, result.conversation), messageEvent(result.message));
  };

  if (input.assigneeId !== undefined && input.assigneeId !== applied.conversation.assigneeId) {
    await (input.assigneeId ? append('assigned', input.assigneeId) : append('unassigned', null));
  }
  if (input.state === 'closed' && applied.conversation.state !== 'closed') await append('closed');
  if (input.state === 'open' && applied.conversation.state !== 'open') await append('reopened');
  return applied;
}

/**
 * Set ticket fields, then close, reopen, assign or unassign, each as the
 * timeline event the inbox itself writes. A change to what already holds
 * writes nothing; a refused field (DeskAttributeRejectedError) writes nothing
 * at all, since the fields go first.
 */
export async function updateDeskConversationFromApi(
  deps: DeskInboxDeps,
  input: UpdateDeskConversationInput,
): Promise<{ conversation: DeskConversation; messages: DeskMessage[]; customFields?: Record<string, unknown> }> {
  if (input.state === undefined && input.assigneeId === undefined && !hasTicketFields(input.fields)) {
    throw new DeskEmptyUpdateError();
  }
  const fields = await applyTicketFields(deps, await loadConversation(deps.db, input.conversationId), input);
  const previousAssigneeId = fields.conversation.assigneeId;
  const moves = await applyTransitions(deps, fields.conversation, input);
  const { conversation } = moves;
  const messages = [...fields.messages, ...moves.messages];
  const { customFields } = fields;

  await emitAll(deps, [...fields.events, ...moves.events]);

  if (conversation.assigneeId && conversation.assigneeId !== previousAssigneeId) {
    await inBackground(
      deps,
      sendTicketAssignedNotification({
        db: deps.db,
        env: deps.env,
        workspaceId: deps.clerkOrgId,
        assigneeId: conversation.assigneeId,
        assignedByUserId: input.actor.authorType === 'agent' ? input.actor.authorId : null,
        kind: 'conversation',
        entityId: conversation.id,
        subject: conversation.title || conversation.name || conversation.email,
        reference: `#${conversation.conversationNumber}`,
      }),
    );
  }

  return { conversation, messages, customFields };
}

export interface AddDeskConversationMessageInput {
  conversationId: string;
  /** `message` reaches the customer; `note` stays inside the team. */
  kind: 'message' | 'note';
  body: string;
  actor: DeskInboxActor;
}

/**
 * Reply to the customer or leave an internal note. Replies are refused on
 * email and phone conversations: from here they would land on the timeline
 * without the email or call ever reaching the customer.
 */
export async function addDeskConversationMessageFromApi(
  deps: DeskInboxDeps,
  input: AddDeskConversationMessageInput,
): Promise<{ conversation: DeskConversation; message: DeskMessage }> {
  const current = await loadConversation(deps.db, input.conversationId);
  if (input.kind === 'message' && !REPLYABLE_CHANNELS.has(current.channel)) {
    throw new DeskReplyChannelError(current.channel);
  }
  const result = await appendDeskMessage(deps.db, {
    generateId: deps.generateId,
    conversationId: current.id,
    kind: input.kind,
    authorType: input.actor.authorType,
    authorId: input.actor.authorId,
    body: input.body,
  });
  await emitAll(deps, [conversationEvent('updated', result.conversation), messageEvent(result.message)]);
  return result;
}
