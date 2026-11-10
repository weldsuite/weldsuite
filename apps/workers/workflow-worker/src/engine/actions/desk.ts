/**
 * The WeldDesk inbox (`desk_conversations`) for workflows: open a
 * conversation (`create_conversation`, and `create_record` for a ticket),
 * and the conversation actions in helpdesk.ts when the conversation is an
 * inbox one. Writes go through `@weldsuite/desk-domain/inbox`, the same path
 * the public API and WeldAgent take, so the team is notified and the
 * conversation is auto-assigned like any other.
 *
 * This worker has no entity-event queue, so workflow writes never start
 * workflows again; the inbox still moves live through WorkspaceHub, and the
 * visitor's widget through the conversation's room.
 */

import { eq } from 'drizzle-orm';
import { findDeskConversationByExternalId } from '@weldsuite/db/lib/desk';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import {
  addDeskConversationMessageFromApi,
  autoAssignDeskConversationFromApi,
  openDeskApiConversation,
  updateDeskConversationFromApi,
  DeskReplyChannelError,
  type DeskInboxActor,
  type DeskInboxDeps,
  type DeskInboxEnv,
  type OpenDeskApiConversationInput,
} from '@weldsuite/desk-domain/inbox';
import { asText } from '@weldsuite/text';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import { NonRetryableStepError } from '../errors';
import type { ActionContext, ActionHandler } from '../types';

function inboxDeps(ctx: ActionContext): DeskInboxDeps {
  const realtime = ctx.env.REALTIME
    ? new RealtimePublisher(ctx.env.REALTIME, { internalSecret: ctx.env.REALTIME_INTERNAL_SECRET })
    : null;
  return {
    db: ctx.db,
    env: ctx.env satisfies DeskInboxEnv,
    clerkOrgId: ctx.tenant.workspaceId,
    generateId,
    emit: async (event) => {
      await realtime?.publish(ctx.tenant.workspaceId, event.entityType, event.action, event.data, 'system');
    },
    // The widget listens on the conversation's room, not the WorkspaceHub.
    publishRoom: realtime ? (conversationId, payload) => realtime.conversationPublish(conversationId, payload) : undefined,
  };
}

/** Workflow writes show on the timeline as a bot, traceable to the run. */
function workflowActor(ctx: ActionContext): DeskInboxActor {
  return { authorType: 'bot', authorId: ctx.executionId };
}

function text(value: unknown): string | undefined {
  const s = value === undefined || value === null ? '' : asText(value).trim();
  return s || undefined;
}

function rawTags(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? value.split(',') : [];
}

/** Tags as a list: an array, or a comma-separated string. Blanks and repeats drop out. */
function tagList(value: unknown): string[] {
  return [...new Set(rawTags(value).map((tag) => text(tag)).filter((tag): tag is string => tag !== undefined))];
}

/** The ticket fields the step sets; an unknown priority is ignored rather than failing the step. */
function ticketFields(inputs: Record<string, unknown>): NonNullable<OpenDeskApiConversationInput['fields']> {
  const priority = text(inputs.priority)?.toLowerCase();
  const tags = tagList(inputs.tags);
  return {
    priority: priority && PRIORITIES.has(priority) ? (priority as 'low' | 'medium' | 'high' | 'urgent') : undefined,
    tags: tags.length > 0 ? tags : undefined,
    departmentId: text(inputs.teamId),
    ticketTypeId: text(inputs.ticketTypeId),
  };
}

const PRIORITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, urgent: 4 };

/**
 * Whether the step's priority may be written onto the conversation that
 * already carries its external id. A repeat only ever raises the priority (a
 * warning after a critical, or a recovery, leaves it), except that a reopened
 * ticket is a new episode and takes the priority as given, and the run that
 * closes a ticket never changes it.
 */
function priorityApplies(existing: { state: string; priority: string | null }, incoming: string, closing: boolean): boolean {
  if (closing) return false;
  if (existing.state === 'closed') return true;
  return (PRIORITY_RANK[incoming] ?? 0) > (PRIORITY_RANK[existing.priority ?? ''] ?? 0);
}

/** Is this an inbox conversation (rather than a legacy helpdesk one)? */
export async function isDeskConversation(ctx: ActionContext, conversationId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: schema.deskConversations.id })
    .from(schema.deskConversations)
    .where(eq(schema.deskConversations.id, conversationId))
    .limit(1);
  return Boolean(row);
}

/**
 * Open a conversation in the inbox, or add to the one that carries
 * `externalId` (reopening it). Inputs: title, message (or body), name, email,
 * contactId, externalId, and the ticket fields priority, tags (a list or a
 * comma-separated string), teamId and ticketTypeId (applied on a repeat too,
 * so an alert can escalate, never drop: see priorityApplies). `state: 'closed'`
 * closes the conversation once the message is in, so a resolved alert lands on
 * its ticket and closes it.
 */
