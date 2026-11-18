/**
 * Running a WeldDesk team's escalation rules (the SLA sweep calls this for
 * conversations whose `escalationCheckAt` came due; when a rule is due is
 * ./desk-escalation-check).
 *
 * A due rule:
 *   1. puts an internal `escalated` event on the timeline (team, rule index,
 *      condition, target), which is also what keeps it from firing again in
 *      this episode;
 *   2. escalates: `manager` hands the conversation to the team's manager,
 *      `specific_agent` to `escalateToId`, `next_tier` moves it to the next
 *      active team (by sort order) and auto-assigns it there; a target that
 *      doesn't exist (no manager, a teammate who left, no next team) leaves
 *      it where it is;
 *   3. with `notifyCustomer`, tells the customer in a short public system
 *      message.
 * Rules fire one at a time (the earliest first), re-derived after each, so a
 * move to the next team stops the old team's other rules.
 */

import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { TenantDb } from './any-db';
import * as schema from '../schema';
import type { IdGenerator } from './mail-contacts';
import type { DeskConversation } from '../schema/desk-conversations';
import type { DeskMessage } from '../schema/desk-messages';
import type { EscalationRule } from '../schema/helpdesk-departments';
import { appendDeskMessage, updateDeskConversationAttributes } from './desk';
import { autoAssignDeskConversation, deskTeamMemberIds, type DeskAssigneePicker } from './desk-assignment';
import { deskEscalationsDueFor, loadDeskRunningBreach, type DeskEscalationDue } from './desk-escalation-check';
import { refreshDeskSla } from './desk-sla';

type AnyDb = TenantDb;

const conversations = schema.deskConversations;
const departments = schema.helpdeskDepartments;

/** Rules one sweep fires on a conversation at most (each re-derived after the last). */
const MAX_FIRINGS = 5;

/** The public message `notifyCustomer` posts, by language (a tag's primary subtag). */
export const DESK_ESCALATION_CUSTOMER_MESSAGES: Readonly<Record<string, string>> = {
  en: 'Your request has been escalated so the right people can help. We will get back to you as soon as possible.',
  nl: 'Je verzoek is doorgezet, zodat de juiste mensen je kunnen helpen. We komen zo snel mogelijk bij je terug.',
};

/** The English notice: what a language without a text of its own gets. */
export const DESK_ESCALATION_CUSTOMER_MESSAGE = DESK_ESCALATION_CUSTOMER_MESSAGES.en!;

/**
 * The notice for a language tag (`nl`, `nl-BE`, `NL_nl`): its own text, else
 * English. A customer who writes German gets English, not the workspace's
 * Dutch.
 */
