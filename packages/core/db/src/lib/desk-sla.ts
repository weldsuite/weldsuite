/**
 * WeldDesk SLA engine.
 *
 * Every clock is derived from two things that are always in the tenant DB:
 * the conversation's timeline (desk_messages) and the SLA policy that matches
 * its ticket fields (helpdesk_slas). refreshDeskSla replays the timeline under
 * the policy's targets and calendar, stores the result in desk_sla_clocks and
 * a summary on desk_conversations, and is the only writer of both. Because a
 * clock can always be rebuilt, every writer can just call it again: a policy
 * edit, a priority change or a late message all converge on the same answer.
 *
 * Rules (Zendesk "reply time" / "agent work time", TOPdesk response and
 * resolution targets):
 *   - first_response: from the visitor's first message to the first agent
 *     reply. A conversation the team started has none.
 *   - next_response: from a visitor message that follows an agent reply to the
 *     next agent reply; restarts every cycle. Target: the policy's updateTime.
 *   - resolution: from the first message to the close. It pauses while the
 *     team has answered and waits on the customer (the last public message is
 *     an agent's) and resumes when the customer writes. A reopen resumes it.
 *   - Closing stops the reply clocks without meeting them (cancelled).
 *   - Bot and system messages never meet or pause a clock.
 *   - Time counts on the policy's calendar: 24x7, the policy's own business
 *     hours, or the workspace's helpdesk business hours.
 *
 * Scheduling follows ADR DATA-008: `nextCheckAt` on a clock says when the
 * sweep has to look again (a warning or breach coming due). Writers copy the
 * earliest one into the D1 due index (kind `desk_sla`); the desk-api sweep
 * opens only workspaces that are due and calls refreshDeskSla with
 * `acknowledge`, which returns the warnings and breaches to announce.
 */

import { and, asc, eq, inArray, isNotNull, isNull, lte, min, notInArray, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../schema';
import type { DeskConversation, DeskSlaStatus } from '../schema/desk-conversations';
import type { DeskAuthorType } from '../schema/desk-messages';
import type { DeskSlaClock, DeskSlaClockStatus, DeskSlaMetric } from '../schema/desk-sla-clocks';
import type { BusinessHours, HelpdeskSla, SLACondition, SLATarget } from '../schema/helpdesk-slas';
import type { IdGenerator } from './mail-contacts';
import { addBusinessMs, businessMsBetween, toDeskSlaCalendar, type DeskSlaCalendar } from './desk-sla-calendar';

export type { DeskSlaClock, DeskSlaMetric, DeskSlaStatus };

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const clocks = schema.deskSlaClocks;
const conversations = schema.deskConversations;
const messages = schema.deskMessages;
const policies = schema.helpdeskSlas;

export const DESK_SLA_METRICS = ['first_response', 'next_response', 'resolution'] as const satisfies readonly DeskSlaMetric[];

const MINUTE_MS = 60_000;

/** Share of the target after which agents are warned when the policy sets no reminder. */
const DEFAULT_WARN_SHARE = 0.75;

// ── Policy selection ────────────────────────────────────────────────────────

const PRIORITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, urgent: 4, critical: 5 };

type ConversationFields = Pick<
  DeskConversation,
  'priority' | 'channel' | 'ticketTypeId' | 'departmentId' | 'tags' | 'assigneeId' | 'email'
>;

const CONDITION_FIELDS: Record<string, (c: ConversationFields) => unknown> = {
  priority: (c) => c.priority,
  channel: (c) => c.channel,
  ticketTypeId: (c) => c.ticketTypeId,
  ticketType: (c) => c.ticketTypeId,
  type: (c) => c.ticketTypeId,
  departmentId: (c) => c.departmentId,
  department: (c) => c.departmentId,
  teamId: (c) => c.departmentId,
  team: (c) => c.departmentId,
  tags: (c) => c.tags,
  tag: (c) => c.tags,
  assigneeId: (c) => c.assigneeId,
  assignee: (c) => c.assigneeId,
  email: (c) => c.email,
};

