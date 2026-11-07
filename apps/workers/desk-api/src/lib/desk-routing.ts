/**
 * Routing after an agent edits a conversation's ticket fields (PATCH
 * /api/desk/conversations/:id): a change to the type or the tags runs the
 * workspace's routing rules again (`@weldsuite/db/lib/desk-routing`), except
 * that a change which set the team itself keeps that team. Also the entity
 * event's `changes`, so workflow triggers see what moved.
 */

import type { Context } from 'hono';
import { publishEntityEvent } from '@weldsuite/entity-events';
import type { DeskConversation, DeskMessage } from '@weldsuite/db/lib/desk';
import { deskAssignmentRouterPicker } from '@weldsuite/db/lib/desk-assignment';
import {
  deskChangeReroutes,
  routeAndAssignDeskConversation,
  type DeskRoutingResult,
} from '@weldsuite/db/lib/desk-routing';
import type { DeskAttributeChange } from '@weldsuite/db/schema';
import { generateId } from '@weldsuite/worker-kit/id';
import type { Env, Variables } from '../types';
import { notifyAssigned } from './notify';
import { markDeskSlaDue } from './sla-due';

type DeskContext = Context<{ Bindings: Env; Variables: Variables }>;

/** The ticket columns an attribute change can move, as the entity event's `changes`. */
const ATTRIBUTE_COLUMNS = ['ticketTypeId', 'priority', 'tags', 'departmentId'] as const;

export function deskAttributeChanges(
  before: DeskConversation | undefined,
  after: DeskConversation,
): Record<string, { old: unknown; new: unknown }> | undefined {
  if (!before) return undefined;
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const key of ATTRIBUTE_COLUMNS) {
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      changes[key] = { old: before[key] ?? null, new: after[key] ?? null };
    }
  }
  return Object.keys(changes).length > 0 ? changes : undefined;
}

/**
 * Re-route after an `attributes_changed` event the agent caused, publishing
 * every step like the inbox's own writes. Null when the change doesn't
 * re-route (or nothing applied).
 */
export async function rerouteAfterAttributes(
  c: DeskContext,
  message: DeskMessage,
  publishChange: (conversation: DeskConversation, message: DeskMessage) => Promise<void>,
): Promise<DeskRoutingResult | null> {
  const { reroute, keepTeam } = deskChangeReroutes(message.metadata?.changes as DeskAttributeChange[] | undefined);
  if (!reroute) return null;
  const routed = await routeAndAssignDeskConversation(c.get('tenantDb'), {
    generateId,
    conversationId: message.conversationId,
    trigger: 'changed',
    keepTeam,
    pick: deskAssignmentRouterPicker(c.env.HELPDESK_WORKFLOW, c.get('clerkOrgId')),
  });
  if (routed.steps.length === 0) return null;
  let previousAssigneeId: string | null = null;
  for (const step of routed.steps) {
    publishEntityEvent({
      c,
      entityType: 'desk_conversation',
      action: step.action,
      entityId: step.conversation.id,
      data: step.conversation as unknown as Record<string, unknown>,
    });
    publishEntityEvent({
      c,
      entityType: 'desk_message',
      action: 'created',
      entityId: step.message.id,
      data: step.message as unknown as Record<string, unknown>,
    });
    c.executionCtx.waitUntil(publishChange(step.conversation, step.message));
    if (step.action === 'assigned') {
      notifyAssigned(c, {
        assigneeId: step.conversation.assigneeId,
        previousAssigneeId,
        kind: 'conversation',
        entityId: step.conversation.id,
        subject: step.conversation.title || step.conversation.name || step.conversation.email,
        reference: `#${step.conversation.conversationNumber}`,
        assignedByUserId: null,
      });
    }
    previousAssigneeId = step.conversation.assigneeId;
  }
  markDeskSlaDue(c, routed.slaCheckAt);
  return routed;
}
