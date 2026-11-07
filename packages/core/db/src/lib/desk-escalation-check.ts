/**
 * When a WeldDesk team's escalation rules next need looking at.
 *
 * `helpdesk_departments.escalationRules` belong to a team; they apply to the
 * open conversations in that team (`desk_conversations.departmentId`). A rule
 * fires `afterMinutes` after its condition started holding:
 *
 *   - unassigned: the conversation is open and nobody owns it, since it was
 *     opened, unassigned or reopened;
 *   - no_response: the customer is waiting, since their first message after
 *     the team's last reply (the start of the waiting episode);
 *   - sla_breach: one of its running SLA clocks breached, since the earliest
 *     breach;
 *   - custom: never (there is nothing to evaluate; kept for the old editor).
 *
 * Moving into the team restarts every condition's clock for that team's
 * rules. A rule fires at most once per episode: the `escalated` timeline
 * event (metadata.teamId, metadata.ruleIndex) at or after the condition's
 * start says it already did. Everything is derived from the conversation, its
 * timeline and its SLA clocks, so any writer can recompute it.
 *
 * refreshDeskSla (./desk-sla) stores the earliest due time in
 * `desk_conversations.escalationCheckAt` and folds it into the `slaCheckAt`
 * writers copy into the due index; the SLA sweep runs the due rules
 * (./desk-escalation).
 */

import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../schema';
import type { DeskConversation } from '../schema/desk-conversations';
import type { EscalationRule } from '../schema/helpdesk-departments';

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const conversations = schema.deskConversations;
const messages = schema.deskMessages;

const MINUTE_MS = 60_000;

const CONDITIONS = new Set<string>(['sla_breach', 'no_response', 'unassigned']);
const TARGETS = new Set<string>(['manager', 'next_tier', 'specific_agent']);

/** A stored rule the engine can run (custom and malformed ones are skipped), with its index in the stored list. */
export interface DeskEscalationRuleAt {
  index: number;
  rule: EscalationRule;
}

export function runnableDeskEscalationRules(raw: unknown): DeskEscalationRuleAt[] {
  if (!Array.isArray(raw)) return [];
  const out: DeskEscalationRuleAt[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const rule = item as Record<string, unknown>;
    const after = rule.afterMinutes;
    if (typeof rule.condition !== 'string' || !CONDITIONS.has(rule.condition)) return;
    if (typeof rule.escalateTo !== 'string' || !TARGETS.has(rule.escalateTo)) return;
    if (typeof after !== 'number' || !Number.isFinite(after) || after < 0) return;
    out.push({ index, rule: rule as unknown as EscalationRule });
  });
  return out;
}

export interface DeskEscalationTimelineEntry {
  at: Date;
  kind: string;
  authorType: string;
  eventType: string | null;
  /** An `attributes_changed` event that changed the team. */
  teamChanged: boolean;
  /** An `escalated` event's team and rule. */
  teamId: string | null;
  ruleIndex: number | null;
}

/** What the timeline says about the conversation's current episode. */
export interface DeskEscalationEpisode {
  /** When it last moved into its current team (its start when it never moved). */
  teamEnteredAt: Date;
  /** Open and unowned since; null while someone owns it or it is closed. */
  unassignedSince: Date | null;
  /** The customer has been waiting since; null when they are not. */
  waitingSince: Date | null;
  fired: Array<{ teamId: string | null; ruleIndex: number | null; at: Date }>;
}

/** Replay the timeline (oldest first) from the conversation's start. Pure. */
export function deskEscalationEpisode(createdAt: Date, timeline: DeskEscalationTimelineEntry[]): DeskEscalationEpisode {
  let open = true;
  let owned = false;
  const episode: DeskEscalationEpisode = { teamEnteredAt: createdAt, unassignedSince: createdAt, waitingSince: null, fired: [] };
  const reopen = (at: Date) => {
    if (open) return;
    open = true;
    if (!owned) episode.unassignedSince = at;
  };
  for (const entry of timeline) {
    if (entry.kind === 'message') {
      if (entry.authorType === 'visitor') {
        reopen(entry.at);
        if (!episode.waitingSince) episode.waitingSince = entry.at;
      } else if (entry.authorType === 'agent' || entry.authorType === 'bot') {
        episode.waitingSince = null;
      }
      continue;
    }
    if (entry.kind !== 'event') continue;
    switch (entry.eventType) {
      case 'closed':
        open = false;
        episode.waitingSince = null;
        episode.unassignedSince = null;
        break;
      case 'reopened':
        reopen(entry.at);
        break;
      case 'assigned':
        owned = true;
        episode.unassignedSince = null;
        break;
      case 'unassigned':
        owned = false;
        if (open) episode.unassignedSince = entry.at;
        break;
      case 'attributes_changed':
        if (entry.teamChanged) episode.teamEnteredAt = entry.at;
        break;
      case 'escalated':
        episode.fired.push({ teamId: entry.teamId, ruleIndex: entry.ruleIndex, at: entry.at });
        break;
    }
  }
  return episode;
}

export interface DeskEscalationDue extends DeskEscalationRuleAt {
  /** When the rule fires (may be in the past: it is overdue). */
  dueAt: Date;
}