export function deskEscalationCustomerMessage(language: string | null | undefined): string {
  const primary = (language ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return DESK_ESCALATION_CUSTOMER_MESSAGES[primary] ?? DESK_ESCALATION_CUSTOMER_MESSAGE;
}

/**
 * The language the customer is told in: the conversation's (detected by
 * inbox translation), else the workspace's (`workspace_settings.language`).
 */
async function customerLanguage(db: AnyDb, conversation: DeskConversation): Promise<string | null> {
  if (conversation.language?.trim()) return conversation.language;
  const s = schema.workspaceSettings;
  const [row] = await db.select({ language: s.language }).from(s).where(isNull(s.deletedAt)).limit(1);
  return row?.language ?? null;
}

export interface DeskEscalationStep {
  conversation: DeskConversation;
  message: DeskMessage;
  /** The entity-event action: `assigned` when the owner changed, `updated` otherwise. */
  action: 'updated' | 'assigned';
}

export interface DeskEscalationResult {
  conversation: DeskConversation | null;
  steps: DeskEscalationStep[];
  /** Teammates who now own a conversation through an escalation (notify them). */
  newOwners: string[];
  /** When the workspace needs the sweep again for this conversation (copy into the due index). */
  nextCheckAt: Date | null;
}

/** An active internal member, found by user id or by member id (`helpdesk_departments.managerId` holds the latter). */
async function memberUserId(db: AnyDb, ref: string | null | undefined): Promise<string | null> {
  if (!ref) return null;
  const m = schema.workspaceMembers;
  const [row] = await db
    .select({ userId: m.userId })
    .from(m)
    .where(
      and(
        or(eq(m.userId, ref), eq(m.id, ref)),
        isNull(m.deletedAt),
        sql`upper(${m.status}) = 'ACTIVE'`,
        sql`upper(${m.memberType}) = 'INTERNAL'`,
      ),
    )
    .orderBy(asc(m.userId))
    .limit(1);
  return row?.userId ?? null;
}

/** The active team after `teamId` in the teams' order (sort order, then newest first, then id); null when it is the last. */
export async function nextDeskTeam(db: AnyDb, teamId: string): Promise<string | null> {
  const order = [sql`coalesce(${departments.sortOrder}, 0)`, desc(departments.createdAt), desc(departments.id)];
  const teams = await db
    .select({ id: departments.id, isActive: departments.isActive })
    .from(departments)
    .where(isNull(departments.deletedAt))
    .orderBy(...order);
  const at = teams.findIndex((t) => t.id === teamId);
  if (at < 0) return null;
  return teams.slice(at + 1).find((t) => t.isActive !== false)?.id ?? null;
}

interface FireContext {
  generateId: IdGenerator;
  pick: DeskAssigneePicker;
  steps: DeskEscalationStep[];
  newOwners: string[];
}

async function managerOf(db: AnyDb, teamId: string): Promise<string | null> {
  const [team] = await db.select({ managerId: departments.managerId }).from(departments).where(eq(departments.id, teamId)).limit(1);
  return memberUserId(db, team?.managerId);
}

/** Hand the conversation to `userId` (an escalation overrides the current owner). */
async function assignTo(db: AnyDb, ctx: FireContext, conversation: DeskConversation, userId: string): Promise<DeskConversation> {
  if (conversation.assigneeId === userId) return conversation;
  const result = await appendDeskMessage(db, {
    generateId: ctx.generateId,
    conversationId: conversation.id,
    kind: 'event',
    authorType: 'system',
    metadata: { eventType: 'assigned', assigneeId: userId, escalation: true },
    assigneeId: userId,
  });
  ctx.steps.push({ conversation: result.conversation, message: result.message, action: 'assigned' });
  ctx.newOwners.push(userId);
  return result.conversation;
}

/** Move to the next team; an owner outside its members lets go, and the team's members take it. */
async function moveToNextTier(
  db: AnyDb,
  ctx: FireContext,
  conversation: DeskConversation,
  nextTeamId: string,
): Promise<DeskConversation> {
  const moved = await updateDeskConversationAttributes(db, {
    generateId: ctx.generateId,
    conversationId: conversation.id,
    authorType: 'system',
    authorId: null,
    departmentId: nextTeamId,
    metadata: { escalation: true },
  });
  let current = moved.conversation;
  if (moved.message) ctx.steps.push({ conversation: current, message: moved.message, action: 'updated' });

  const members = await deskTeamMemberIds(db, nextTeamId);
  if (current.assigneeId && members && !members.includes(current.assigneeId)) {
    const released = await appendDeskMessage(db, {
      generateId: ctx.generateId,
      conversationId: current.id,
      kind: 'event',
      authorType: 'system',
      metadata: { eventType: 'unassigned', assigneeId: null, escalation: true },
      assigneeId: null,
    });
    current = released.conversation;
    ctx.steps.push({ conversation: current, message: released.message, action: 'assigned' });
  }
  const assigned = await autoAssignDeskConversation(db, { generateId: ctx.generateId, conversationId: current.id, pick: ctx.pick });
  if (assigned) {
    current = assigned.conversation;
    ctx.steps.push({ conversation: current, message: assigned.message, action: 'assigned' });
    if (current.assigneeId) ctx.newOwners.push(current.assigneeId);
  }
  return current;
}

/** Fire one due rule of the conversation's team. */
async function fire(db: AnyDb, ctx: FireContext, conversation: DeskConversation, due: DeskEscalationDue): Promise<DeskConversation> {
  const teamId = conversation.departmentId!;
  const rule: EscalationRule = due.rule;
  let target: { assigneeId?: string; toTeamId?: string } = {};
  if (rule.escalateTo === 'manager') {
    const userId = await managerOf(db, teamId);
    if (userId) target = { assigneeId: userId };
  } else if (rule.escalateTo === 'specific_agent') {
    const userId = await memberUserId(db, rule.escalateToId);
    if (userId) target = { assigneeId: userId };
  } else if (rule.escalateTo === 'next_tier') {
    const next = await nextDeskTeam(db, teamId);
    if (next) target = { toTeamId: next };
  }

  const escalated = await appendDeskMessage(db, {
    generateId: ctx.generateId,
    conversationId: conversation.id,
    kind: 'event',
    authorType: 'system',
    metadata: {
      eventType: 'escalated',
      teamId,
      ruleIndex: due.index,
      condition: rule.condition,
      escalateTo: rule.escalateTo,
      ...target,
    },
  });
  let current = escalated.conversation;
  ctx.steps.push({ conversation: current, message: escalated.message, action: 'updated' });

  if (target.assigneeId) current = await assignTo(db, ctx, current, target.assigneeId);
  else if (target.toTeamId) current = await moveToNextTier(db, ctx, current, target.toTeamId);

  if (rule.notifyCustomer) {
    const notice = await appendDeskMessage(db, {
      generateId: ctx.generateId,
      conversationId: current.id,
      kind: 'message',
      authorType: 'system',
      body: deskEscalationCustomerMessage(await customerLanguage(db, current)),
      metadata: { escalation: true },
    });
    current = notice.conversation;
    ctx.steps.push({ conversation: current, message: notice.message, action: 'updated' });
  }
  return current;
}

/**
 * Fire the escalation rules that are due on a conversation by `now`, then
 * re-derive its SLA and escalation check (which the sweep copies into the due
 * index).
 */
export async function runDeskEscalations(
  db: AnyDb,
  input: { generateId: IdGenerator; conversationId: string; now: Date; pick: DeskAssigneePicker },
): Promise<DeskEscalationResult> {
  const ctx: FireContext = { generateId: input.generateId, pick: input.pick, steps: [], newOwners: [] };
  for (let i = 0; i < MAX_FIRINGS; i++) {
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, input.conversationId)).limit(1);
    if (!conversation) return { conversation: null, steps: ctx.steps, newOwners: ctx.newOwners, nextCheckAt: null };
    const due = await deskEscalationsDueFor(db, conversation, await loadDeskRunningBreach(db, conversation.id));
    const first = due[0];
    if (!first || first.dueAt.getTime() > input.now.getTime()) break;
    await fire(db, ctx, conversation, first);
  }
  const refreshed = await refreshDeskSla(db, input.conversationId, { generateId: input.generateId, now: input.now });
  return {
    conversation: refreshed.conversation,
    steps: ctx.steps,
    newOwners: Array.from(new Set(ctx.newOwners)),
    nextCheckAt: refreshed.nextCheckAt,
  };
}

/** Look at a conversation whose escalation failed again at `retryAt`, so one bad row doesn't keep its workspace due every tick. */
export async function backOffDeskEscalation(db: AnyDb, conversationId: string, retryAt: Date): Promise<void> {
  await db.update(conversations).set({ escalationCheckAt: retryAt }).where(eq(conversations.id, conversationId));
}
