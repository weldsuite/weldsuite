/**
 * WeldDesk routing rules for desk_conversations.
 *
 * The rules live in `helpdesk_settings.automation.deskRouting.rules`, in
 * order. When a writer opens a conversation (widget, email, phone, portal,
 * API, MCP, agent, workflow), and when an agent or the API changes its type
 * or tags, the first enabled rule whose conditions all hold applies:
 *
 *   - team, priority and tags are written through
 *     updateDeskConversationAttributes (author `system`, the rule's id in
 *     `metadata.routingRuleId`), so the change is on the timeline like any
 *     other and the SLA follows it;
 *   - an assignee is set only on an open conversation nobody owns (a rule
 *     never takes a conversation away from someone), as an `assigned` event;
 *   - a write that set the team itself keeps it (`keepTeam`), and one that
 *     named an owner keeps that (`keepAssignee`).
 *
 * After routing, auto-assignment (./desk-assignment) gives an unowned
 * conversation to the members of its (new) team, or to the roster.
 *
 * Conditions use the SLA engine's comparison (./desk-sla `same`): a value
 * matches case-insensitively. Every list a rule sets must match; `tags`
 * matches when the conversation has any of them. A rule without conditions
 * matches every conversation.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../schema';
import type { IdGenerator } from './mail-contacts';
import type {
  DeskRoutingActions,
  DeskRoutingConditions,
  DeskRoutingRule,
  DeskRoutingSettings,
} from '../schema/helpdesk-settings';
import type { DeskConversation, DeskPriority } from '../schema/desk-conversations';
import type { DeskMessage } from '../schema/desk-messages';
import { appendDeskMessage, normalizeDeskTags, updateDeskConversationAttributes } from './desk';
import { autoAssignDeskConversation, type DeskAssigneePicker } from './desk-assignment';

export type { DeskRoutingActions, DeskRoutingConditions, DeskRoutingRule, DeskRoutingSettings };

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const conversations = schema.deskConversations;

export const DEFAULT_DESK_ROUTING: DeskRoutingSettings = { rules: [] };

const PRIORITIES = new Set<string>(['low', 'medium', 'high', 'urgent']);

// ── Settings ────────────────────────────────────────────────────────────────

/** The non-empty strings, each once, in order. */
function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0)));
}

function optionalId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeConditions(raw: unknown): DeskRoutingConditions {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: DeskRoutingConditions = {};
  for (const key of ['channels', 'ticketTypeIds', 'tags', 'priorities', 'departmentIds'] as const) {
    const list = idList(value[key]);
    if (list.length > 0) out[key] = list;
  }
  return out;
}

function normalizeActions(raw: unknown): DeskRoutingActions {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: DeskRoutingActions = {};
  const departmentId = optionalId(value.departmentId);
  if (departmentId) out.departmentId = departmentId;
  const assigneeId = optionalId(value.assigneeId);
  if (assigneeId) out.assigneeId = assigneeId;
  if (typeof value.priority === 'string' && PRIORITIES.has(value.priority)) {
    out.priority = value.priority as DeskPriority;
  }
  const addTags = idList(value.addTags);
  if (addTags.length > 0) out.addTags = addTags;
  return out;
}

/** Fill gaps in a stored (or partly written) rules blob; a rule without an id is dropped, a repeated id keeps the first. */
export function normalizeDeskRouting(raw: unknown): DeskRoutingSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rules: DeskRoutingRule[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(value.rules) ? value.rules : []) {
    if (!item || typeof item !== 'object') continue;
    const rule = item as Record<string, unknown>;
    const id = optionalId(rule.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rules.push({
      id,
      name: typeof rule.name === 'string' ? rule.name : '',
      enabled: rule.enabled !== false,
      conditions: normalizeConditions(rule.conditions),
      actions: normalizeActions(rule.actions),
    });
  }
  return { rules };
}

