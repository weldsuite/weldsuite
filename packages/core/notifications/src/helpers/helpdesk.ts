/**
 * WeldDesk notification helpers — a conversation/ticket was assigned to a
 * teammate, a customer replied on a conversation assigned to a teammate, and
 * an inbox conversation's SLA is about to breach or has.
 *
 * All honour the workspace's helpdesk notification settings
 * (`helpdesk_settings.notifications.notifyOnAssignment` /
 * `notifyOnCustomerReply` / `notifyOnSLABreach`, edited in WeldDesk settings). A missing settings
 * row, or a missing key, counts as enabled — that is what the settings screen
 * shows for a workspace that never saved them.
 *
 * Visitor messages on the chat widget are NOT sent from here: the widget worker
 * notifies the assignee (or the whole team when unassigned) itself with the
 * `message_received` type. Use `sendTicketReplyNotification` for the channels
 * that have no such path (email, phone/SMS, …), and only when a teammate owns
 * the conversation.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import { createAndDeliverNotification } from '../orchestrator';
import type { Database, NotificationEnv } from '../types';

/** Notification preview length, same cap the widget's team notification uses. */
const PREVIEW_MAX = 180;

/** What the notification points at: the inbox conversation or a ticket. */
export type HelpdeskEntityKind = 'conversation' | 'ticket';

type HelpdeskNotifyKey = 'notifyOnAssignment' | 'notifyOnCustomerReply' | 'notifyOnSLABreach';

/** Collapse whitespace and cut to `max` characters (ellipsis when cut). */
export function helpdeskPreview(text: string | null | undefined, max = PREVIEW_MAX): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Pure gate over the stored settings blob. `undefined` (no row, no key) is
 * enabled; only an explicit `false` turns a notification off.
 */
export function isHelpdeskNotificationEnabled(
  notifications: Partial<Record<HelpdeskNotifyKey, boolean>> | null | undefined,
  key: HelpdeskNotifyKey,
): boolean {
  return notifications?.[key] !== false;
}

async function loadHelpdeskNotificationSettings(
  db: Database,
): Promise<Partial<Record<HelpdeskNotifyKey, boolean>> | null> {
  const [row] = await db
    .select({ notifications: schema.helpdeskSettings.notifications })
    .from(schema.helpdeskSettings)
    .where(isNull(schema.helpdeskSettings.deletedAt))
    .limit(1);
  return row?.notifications ?? null;
}

function actionUrlFor(kind: HelpdeskEntityKind, id: string): string {
  return kind === 'ticket' ? `/welddesk/tickets/${id}` : `/welddesk/inbox/${id}`;
}

function entityTypeFor(kind: HelpdeskEntityKind): string {
  return kind === 'ticket' ? 'ticket' : 'desk_conversation';
}

async function memberName(db: Database, userId: string): Promise<string | null> {
  try {
    const [member] = await db
      .select({ name: schema.workspaceMembers.name })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, userId))
      .limit(1);
    return member?.name?.trim() || null;
  } catch (err) {
    console.error('[Notifications] Failed to resolve member name:', err);
    return null;
  }
}

interface TicketAssignedParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  /** Clerk org id. */
  workspaceId: string;
  /** The teammate who now owns the conversation/ticket. */
  assigneeId: string;
  /** Who made the assignment; `null` for the system (auto-assignment). A
   *  self-assignment sends nothing. */
  assignedByUserId: string | null;
  kind: HelpdeskEntityKind;
  entityId: string;
  /** Conversation title / ticket subject. */
  subject?: string | null;
  /** Human reference, e.g. `TKT-1042` or `#318`. Shown when there is no subject. */
  reference?: string | null;
}

/**
 * Tell a teammate a conversation or ticket was assigned to them. Returns the
 * notification id, or `null` when nothing was sent (self-assignment, the
 * workspace turned `notifyOnAssignment` off).
 */
export async function sendTicketAssignedNotification<Env extends NotificationEnv>(
  params: TicketAssignedParams<Env>,
): Promise<string | null> {
  const { db, env, workspaceId, assigneeId, assignedByUserId, kind, entityId, subject, reference } = params;

  if (!assigneeId || assigneeId === assignedByUserId) return null;

  const settings = await loadHelpdeskNotificationSettings(db);
  if (!isHelpdeskNotificationEnabled(settings, 'notifyOnAssignment')) return null;

  const assignerName = assignedByUserId ? await memberName(db, assignedByUserId) : null;
  const noun = kind === 'ticket' ? 'ticket' : 'conversation';
  const label = helpdeskPreview(subject, 120) || reference?.trim() || `a ${noun}`;
  const body = assignerName
    ? `${assignerName} assigned "${label}" to you`
    : `"${label}" was assigned to you`;

  return createAndDeliverNotification({
    db,
    env,
    workspaceId,
    userId: assigneeId,
    title: kind === 'ticket' ? 'Ticket assigned to you' : 'Conversation assigned to you',
    body,
    category: 'helpdesk',
    notificationType: 'ticket_assigned',
    entityType: entityTypeFor(kind),
    entityId,
    actionUrl: actionUrlFor(kind, entityId),
    severity: 'info',
    actorType: assignedByUserId ? 'user' : 'system',
    actorId: assignedByUserId,
    data: kind === 'ticket' ? { ticketId: entityId } : { conversationId: entityId },
  });
}

