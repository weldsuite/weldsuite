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
 * contactId, externalId.
 */
export const handleCreateConversation: ActionHandler = async (inputs, ctx) => {
  const body = text(inputs.message) ?? text(inputs.body) ?? text(inputs.description) ?? text(inputs.title);
  if (!body) throw new NonRetryableStepError('A conversation needs a message');
  const result = await openDeskApiConversation(inboxDeps(ctx), {
    via: 'workflow',
    externalId: text(inputs.externalId),
    title: text(inputs.title) ?? text(inputs.subject),
    body,
    name: text(inputs.name) ?? text(inputs.customerName),
    email: text(inputs.email) ?? text(inputs.customerEmail),
    contactId: text(inputs.contactId),
    metadata: { executionId: ctx.executionId },
  });
  return {
    success: true,
    created: result.created,
    conversationId: result.conversation.id,
    conversationNumber: result.conversation.conversationNumber,
    state: result.conversation.state,
    assigneeId: result.conversation.assigneeId,
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