export const handleCreateConversation: ActionHandler = async (inputs, ctx) => {
  const body = text(inputs.message) ?? text(inputs.body) ?? text(inputs.description) ?? text(inputs.title);
  if (!body) throw new NonRetryableStepError('A conversation needs a message');
  const externalId = text(inputs.externalId);
  const closing = text(inputs.state)?.toLowerCase() === 'closed';
  const fields = ticketFields(inputs);
  if (fields.priority && externalId) {
    // Two deliveries for a new id at once can both see none and both write: the later priority wins, as before.
    const existing = await findDeskConversationByExternalId(ctx.db, externalId);
    if (existing && !priorityApplies(existing, fields.priority, closing)) fields.priority = undefined;
  }
  const result = await openDeskApiConversation(inboxDeps(ctx), {
    via: 'workflow',
    externalId,
    title: text(inputs.title) ?? text(inputs.subject),
    body,
    name: text(inputs.name) ?? text(inputs.customerName),
    email: text(inputs.email) ?? text(inputs.customerEmail),
    contactId: text(inputs.contactId),
    fields,
    metadata: { executionId: ctx.executionId },
  });
  let conversation = result.conversation;
  if (closing && conversation.state !== 'closed') {
    ({ conversation } = await updateDeskConversationFromApi(inboxDeps(ctx), {
      conversationId: conversation.id,
      state: 'closed',
      actor: workflowActor(ctx),
    }));
  }
  return {
    success: true,
    created: result.created,
    conversationId: conversation.id,
    conversationNumber: conversation.conversationNumber,
    state: conversation.state,
    priority: conversation.priority,
    assigneeId: conversation.assigneeId,
  };
};

/** `create_record` for a ticket: map the ticket's fields onto an inbox conversation. */
export function createTicketAsConversation(data: Record<string, unknown>, ctx: ActionContext) {
  return handleCreateConversation(
    {
      title: data.subject ?? data.title,
      message: data.description ?? data.message ?? data.subject,
      name: data.customerName ?? data.name,
      email: data.customerEmail ?? data.email,
      contactId: data.contactId,
      externalId: data.externalId,
    },
    ctx,
  );
}

export async function assignDeskConversation(
  ctx: ActionContext,
  conversationId: string,
  inputs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const agentId = text(inputs.agentId);
  if (agentId) {
    const { conversation } = await updateDeskConversationFromApi(inboxDeps(ctx), {
      conversationId,
      assigneeId: agentId,
      actor: workflowActor(ctx),
    });
    return { success: true, conversationId, assigneeId: conversation.assigneeId };
  }
  // Any other strategy hands it out by the inbox's own assignment rules.
  const assigned = await autoAssignDeskConversationFromApi(inboxDeps(ctx), conversationId);
  if (!assigned) return { success: false, error: 'No available teammate (or it is already assigned)' };
  return { success: true, conversationId, assigneeId: assigned.assigneeId };
}

const CLOSING = new Set(['closed', 'resolved', 'close']);
const OPENING = new Set(['open', 'opened', 'reopened', 'active']);

export async function changeDeskConversationState(
  ctx: ActionContext,
  conversationId: string,
  status: string,
): Promise<Record<string, unknown>> {
  let state: 'open' | 'closed';
  if (CLOSING.has(status)) state = 'closed';
  else if (OPENING.has(status)) state = 'open';
  else return { success: false, error: `Inbox conversations are open or closed; "${status}" does not apply` };
  const { conversation } = await updateDeskConversationFromApi(inboxDeps(ctx), {
    conversationId,
    state,
    actor: workflowActor(ctx),
  });
  return { success: true, conversationId, status: conversation.state };
}

const PRIORITIES = new Set(['low', 'medium', 'high', 'urgent']);

/** Priority on an inbox conversation (ADR DESK-007); the old model's `critical` is its `urgent`. */
export async function setDeskConversationPriority(
  ctx: ActionContext,
  conversationId: string,
  priority: string,
): Promise<Record<string, unknown>> {
  const wanted = priority === 'critical' ? 'urgent' : priority;
  if (wanted !== 'none' && !PRIORITIES.has(wanted)) {
    return { success: false, error: `Inbox priorities are low, medium, high and urgent; "${priority}" does not apply` };
  }
  const { conversation } = await updateDeskConversationFromApi(inboxDeps(ctx), {
    conversationId,
    fields: { priority: wanted === 'none' ? null : (wanted as 'low' | 'medium' | 'high' | 'urgent') },
    actor: workflowActor(ctx),
  });
  return { success: true, conversationId, priority: conversation.priority };
}

/** Add, remove or replace tags on an inbox conversation. */
export async function tagDeskConversation(
  ctx: ActionContext,
  conversationId: string,
  mode: string,
  tags: string[],
): Promise<Record<string, unknown>> {
  const [row] = await ctx.db
    .select({ tags: schema.deskConversations.tags })
    .from(schema.deskConversations)
    .where(eq(schema.deskConversations.id, conversationId))
    .limit(1);
  const current = row?.tags ?? [];
  const lower = new Set(tags.map((t) => t.toLowerCase()));
  let next: string[];
  if (mode === 'remove') next = current.filter((t) => !lower.has(t.toLowerCase()));
  else if (mode === 'replace') next = tags;
  else next = [...current, ...tags];
  const { conversation } = await updateDeskConversationFromApi(inboxDeps(ctx), {
    conversationId,
    fields: { tags: next },
    actor: workflowActor(ctx),
  });
  return { success: true, conversationId, mode, tags: conversation.tags };
}

export async function addDeskConversationMessage(
  ctx: ActionContext,
  conversationId: string,
  kind: 'message' | 'note',
  body: string,
): Promise<Record<string, unknown>> {
  if (!body.trim()) return { success: false, error: 'Nothing to send' };
  try {
    const { message } = await addDeskConversationMessageFromApi(inboxDeps(ctx), {
      conversationId,
      kind,
      body,
      actor: workflowActor(ctx),
    });
    return { success: true, messageId: message.id, conversationId };
  } catch (err) {
    if (err instanceof DeskReplyChannelError) return { success: false, error: err.message };
    throw err;
  }
}