interface TicketReplyParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  /** Clerk org id. */
  workspaceId: string;
  /** The teammate the conversation/ticket is assigned to. Nothing is sent
   *  without one: an unassigned reply is the team-wide notification's job. */
  assigneeId: string | null | undefined;
  kind: HelpdeskEntityKind;
  entityId: string;
  /** Display name of the customer who replied (name, else email). */
  customerName: string;
  /** CRM contact id of the customer, when known — drives the avatar. */
  customerContactId?: string | null;
  /** The reply text; collapsed and truncated into the notification body. */
  messageBody?: string | null;
  /** Conversation title / ticket subject, the body fallback for an empty reply. */
  subject?: string | null;
}

/**
 * Tell the assignee a customer replied. Returns the notification id, or `null`
 * when nothing was sent (unassigned, the workspace turned
 * `notifyOnCustomerReply` off).
 */
export async function sendTicketReplyNotification<Env extends NotificationEnv>(
  params: TicketReplyParams<Env>,
): Promise<string | null> {
  const { db, env, workspaceId, assigneeId, kind, entityId, customerName, customerContactId, messageBody, subject } =
    params;

  if (!assigneeId) return null;

  const settings = await loadHelpdeskNotificationSettings(db);
  if (!isHelpdeskNotificationEnabled(settings, 'notifyOnCustomerReply')) return null;

  const who = customerName.trim() || 'A customer';
  const body = helpdeskPreview(messageBody) || helpdeskPreview(subject) || 'New reply';

  return createAndDeliverNotification({
    db,
    env,
    workspaceId,
    userId: assigneeId,
    title: `${who} replied`,
    body,
    category: 'helpdesk',
    notificationType: 'ticket_reply',
    entityType: entityTypeFor(kind),
    entityId,
    actionUrl: actionUrlFor(kind, entityId),
    severity: 'info',
    actorType: customerContactId ? 'contact' : 'system',
    actorId: customerContactId ?? null,
    data: kind === 'ticket' ? { ticketId: entityId } : { conversationId: entityId },
  });
}

/** The SLA metrics a conversation is measured on (desk_sla_clocks.metric). */
export type DeskSlaNotificationMetric = 'first_response' | 'next_response' | 'resolution';

const SLA_METRIC_LABELS: Record<DeskSlaNotificationMetric, string> = {
  first_response: 'First response',
  next_response: 'Next response',
  resolution: 'Resolution',
};

/** Cap on the team-wide fallback, same as the widget's visitor-message fan-out. */
const MAX_SLA_RECIPIENTS = 200;
const SLA_NOTIFY_BATCH = 10;

/** The assignee, else every active internal teammate who can work the inbox. */
async function slaRecipients(db: Database, assigneeId: string | null | undefined): Promise<string[]> {
  if (assigneeId) return [assigneeId];
  const { workspaceMembers } = schema;
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        sql`upper(${workspaceMembers.status}) = 'ACTIVE'`,
        sql`upper(${workspaceMembers.memberType}) = 'INTERNAL'`,
        sql`upper(${workspaceMembers.role}) <> 'VIEWER'`,
      ),
    )
    .limit(MAX_SLA_RECIPIENTS);
  return Array.from(new Set(rows.map((r) => r.userId)));
}

interface DeskSlaNotificationParams<Env extends NotificationEnv> {
  db: Database;
  env: Env;
  /** Clerk org id. */
  workspaceId: string;
  type: 'warning' | 'breach';
  metric: DeskSlaNotificationMetric;
  conversationId: string;
  /** Who hears about it; unassigned conversations go to the whole team. */
  assigneeId: string | null | undefined;
  subject?: string | null;
  /** Human reference, e.g. `#318`. */
  reference?: string | null;
  dueAt: Date | null;
}

/**
 * Tell the team an inbox conversation's SLA clock is about to breach, or has.
 * Honours `notifyOnSLABreach` (both kinds). Returns how many notifications went out.
 */
export async function sendDeskSlaNotification<Env extends NotificationEnv>(
  params: DeskSlaNotificationParams<Env>,
): Promise<number> {
  const { db, env, workspaceId, type, metric, conversationId, assigneeId, subject, reference, dueAt } = params;

  const settings = await loadHelpdeskNotificationSettings(db);
  if (!isHelpdeskNotificationEnabled(settings, 'notifyOnSLABreach')) return 0;

  const recipients = await slaRecipients(db, assigneeId);
  const label = helpdeskPreview(subject, 120) || reference?.trim() || 'a conversation';
  const metricLabel = SLA_METRIC_LABELS[metric];
  const title = type === 'breach' ? `SLA breached: ${metricLabel}` : `SLA due soon: ${metricLabel}`;
  const body =
    type === 'breach'
      ? `"${label}" missed its ${metricLabel.toLowerCase()} target`
      : `"${label}" reaches its ${metricLabel.toLowerCase()} target soon`;

  let sent = 0;
  for (let i = 0; i < recipients.length; i += SLA_NOTIFY_BATCH) {
    const results = await Promise.allSettled(
      recipients.slice(i, i + SLA_NOTIFY_BATCH).map((userId) =>
        createAndDeliverNotification({
          db,
          env,
          workspaceId,
          userId,
          title,
          body,
          category: 'helpdesk',
          notificationType: type === 'breach' ? 'sla_breached' : 'sla_warning',
          entityType: 'desk_conversation',
          entityId: conversationId,
          actionUrl: actionUrlFor('conversation', conversationId),
          severity: type === 'breach' ? 'error' : 'warning',
          actorType: 'system',
          actorId: null,
          data: { conversationId, metric, ...(dueAt ? { dueAt: dueAt.toISOString() } : {}) },
        }),
      ),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') sent += 1;
      else console.error('[Notifications] SLA notification failed:', result.reason);
    }
  }
  return sent;
}