function same(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function rankOf(field: string, value: unknown): number {
  if (field === 'priority') return PRIORITY_RANK[String(value ?? '').toLowerCase()] ?? 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

function conditionHolds(condition: SLACondition, conversation: ConversationFields): boolean {
  const read = CONDITION_FIELDS[condition.field];
  // A condition the engine can't evaluate (a legacy ticket field) never matches.
  if (!read) return false;
  const actual = read(conversation);
  const expected = asList(condition.value);
  const equals = Array.isArray(actual)
    ? expected.some((v) => actual.some((a) => same(a, v)))
    : expected.some((v) => same(actual, v));
  switch (condition.operator) {
    case 'equals':
      return equals;
    case 'not_equals':
      return !equals;
    case 'contains':
      return Array.isArray(actual)
        ? equals
        : expected.some((v) => String(actual ?? '').toLowerCase().includes(String(v ?? '').toLowerCase()));
    case 'greater_than':
      return rankOf(condition.field, actual) > rankOf(condition.field, condition.value);
    case 'less_than':
      return rankOf(condition.field, actual) < rankOf(condition.field, condition.value);
    default:
      return false;
  }
}

/**
 * The policy that applies to a conversation: the first active policy (by
 * `priority`, lowest first, then oldest) whose conditions all hold, else the
 * default policy. A non-default policy without conditions matches everything.
 */
export function selectDeskSlaPolicy(
  candidates: HelpdeskSla[],
  conversation: ConversationFields,
): HelpdeskSla | null {
  const active = candidates
    .filter((p) => p.isActive && !p.deletedAt)
    .sort(
      (a, b) =>
        (a.priority ?? 0) - (b.priority ?? 0) || a.createdAt.getTime() - b.createdAt.getTime(),
    );
  const matched = active.find(
    (p) => !p.isDefault && (p.conditions ?? []).every((condition) => conditionHolds(condition, conversation)),
  );
  return matched ?? active.find((p) => p.isDefault) ?? null;
}

export interface DeskSlaTarget {
  targetMinutes: number;
  warnBeforeMinutes: number | null;
}

function warnBeforeFor(policy: HelpdeskSla, target: SLATarget): number | null {
  const reminders = (policy.reminders ?? [])
    .filter((r) => r.type === 'before_breach' && r.time > 0)
    .map((r) => r.time);
  const shares = (target.notifyAt ?? []).filter((p) => p > 0 && p < 100);
  let before: number;
  if (reminders.length > 0) before = Math.max(...reminders);
  else if (shares.length > 0) before = Math.round((target.time * (100 - Math.min(...shares))) / 100);
  else before = Math.round(target.time * (1 - DEFAULT_WARN_SHARE));
  return before > 0 && before < target.time ? before : null;
}

/**
 * Targets per metric for a conversation's priority. A conversation without a
 * priority is measured against the policy's `medium` targets.
 */
export function deskSlaTargets(
  policy: HelpdeskSla,
  priority: string | null | undefined,
): Partial<Record<DeskSlaMetric, DeskSlaTarget>> {
  const wanted = priority ?? 'medium';
  const pick = (list: SLATarget[] | null | undefined): DeskSlaTarget | undefined => {
    const target = (list ?? []).find((t) => t.priority === wanted && t.time > 0);
    return target ? { targetMinutes: Math.round(target.time), warnBeforeMinutes: warnBeforeFor(policy, target) } : undefined;
  };
  const targets: Partial<Record<DeskSlaMetric, DeskSlaTarget>> = {};
  const first = pick(policy.firstResponseTime);
  const next = pick(policy.updateTime);
  const resolution = pick(policy.resolutionTime);
  if (first) targets.first_response = first;
  if (next) targets.next_response = next;
  if (resolution) targets.resolution = resolution;
  return targets;
}

/** The calendar a policy counts on; null = 24x7. */
export function deskSlaBusinessHours(
  policy: HelpdeskSla,
  workspaceHours: BusinessHours | null | undefined,
): BusinessHours | null {
  if (policy.operationalHours === '24x7') return null;
  if (policy.operationalHours === 'custom') return policy.businessHours ?? null;
  return policy.businessHours ?? workspaceHours ?? null;
}

// ── Timeline replay ─────────────────────────────────────────────────────────

export interface DeskSlaTimelineEntry {
  at: Date;
  kind: 'message' | 'note' | 'event';
  authorType: DeskAuthorType;
  eventType?: string | null;
}

export interface DerivedDeskSlaClock {
  metric: DeskSlaMetric;
  status: DeskSlaClockStatus;
  targetMinutes: number;
  warnBeforeMinutes: number | null;
  startedAt: Date;
  elapsedSeconds: number;
  dueAt: Date | null;
  warnAt: Date | null;
  breachedAt: Date | null;
  completedAt: Date | null;
}

/** One clock while the timeline is replayed. */
class ReplayClock {
  status: DeskSlaClockStatus = 'running';
  /** Business milliseconds counted so far. */
  elapsed = 0;
  runningSince: Date | null;
  warnReachedAt: Date | null = null;
  breachedAt: Date | null = null;
  completedAt: Date | null = null;

  constructor(
    readonly metric: DeskSlaMetric,
    readonly target: DeskSlaTarget,
    readonly startedAt: Date,
    private readonly calendar: DeskSlaCalendar | null,
  ) {
    this.runningSince = startedAt;
  }

  private get targetMs(): number {
    return this.target.targetMinutes * MINUTE_MS;
  }

  /** Elapsed time at which the warning comes due; null when the target has none. */
  private get warnAfterMs(): number | null {
    const before = this.target.warnBeforeMinutes;
    return before == null ? null : this.targetMs - before * MINUTE_MS;
  }

  get running(): boolean {
    return this.status === 'running';
  }

  /** Count the business time up to `at`, noting when the warning and breach points were passed. */
  advance(at: Date): void {
    const since = this.runningSince;
    if (!this.running || !since) return;
    const segment = businessMsBetween(this.calendar, since, at);
    const warnAfter = this.warnAfterMs;
    if (warnAfter != null && !this.warnReachedAt && this.elapsed + segment >= warnAfter) {
      this.warnReachedAt = addBusinessMs(this.calendar, since, warnAfter - this.elapsed);
    }
    if (!this.breachedAt && this.elapsed + segment > this.targetMs) {
      this.breachedAt = addBusinessMs(this.calendar, since, this.targetMs - this.elapsed);
    }
    this.elapsed += segment;
    this.runningSince = at;
  }

  stop(at: Date, status: 'paused' | 'completed' | 'cancelled'): void {
    if (!this.running) return;
    this.advance(at);
    this.status = status;
    this.runningSince = null;
    if (status !== 'paused') this.completedAt = at;
  }

  resume(at: Date): void {
    if (this.running) return;
    this.status = 'running';
    this.runningSince = at;
    this.completedAt = null;
  }

  /** Close: a clock waiting on the customer is done as it stands. */
  finish(at: Date): void {
    if (this.status === 'paused') {
      this.status = 'completed';
      this.completedAt = at;
    } else {
      this.stop(at, 'completed');
    }
  }

  /** Reopened by the team: waiting on the customer until they write. */
  reopen(): void {
    if (this.status !== 'completed') return;
    this.status = 'paused';
    this.completedAt = null;
  }

  toDerived(now: Date): DerivedDeskSlaClock {
    const running = this.running;
    if (running) this.advance(now);
    const warnAfter = this.warnAfterMs;
    let dueAt: Date | null = null;
    let warnAt: Date | null = null;
    if (running) {
      dueAt = this.breachedAt ?? addBusinessMs(this.calendar, now, this.targetMs - this.elapsed);
      if (warnAfter != null) warnAt = this.warnReachedAt ?? addBusinessMs(this.calendar, now, warnAfter - this.elapsed);
    }
    return {
      metric: this.metric,
      status: this.status,
      targetMinutes: this.target.targetMinutes,
      warnBeforeMinutes: this.target.warnBeforeMinutes,
      startedAt: this.startedAt,
      elapsedSeconds: Math.floor(this.elapsed / 1000),
      dueAt,
      warnAt,
      breachedAt: this.breachedAt,
      completedAt: this.completedAt,
    };
  }
}

/** The conversation as the replay walks its timeline: the clocks and who has the ball. */
class SlaReplay {
  private readonly clocks = new Map<DeskSlaMetric, ReplayClock>();
  private open = true;
  private firstResponseStarted = false;
  private agentReplied = false;

  constructor(
    private readonly targets: Partial<Record<DeskSlaMetric, DeskSlaTarget>>,
    private readonly calendar: DeskSlaCalendar | null,
  ) {}

  private start(metric: DeskSlaMetric, at: Date): ReplayClock | undefined {
    const target = this.targets[metric];
    if (!target) return undefined;
    const clock = new ReplayClock(metric, target, at, this.calendar);
    this.clocks.set(metric, clock);
    return clock;
  }

  /** The running reply clock (first or next response), if any. */
  private replyClock(): ReplayClock | undefined {
    return [this.clocks.get('first_response'), this.clocks.get('next_response')].find((c) => c?.running);
  }

  apply(entry: DeskSlaTimelineEntry): void {
    if (entry.kind === 'message' && entry.authorType === 'visitor') this.visitorMessage(entry.at);
    else if (entry.kind === 'message' && entry.authorType === 'agent') this.agentMessage(entry.at);
    else if (entry.kind === 'event' && entry.eventType === 'closed') this.closed(entry.at);
    else if (entry.kind === 'event' && entry.eventType === 'reopened') this.reopened();
  }

  private visitorMessage(at: Date): void {
    this.open = true;
    if (!this.replyClock()) {
      const first = !this.firstResponseStarted && !this.agentReplied;
      this.firstResponseStarted = true;
      this.start(first ? 'first_response' : 'next_response', at);
    }
    const resolution = this.clocks.get('resolution');
    if (resolution) resolution.resume(at);
    else this.start('resolution', at);
  }

  private agentMessage(at: Date): void {
    this.agentReplied = true;
    this.firstResponseStarted = true;
    this.replyClock()?.stop(at, 'completed');
    if (!this.open) return;
    const resolution = this.clocks.get('resolution') ?? this.start('resolution', at);
    resolution?.stop(at, 'paused');
  }

  private closed(at: Date): void {
    this.open = false;
    this.replyClock()?.stop(at, 'cancelled');
    this.clocks.get('resolution')?.finish(at);
  }

  private reopened(): void {
    this.open = true;
    this.clocks.get('resolution')?.reopen();
  }

  result(now: Date): DerivedDeskSlaClock[] {
    return [...this.clocks.values()]
      .map((clock) => clock.toDerived(now))
      .sort((a, b) => DESK_SLA_METRICS.indexOf(a.metric) - DESK_SLA_METRICS.indexOf(b.metric));
  }
}

/**
 * Replay a conversation's timeline (oldest first) and return each clock as it
 * stands at `now`. Pure: the same timeline, targets and calendar always give
 * the same clocks.
 */
export function deriveDeskSlaClocks(input: {
  timeline: DeskSlaTimelineEntry[];
  targets: Partial<Record<DeskSlaMetric, DeskSlaTarget>>;
  calendar: DeskSlaCalendar | null;
  now: Date;
}): DerivedDeskSlaClock[] {
  const replay = new SlaReplay(input.targets, input.calendar);
  for (const entry of input.timeline) replay.apply(entry);
  return replay.result(input.now);
}

// ── Summary + scheduling ────────────────────────────────────────────────────

type ClockTimes = Pick<
  DeskSlaClock,
  'metric' | 'status' | 'dueAt' | 'warnAt' | 'breachedAt' | 'warnedAt' | 'breachNotifiedAt'
>;

/** When the sweep must look at a clock again; null when there is nothing left to announce. */
export function deskSlaNextCheckAt(clock: ClockTimes): Date | null {
  if (clock.status !== 'running') return null;
  if (clock.breachedAt) return clock.breachNotifiedAt ? null : clock.breachedAt;
  if (clock.warnAt && !clock.warnedAt && clock.dueAt) {
    return clock.warnAt.getTime() < clock.dueAt.getTime() ? clock.warnAt : clock.dueAt;
  }
  return clock.dueAt;
}

export interface DeskSlaSummary {
  slaStatus: DeskSlaStatus | null;
  slaDueAt: Date | null;
  slaMetric: DeskSlaMetric | null;
}

/** What the inbox shows for a conversation's clocks at `now`. */
export function summarizeDeskSla(rows: ClockTimes[], now: Date): DeskSlaSummary {
  const running = rows
    .filter((c): c is ClockTimes & { dueAt: Date } => c.status === 'running' && c.dueAt != null)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  const [soonest] = running;
  if (soonest) {
    const nowMs = now.getTime();
    let status: DeskSlaStatus = 'active';
    if (running.some((c) => c.breachedAt && c.breachedAt.getTime() <= nowMs)) status = 'breached';
    else if (running.some((c) => c.warnAt && c.warnAt.getTime() <= nowMs)) status = 'warning';
    return { slaStatus: status, slaDueAt: soonest.dueAt, slaMetric: soonest.metric };
  }
  if (rows.some((c) => c.status === 'paused')) return { slaStatus: 'paused', slaDueAt: null, slaMetric: null };
  if (rows.length > 0) {
    return { slaStatus: rows.some((c) => c.breachedAt) ? 'breached' : 'achieved', slaDueAt: null, slaMetric: null };
  }
  return { slaStatus: null, slaDueAt: null, slaMetric: null };
}

// ── Persistence ─────────────────────────────────────────────────────────────

export interface DeskSlaAlert {
  type: 'warning' | 'breach';
  metric: DeskSlaMetric;
  dueAt: Date | null;
  clock: DeskSlaClock;
}

export interface DeskSlaRefreshResult {
  conversation: DeskConversation | null;
  clocks: DeskSlaClock[];
  /** Earliest `nextCheckAt` of this conversation's clocks (copy it into the due index). */
  nextCheckAt: Date | null;
  /** Only with `acknowledge`: warnings and breaches the caller must announce now. */
  alerts: DeskSlaAlert[];
}

export interface RefreshDeskSlaOptions {
  generateId: IdGenerator;
  now?: Date;
  /**
   * The sweep: record warnings and breaches that are due as announced (once
   * per cycle) and return them as `alerts`. Write paths leave this off and
   * only re-derive.
   */
  acknowledge?: boolean;
}

async function loadTimeline(db: AnyDb, conversationId: string): Promise<DeskSlaTimelineEntry[]> {
  const rows = await db
    .select({
      at: messages.createdAt,
      kind: messages.kind,
      authorType: messages.authorType,
      eventType: sql<string | null>`${messages.metadata}->>'eventType'`,
    })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), inArray(messages.kind, ['message', 'event'])))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  return rows;
}