function later(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * The team's rules that can still fire in this episode, with when. Pure:
 * `conversation` is its current state (the columns are what counts), the
 * episode comes from its timeline, `breachedAt` is the earliest breach of a
 * running SLA clock.
 */
export function deskEscalationsDue(input: {
  conversation: Pick<DeskConversation, 'state' | 'assigneeId' | 'departmentId'>;
  rules: DeskEscalationRuleAt[];
  episode: DeskEscalationEpisode;
  breachedAt: Date | null;
}): DeskEscalationDue[] {
  const { conversation, episode } = input;
  if (conversation.state !== 'open' || !conversation.departmentId) return [];
  const teamId = conversation.departmentId;
  const out: DeskEscalationDue[] = [];
  for (const { index, rule } of input.rules) {
    let since: Date | null = null;
    if (rule.condition === 'unassigned') since = conversation.assigneeId ? null : episode.unassignedSince;
    else if (rule.condition === 'no_response') since = episode.waitingSince;
    else if (rule.condition === 'sla_breach') since = input.breachedAt;
    if (!since) continue;
    const anchor = later(since, episode.teamEnteredAt);
    const fired = episode.fired.some(
      (f) => f.teamId === teamId && f.ruleIndex === index && f.at.getTime() >= anchor.getTime(),
    );
    if (fired) continue;
    out.push({ index, rule, dueAt: new Date(anchor.getTime() + Math.round(rule.afterMinutes * MINUTE_MS)) });
  }
  return out.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.index - b.index);
}

// ── Reading what the derivation needs ───────────────────────────────────────

/** The team's runnable rules; none when the conversation has no team or it is gone or inactive. */
export async function loadDeskTeamEscalationRules(
  db: AnyDb,
  teamId: string | null | undefined,
): Promise<DeskEscalationRuleAt[]> {
  if (!teamId) return [];
  const d = schema.helpdeskDepartments;
  const [team] = await db
    .select({ rules: d.escalationRules, isActive: d.isActive })
    .from(d)
    .where(and(eq(d.id, teamId), isNull(d.deletedAt)))
    .limit(1);
  if (!team || team.isActive === false) return [];
  return runnableDeskEscalationRules(team.rules);
}

export async function loadDeskEscalationTimeline(db: AnyDb, conversationId: string): Promise<DeskEscalationTimelineEntry[]> {
  const rows = await db
    .select({
      at: messages.createdAt,
      kind: messages.kind,
      authorType: messages.authorType,
      eventType: sql<string | null>`${messages.metadata}->>'eventType'`,
      teamChanged: sql<boolean>`coalesce(${messages.metadata}->'changes' @> '[{"field":"team"}]'::jsonb, false)`,
      teamId: sql<string | null>`${messages.metadata}->>'teamId'`,
      ruleIndex: sql<string | null>`${messages.metadata}->>'ruleIndex'`,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), inArray(messages.kind, ['message', 'event'])))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  return rows.map((r) => ({
    ...r,
    teamChanged: Boolean(r.teamChanged),
    ruleIndex: r.ruleIndex == null || r.ruleIndex === '' ? null : Number(r.ruleIndex),
  }));
}

/** The earliest breach of a running SLA clock, as stored. */
export async function loadDeskRunningBreach(db: AnyDb, conversationId: string): Promise<Date | null> {
  const c = schema.deskSlaClocks;
  const [row] = await db
    .select({ at: sql<Date | null>`min(${c.breachedAt})`.mapWith(c.breachedAt) })
    .from(c)
    .where(and(eq(c.conversationId, conversationId), eq(c.status, 'running')));
  return row?.at ?? null;
}

/** The team's rules that can still fire for the conversation, read from the database. */
export async function deskEscalationsDueFor(
  db: AnyDb,
  conversation: DeskConversation,
  breachedAt: Date | null,
): Promise<DeskEscalationDue[]> {
  if (conversation.state !== 'open' || !conversation.departmentId) return [];
  const rules = await loadDeskTeamEscalationRules(db, conversation.departmentId);
  if (rules.length === 0) return [];
  const episode = deskEscalationEpisode(conversation.createdAt, await loadDeskEscalationTimeline(db, conversation.id));
  return deskEscalationsDue({ conversation, rules, episode, breachedAt });
}

/**
 * Re-derive and store `escalationCheckAt` (the earliest rule still to fire,
 * null when none can). Writes only when it changed.
 */
export async function refreshDeskEscalationCheck(
  db: AnyDb,
  conversation: DeskConversation,
  breachedAt: Date | null,
): Promise<{ conversation: DeskConversation; escalationCheckAt: Date | null }> {
  const due = await deskEscalationsDueFor(db, conversation, breachedAt);
  const next = due[0]?.dueAt ?? null;
  if ((conversation.escalationCheckAt?.getTime() ?? null) === (next?.getTime() ?? null)) {
    return { conversation, escalationCheckAt: next };
  }
  const [updated] = await db
    .update(conversations)
    .set({ escalationCheckAt: next })
    .where(eq(conversations.id, conversation.id))
    .returning();
  return { conversation: updated ?? { ...conversation, escalationCheckAt: next }, escalationCheckAt: next };
}

/** Open conversations with an escalation rule due by `now`, the most overdue first. */
export async function listDueDeskEscalations(db: AnyDb, now: Date, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(lte(conversations.escalationCheckAt, now))
    .orderBy(asc(conversations.escalationCheckAt), asc(conversations.id))
    .limit(limit);
  return rows.map((r) => r.id);
}