/** The workspace's routing rules and the helpdesk_settings row they live on. */
export async function getDeskRoutingSettings(
  db: AnyDb,
): Promise<{ settingsId: string | null; settings: DeskRoutingSettings }> {
  const [row] = await db
    .select({ id: schema.helpdeskSettings.id, automation: schema.helpdeskSettings.automation })
    .from(schema.helpdeskSettings)
    .where(isNull(schema.helpdeskSettings.deletedAt))
    .limit(1);
  return { settingsId: row?.id ?? null, settings: normalizeDeskRouting(row?.automation?.deskRouting) };
}

/**
 * Replace the rules in one statement, leaving the rest of `automation`
 * (auto-assignment, the legacy keys) as it is. Creates the settings row when
 * the workspace has none.
 */
export async function saveDeskRoutingSettings(
  db: AnyDb,
  generateId: IdGenerator,
  settings: DeskRoutingSettings,
): Promise<DeskRoutingSettings> {
  const t = schema.helpdeskSettings;
  const normalized = normalizeDeskRouting(settings);
  const { settingsId } = await getDeskRoutingSettings(db);
  if (settingsId) {
    await db
      .update(t)
      .set({
        automation: sql`coalesce(${t.automation}, '{}'::jsonb) || jsonb_build_object('deskRouting', ${JSON.stringify(normalized)}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(t.id, settingsId));
  } else {
    const now = new Date();
    await db.insert(t).values({
      id: generateId('hds'),
      automation: { enabled: false, deskRouting: normalized },
      createdAt: now,
      updatedAt: now,
    });
  }
  return (await getDeskRoutingSettings(db)).settings;
}

// ── Matching ────────────────────────────────────────────────────────────────

export type DeskRoutingFields = Pick<DeskConversation, 'channel' | 'ticketTypeId' | 'tags' | 'priority' | 'departmentId'>;

/** The SLA engine's comparison: both empty, or the same text ignoring case. */
function same(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** An unset or empty list holds; otherwise it must name the value. */
function listHolds(list: string[] | undefined, value: string | null | undefined): boolean {
  if (!list || list.length === 0) return true;
  return value != null && list.some((v) => same(v, value));
}

export function deskRoutingRuleMatches(rule: DeskRoutingRule, conversation: DeskRoutingFields): boolean {
  const c = rule.conditions;
  const tags = conversation.tags ?? [];
  const tagsHold = !c.tags || c.tags.length === 0 || tags.some((tag) => c.tags!.some((v) => same(v, tag)));
  return (
    listHolds(c.channels, conversation.channel) &&
    listHolds(c.ticketTypeIds, conversation.ticketTypeId) &&
    listHolds(c.priorities, conversation.priority) &&
    listHolds(c.departmentIds, conversation.departmentId) &&
    tagsHold
  );
}

/** The first enabled rule whose conditions all hold, or null. */
export function selectDeskRoutingRule(
  rules: DeskRoutingRule[],
  conversation: DeskRoutingFields,
): DeskRoutingRule | null {
  return rules.find((rule) => rule.enabled && deskRoutingRuleMatches(rule, conversation)) ?? null;
}

// ── Applying a rule ─────────────────────────────────────────────────────────

export interface DeskRoutingStep {
  /** The conversation after this step. */
  conversation: DeskConversation;
  /** The timeline event it wrote. */
  message: DeskMessage;
  /** The entity-event action: `updated` for ticket fields, `assigned` for an owner. */
  action: 'updated' | 'assigned';
}

export interface DeskRoutingResult {
  conversation: DeskConversation;
  /** Timeline events written, oldest first. */
  steps: DeskRoutingStep[];
  /** The rule that applied, or null. */
  ruleId: string | null;
  /** The earliest SLA check the steps returned (copy it into the due index). */
  slaCheckAt: Date | null;
}

export interface RouteDeskConversationInput {
  generateId: IdGenerator;
  conversationId: string;
  /** The write that triggered routing set the team itself: a rule never overrides it. */
  keepTeam?: boolean;
  /** The writer named an owner: a rule never hands the conversation to someone else. */
  keepAssignee?: boolean;
  /**
   * Set when an edit of the type or tags triggered routing. The rule that
   * applied last on this conversation is not applied again (so an agent's
   * own edits since then stay), and a tag the edit removed is never put back.
   */
  change?: DeskRoutingChange;
}

/** What the `attributes_changed` edit behind a `changed` trigger did. */
export interface DeskRoutingChange {
  /** Tags the edit removed (any case). */
  removedTags: string[];
}

/** The rule that last applied on the conversation (its latest `routingRuleId` on the timeline). */
async function lastRoutingRuleId(db: AnyDb, conversationId: string): Promise<string | null> {
  const m = schema.deskMessages;
  const [row] = await db
    .select({ ruleId: sql<string | null>`${m.metadata}->>'routingRuleId'` })
    .from(m)
    .where(and(eq(m.conversationId, conversationId), sql`${m.metadata} ? 'routingRuleId'`))
    .orderBy(sql`${m.createdAt} desc`, sql`${m.id} desc`)
    .limit(1);
  return row?.ruleId ?? null;
}

function earliest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

/** A team a rule may put a conversation in: it exists and is active. */
async function usableTeam(db: AnyDb, id: string): Promise<boolean> {
  const d = schema.helpdeskDepartments;
  const [row] = await db
    .select({ id: d.id })
    .from(d)
    .where(and(eq(d.id, id), isNull(d.deletedAt), eq(d.isActive, true)))
    .limit(1);
  return Boolean(row);
}

/** A teammate a rule may hand a conversation to: an active internal member. */
async function usableAssignee(db: AnyDb, userId: string): Promise<boolean> {
  const m = schema.workspaceMembers;
  const [row] = await db
    .select({ userId: m.userId })
    .from(m)
    .where(
      and(
        eq(m.userId, userId),
        isNull(m.deletedAt),
        sql`upper(${m.status}) = 'ACTIVE'`,
        sql`upper(${m.memberType}) = 'INTERNAL'`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * The ticket fields a rule's actions change on `current`: the team (unless
 * the write set it itself, or the team is gone or inactive), the priority,
 * and the tags with the rule's added. Empty when the rule changes nothing.
 */
async function routingAttributePatch(
  db: AnyDb,
  actions: DeskRoutingRule['actions'],
  current: DeskConversation,
  keepTeam: boolean,
  removedTags: string[],
): Promise<{ departmentId?: string; priority?: DeskPriority; tags?: string[] }> {
  const patch: { departmentId?: string; priority?: DeskPriority; tags?: string[] } = {};
  const team = actions.departmentId;
  if (team && !keepTeam && team !== current.departmentId && (await usableTeam(db, team))) {
    patch.departmentId = team;
  }
  if (actions.priority && actions.priority !== current.priority) patch.priority = actions.priority;
  const removed = new Set(removedTags.map((tag) => tag.toLowerCase()));
  const added = (actions.addTags ?? []).filter((tag) => !removed.has(tag.toLowerCase()));
  if (added.length > 0) {
    const before = current.tags ?? [];
    const tags = normalizeDeskTags([...before, ...added]);
    if (tags.length !== before.length || tags.some((tag, i) => tag !== before[i])) patch.tags = tags;
  }
  return patch;
}

/**
 * Apply the first matching routing rule to a conversation. Writes nothing
 * when no rule matches or the rule changes nothing; a rule naming a team that
 * is gone or inactive, or a teammate who left, skips that action.
 */
export async function routeDeskConversation(
  db: AnyDb,
  input: RouteDeskConversationInput,
): Promise<DeskRoutingResult> {
  const [current] = await db.select().from(conversations).where(eq(conversations.id, input.conversationId)).limit(1);
  if (!current) throw new Error(`Desk conversation '${input.conversationId}' not found`);
  const none: DeskRoutingResult = { conversation: current, steps: [], ruleId: null, slaCheckAt: null };

  const { settings } = await getDeskRoutingSettings(db);
  const rule = selectDeskRoutingRule(settings.rules, current);
  if (!rule) return none;
  // An edit re-routes only to a rule other than the one that placed the
  // conversation; re-running that one would undo the agent's own changes.
  if (input.change && (await lastRoutingRuleId(db, current.id)) === rule.id) return none;

  const { actions } = rule;
  const steps: DeskRoutingStep[] = [];
  let conversation = current;
  let slaCheckAt: Date | null = null;

  const patch = await routingAttributePatch(
    db,
    actions,
    current,
    input.keepTeam === true,
    input.change?.removedTags ?? [],
  );
  if (Object.keys(patch).length > 0) {
    const set = await updateDeskConversationAttributes(db, {
      generateId: input.generateId,
      conversationId: current.id,
      authorType: 'system',
      authorId: null,
      ...patch,
      metadata: { routingRuleId: rule.id },
    });
    conversation = set.conversation;
    slaCheckAt = earliest(slaCheckAt, set.slaCheckAt);
    if (set.message) steps.push({ conversation, message: set.message, action: 'updated' });
  }

  const assigneeId = actions.assigneeId;
  if (
    assigneeId &&
    !input.keepAssignee &&
    conversation.state === 'open' &&
    !conversation.assigneeId &&
    (await usableAssignee(db, assigneeId))
  ) {
    const claimed = await db
      .update(conversations)
      .set({ assigneeId, updatedAt: new Date() })
      .where(and(eq(conversations.id, current.id), isNull(conversations.assigneeId)))
      .returning({ id: conversations.id });
    if (claimed.length > 0) {
      const assigned = await appendDeskMessage(db, {
        generateId: input.generateId,
        conversationId: current.id,
        kind: 'event',
        authorType: 'system',
        metadata: { eventType: 'assigned', assigneeId, routingRuleId: rule.id },
        assigneeId,
      });
      conversation = assigned.conversation;
      slaCheckAt = earliest(slaCheckAt, assigned.slaCheckAt);
      steps.push({ conversation, message: assigned.message, action: 'assigned' });
    }
  }

  return { conversation, steps, ruleId: steps.length > 0 ? rule.id : null, slaCheckAt };
}

/**
 * `opened`: a writer just opened the conversation. `changed`: its type or
 * tags changed (auto-assignment then runs only when a rule applied, so an
 * agent's edit never hands out a conversation by itself).
 */
export type DeskRoutingTrigger = 'opened' | 'changed';

/**
 * Route a conversation, then auto-assign it (team-aware) when nobody owns it.
 * Every step's event is in `steps`, in order, for the caller to publish.
 */
export async function routeAndAssignDeskConversation(
  db: AnyDb,
  input: RouteDeskConversationInput & { pick: DeskAssigneePicker; trigger: DeskRoutingTrigger },
): Promise<DeskRoutingResult> {
  const routed = await routeDeskConversation(db, input);
  if (input.keepAssignee || (input.trigger === 'changed' && routed.steps.length === 0)) return routed;
  const assigned = await autoAssignDeskConversation(db, {
    generateId: input.generateId,
    conversationId: input.conversationId,
    pick: input.pick,
  });
  if (!assigned) return routed;
  return {
    conversation: assigned.conversation,
    steps: [...routed.steps, { conversation: assigned.conversation, message: assigned.message, action: 'assigned' }],
    ruleId: routed.ruleId,
    slaCheckAt: earliest(routed.slaCheckAt, assigned.slaCheckAt),
  };
}

/** Did an `attributes_changed` event change what routing matches on (type or tags), without setting the team? */
export function deskChangeReroutes(
  changes: Array<{ field: string; from?: unknown; to?: unknown }> | null | undefined,
): { reroute: boolean; keepTeam: boolean; change: DeskRoutingChange } {
  const list = changes ?? [];
  const fields = new Set(list.map((c) => c.field));
  const tagChange = list.find((c) => c.field === 'tags');
  const asTags = (value: unknown) => (Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : []);
  const after = new Set(asTags(tagChange?.to).map((tag) => tag.toLowerCase()));
  const removedTags = asTags(tagChange?.from).filter((tag) => !after.has(tag.toLowerCase()));
  return {
    reroute: fields.has('ticketType') || fields.has('tags'),
    keepTeam: fields.has('team'),
    change: { removedTags },
  };
}