async function loadWorkspaceHours(db: AnyDb): Promise<BusinessHours | null> {
  const [row] = await db
    .select({ general: schema.helpdeskSettings.general })
    .from(schema.helpdeskSettings)
    .where(isNull(schema.helpdeskSettings.deletedAt))
    .limit(1);
  return (row?.general?.businessHours as BusinessHours | undefined) ?? null;
}

function sameSummary(conversation: DeskConversation, summary: DeskSlaSummary, policyId: string | null): boolean {
  return (
    (conversation.slaPolicyId ?? null) === policyId &&
    (conversation.slaStatus ?? null) === summary.slaStatus &&
    (conversation.slaMetric ?? null) === summary.slaMetric &&
    (conversation.slaDueAt?.getTime() ?? null) === (summary.slaDueAt?.getTime() ?? null)
  );
}

async function writeSummary(
  db: AnyDb,
  conversation: DeskConversation,
  summary: DeskSlaSummary,
  policyId: string | null,
): Promise<DeskConversation> {
  if (sameSummary(conversation, summary, policyId)) return conversation;
  const [updated] = await db
    .update(conversations)
    .set({ slaPolicyId: policyId, ...summary })
    .where(eq(conversations.id, conversation.id))
    .returning();
  return updated ?? { ...conversation, slaPolicyId: policyId, ...summary };
}

async function clearDeskSla(db: AnyDb, conversation: DeskConversation): Promise<DeskSlaRefreshResult> {
  if (conversation.slaPolicyId || conversation.slaStatus) {
    await db.delete(clocks).where(eq(clocks.conversationId, conversation.id));
  }
  const updated = await writeSummary(db, conversation, { slaStatus: null, slaDueAt: null, slaMetric: null }, null);
  return { conversation: updated, clocks: [], nextCheckAt: null, alerts: [] };
}

/**
 * Re-derive a conversation's SLA clocks from its timeline and the policy that
 * matches it now, and store them with the inbox summary. Safe to call any
 * number of times.
 */
export async function refreshDeskSla(
  db: AnyDb,
  conversationOrId: DeskConversation | string,
  options: RefreshDeskSlaOptions,
): Promise<DeskSlaRefreshResult> {
  const now = options.now ?? new Date();
  let conversation: DeskConversation | undefined;
  if (typeof conversationOrId === 'string') {
    [conversation] = await db.select().from(conversations).where(eq(conversations.id, conversationOrId)).limit(1);
    if (!conversation) {
      await db.delete(clocks).where(eq(clocks.conversationId, conversationOrId));
      return { conversation: null, clocks: [], nextCheckAt: null, alerts: [] };
    }
  } else {
    conversation = conversationOrId;
  }
  const current = conversation;

  const candidates = await db
    .select()
    .from(policies)
    .where(and(eq(policies.isActive, true), isNull(policies.deletedAt)));
  const policy = selectDeskSlaPolicy(candidates, conversation);
  const targets = policy ? deskSlaTargets(policy, conversation.priority) : {};
  if (!policy || Object.keys(targets).length === 0) return clearDeskSla(db, conversation);

  const hours = deskSlaBusinessHours(
    policy,
    policy.operationalHours === 'business' && !policy.businessHours ? await loadWorkspaceHours(db) : null,
  );
  const derived = deriveDeskSlaClocks({
    timeline: await loadTimeline(db, conversation.id),
    targets,
    calendar: toDeskSlaCalendar(hours),
    now,
  });
  if (derived.length === 0) return clearDeskSla(db, conversation);

  const existing = await db.select().from(clocks).where(eq(clocks.conversationId, conversation.id));
  const byMetric = new Map(existing.map((c) => [c.metric, c]));
  const alerts: DeskSlaAlert[] = [];

  const rows = derived.map((clock) => {
    const stored = byMetric.get(clock.metric);
    const cycle = stored && stored.startedAt.getTime() === clock.startedAt.getTime() ? stored : null;
    let warnedAt = cycle?.warnedAt ?? null;
    let breachNotifiedAt = cycle?.breachNotifiedAt ?? null;
    let alert: DeskSlaAlert['type'] | null = null;
    const nowMs = now.getTime();
    if (options.acknowledge && clock.status === 'running') {
      if (clock.breachedAt && clock.breachedAt.getTime() <= nowMs && !breachNotifiedAt) {
        breachNotifiedAt = now;
        alert = 'breach';
      } else if (!clock.breachedAt && clock.warnAt && clock.warnAt.getTime() <= nowMs && !warnedAt) {
        warnedAt = now;
        alert = 'warning';
      }
    }
    const row = {
      id: stored?.id ?? options.generateId('dsla'),
      createdAt: stored?.createdAt ?? now,
      updatedAt: now,
      conversationId: current.id,
      metric: clock.metric,
      policyId: policy.id,
      targetMinutes: clock.targetMinutes,
      warnBeforeMinutes: clock.warnBeforeMinutes,
      calendar: hours,
      status: clock.status,
      startedAt: clock.startedAt,
      elapsedSeconds: clock.elapsedSeconds,
      dueAt: clock.dueAt,
      warnAt: clock.warnAt,
      breachedAt: clock.breachedAt,
      completedAt: clock.completedAt,
      warnedAt,
      breachNotifiedAt,
      nextCheckAt: null as Date | null,
    } satisfies DeskSlaClock;
    row.nextCheckAt = deskSlaNextCheckAt(row);
    if (alert) alerts.push({ type: alert, metric: clock.metric, dueAt: clock.dueAt, clock: row });
    return row;
  });

  // Within one cycle an announcement already recorded by a concurrent refresh
  // is kept; at worst the sweep visits once more and finds nothing to say.
  const keepWithinCycle = (column: 'warned_at' | 'breach_notified_at') =>
    sql.raw(
      `CASE WHEN "desk_sla_clocks"."started_at" = excluded."started_at" ` +
        `THEN COALESCE("desk_sla_clocks"."${column}", excluded."${column}") ELSE excluded."${column}" END`,
    );
  await db
    .insert(clocks)
    .values(rows)
    .onConflictDoUpdate({
      target: [clocks.conversationId, clocks.metric],
      set: {
        updatedAt: sql`excluded.updated_at`,
        policyId: sql`excluded.policy_id`,
        targetMinutes: sql`excluded.target_minutes`,
        warnBeforeMinutes: sql`excluded.warn_before_minutes`,
        calendar: sql`excluded.calendar`,
        status: sql`excluded.status`,
        startedAt: sql`excluded.started_at`,
        elapsedSeconds: sql`excluded.elapsed_seconds`,
        dueAt: sql`excluded.due_at`,
        warnAt: sql`excluded.warn_at`,
        breachedAt: sql`excluded.breached_at`,
        completedAt: sql`excluded.completed_at`,
        warnedAt: keepWithinCycle('warned_at'),
        breachNotifiedAt: keepWithinCycle('breach_notified_at'),
        nextCheckAt: sql`excluded.next_check_at`,
      },
    });
  const metrics = rows.map((r) => r.metric);
  if (existing.some((c) => !metrics.includes(c.metric))) {
    await db
      .delete(clocks)
      .where(and(eq(clocks.conversationId, conversation.id), notInArray(clocks.metric, metrics)));
  }

  const updated = await writeSummary(db, conversation, summarizeDeskSla(rows, now), policy.id);
  const checks = rows.map((r) => r.nextCheckAt).filter((d): d is Date => d != null);
  return {
    conversation: updated,
    clocks: rows,
    nextCheckAt: checks.length ? new Date(Math.min(...checks.map((d) => d.getTime()))) : null,
    alerts,
  };
}

/** Conversations with a clock to look at by `now`, the most overdue first. */
export async function listDueDeskSlaConversations(db: AnyDb, now: Date, limit: number): Promise<string[]> {
  const rows = await db
    .select({ conversationId: clocks.conversationId, due: min(clocks.nextCheckAt) })
    .from(clocks)
    .where(lte(clocks.nextCheckAt, now))
    .groupBy(clocks.conversationId)
    .orderBy(asc(min(clocks.nextCheckAt)))
    .limit(limit);
  return rows.map((r) => r.conversationId);
}

/** When this workspace next has an SLA clock to look at; null when none. */
export async function nextDeskSlaCheckAt(db: AnyDb): Promise<Date | null> {
  const [row] = await db
    .select({ next: min(clocks.nextCheckAt) })
    .from(clocks)
    .where(isNotNull(clocks.nextCheckAt));
  const next = row?.next;
  if (next == null) return null;
  return next instanceof Date ? next : new Date(next);
}

/**
 * Undo an `acknowledge` whose announcement failed: clear the clock's warning
 * or breach mark for this cycle and look at it again at `retryAt`, so the
 * next sweep announces it instead of it being lost.
 */
export async function releaseDeskSlaAlert(db: AnyDb, alert: DeskSlaAlert, retryAt: Date): Promise<void> {
  const mark = alert.type === 'warning' ? { warnedAt: null } : { breachNotifiedAt: null };
  await db
    .update(clocks)
    .set({ ...mark, nextCheckAt: retryAt })
    .where(and(eq(clocks.id, alert.clock.id), eq(clocks.startedAt, alert.clock.startedAt)));
}
