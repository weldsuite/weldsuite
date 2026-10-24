/**
 * WeldDesk auto-assignment for desk_conversations.
 *
 * A customer message on an open, unowned conversation hands it to a teammate
 * from the workspace's assignment settings (`helpdesk_settings.automation
 * .deskAssignment`). The pick itself is serialised per workspace in the
 * helpdesk-workflow-worker's AssignmentRouter Durable Object (ADR DESK-005),
 * so a burst of new conversations never lands on one person; this file holds
 * the DB side (who may take work, how much they have) and the pick rule the
 * Durable Object runs, so workers only inject how to reach it.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '../schema';
import type { IdGenerator } from './mail-contacts';
import type { DeskAssignmentMode, DeskAssignmentSettings } from '../schema/helpdesk-settings';
import { appendDeskMessage, type DeskConversation, type DeskMessage } from './desk';

export type { DeskAssignmentMode, DeskAssignmentSettings };

type AnyDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export const DEFAULT_DESK_ASSIGNMENT: DeskAssignmentSettings = {
  mode: 'off',
  memberIds: [],
  awayMemberIds: [],
  maxOpenPerMember: null,
};

const MODES = new Set<DeskAssignmentMode>(['off', 'round_robin', 'balanced']);

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((v): v is string => typeof v === 'string' && v.length > 0)));
}

/** Fill gaps in a stored (or partly written) settings blob. */
export function normalizeDeskAssignment(raw: unknown): DeskAssignmentSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof DeskAssignmentSettings, unknown>>;
  const max = value.maxOpenPerMember;
  return {
    mode: MODES.has(value.mode as DeskAssignmentMode) ? (value.mode as DeskAssignmentMode) : 'off',
    memberIds: idList(value.memberIds),
    awayMemberIds: idList(value.awayMemberIds),
    maxOpenPerMember: typeof max === 'number' && Number.isInteger(max) && max > 0 ? max : null,
  };
}

/** The workspace's assignment settings and the helpdesk_settings row they live on. */
export async function getDeskAssignmentSettings(
  db: AnyDb,
): Promise<{ settingsId: string | null; settings: DeskAssignmentSettings }> {
  const [row] = await db
    .select({ id: schema.helpdeskSettings.id, automation: schema.helpdeskSettings.automation })
    .from(schema.helpdeskSettings)
    .where(isNull(schema.helpdeskSettings.deletedAt))
    .limit(1);
  return { settingsId: row?.id ?? null, settings: normalizeDeskAssignment(row?.automation?.deskAssignment) };
}

/**
 * Merge `patch` into the stored settings in one statement, so an admin saving
 * the roster and an agent toggling away at the same moment don't overwrite
 * each other's keys. Creates the settings row when the workspace has none.
 */
export async function saveDeskAssignmentSettings(
  db: AnyDb,
  generateId: IdGenerator,
  patch: Partial<Omit<DeskAssignmentSettings, 'awayMemberIds'>>,
): Promise<DeskAssignmentSettings> {
  const t = schema.helpdeskSettings;
  const { settingsId } = await getDeskAssignmentSettings(db);
  const json = JSON.stringify(patch);
  if (settingsId) {
    await db
      .update(t)
      .set({
        automation: sql`coalesce(${t.automation}, '{}'::jsonb) || jsonb_build_object('deskAssignment', coalesce(${t.automation}->'deskAssignment', '{}'::jsonb) || ${json}::jsonb)`,
        updatedAt: new Date(),
      })
      .where(eq(t.id, settingsId));
  } else {
    const now = new Date();
    await db.insert(t).values({
      id: generateId('hds'),
      automation: { enabled: false, deskAssignment: { ...DEFAULT_DESK_ASSIGNMENT, ...patch } },
      createdAt: now,
      updatedAt: now,
    });
  }
  return (await getDeskAssignmentSettings(db)).settings;
}

/** Mark one teammate away (or back), atomically, without touching the rest. */
export async function setDeskMemberAway(
  db: AnyDb,
  generateId: IdGenerator,
  userId: string,
  away: boolean,
): Promise<DeskAssignmentSettings> {
  const t = schema.helpdeskSettings;
  const { settingsId } = await getDeskAssignmentSettings(db);
  if (!settingsId) {
    if (!away) return DEFAULT_DESK_ASSIGNMENT;
    const now = new Date();
    await db.insert(t).values({
      id: generateId('hds'),
      automation: { enabled: false, deskAssignment: { ...DEFAULT_DESK_ASSIGNMENT, awayMemberIds: [userId] } },
      createdAt: now,
      updatedAt: now,
    });
    return (await getDeskAssignmentSettings(db)).settings;
  }
  const current = sql`coalesce(${t.automation}#>'{deskAssignment,awayMemberIds}', '[]'::jsonb)`;
  const next = away
    ? sql`(SELECT coalesce(jsonb_agg(DISTINCT x), '[]'::jsonb) FROM jsonb_array_elements_text(${current} || to_jsonb(${userId}::text)) AS x)`
    : sql`(SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements_text(${current}) AS x WHERE x <> ${userId})`;
  await db
    .update(t)
    .set({
      automation: sql`coalesce(${t.automation}, '{}'::jsonb) || jsonb_build_object('deskAssignment', coalesce(${t.automation}->'deskAssignment', '{}'::jsonb) || jsonb_build_object('awayMemberIds', ${next}))`,
      updatedAt: new Date(),
    })
    .where(eq(t.id, settingsId));
  return (await getDeskAssignmentSettings(db)).settings;
}

// ---------------------------------------------------------------------------
// The pick
// ---------------------------------------------------------------------------

export interface DeskAssignmentCandidate {
  userId: string;
  /** Open conversations the teammate already has. */
  open: number;
}

export interface DeskPickRequest {
  mode: Exclude<DeskAssignmentMode, 'off'>;
  candidates: DeskAssignmentCandidate[];
  maxOpen: number | null;
}

/** What the AssignmentRouter keeps per workspace between picks. */
export interface DeskPickerState {
  lastUserId: string | null;
  /** Picks whose conversations may not show in `open` counts yet. */
  recent: { userId: string; at: number }[];
}

export const RECENT_PICK_WINDOW_MS = 30_000;

export const EMPTY_DESK_PICKER_STATE: DeskPickerState = { lastUserId: null, recent: [] };

/** Candidates in rotation order: the ones after the last pick first, then wrapping round. */
function rotation(candidates: DeskAssignmentCandidate[], lastUserId: string | null) {
  const sorted = [...candidates].sort((a, b) => a.userId.localeCompare(b.userId));
  if (!lastUserId) return sorted;
  const after = sorted.findIndex((c) => c.userId.localeCompare(lastUserId) > 0);
  return after <= 0 ? sorted : [...sorted.slice(after), ...sorted.slice(0, after)];
}

/**
 * Choose a teammate. Round robin takes the next person in a stable order;
 * balanced takes whoever has the fewest open conversations, ties going round
 * in that same order. Picks from the last 30 s count towards a teammate's
 * load, so two conversations started together don't both see them as idle.
 * Pure: the caller stores the returned state.
 */
export function pickDeskAssignee(
  state: DeskPickerState,
  request: DeskPickRequest,
  now: number = Date.now(),
): { userId: string | null; state: DeskPickerState } {
  const recent = state.recent.filter((r) => now - r.at < RECENT_PICK_WINDOW_MS);
  const load = (userId: string, open: number) => open + recent.filter((r) => r.userId === userId).length;
  const eligible = request.candidates.filter(
    (c) => request.maxOpen === null || load(c.userId, c.open) < request.maxOpen,
  );
  const ordered = rotation(eligible, state.lastUserId);
  let picked = ordered[0];
  if (picked && request.mode === 'balanced') {
    for (const c of ordered) {
      if (load(c.userId, c.open) < load(picked.userId, picked.open)) picked = c;
    }
  }
  if (!picked) return { userId: null, state: { ...state, recent } };
  return {
    userId: picked.userId,
    state: { lastUserId: picked.userId, recent: [...recent, { userId: picked.userId, at: now }] },
  };
}

export type DeskAssigneePicker = (request: DeskPickRequest) => Promise<string | null>;

/** Anything with `fetch`, e.g. a Workers service binding. */
export interface FetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/**
 * Reach the per-workspace AssignmentRouter over the helpdesk-workflow-worker
 * service binding. If the binding is missing or the call fails, fall back to a
 * one-off balanced pick here: no rotation memory, but new conversations still
 * get an owner instead of waiting in Unassigned.
 */
export function deskAssignmentRouterPicker(
  fetcher: FetcherLike | undefined,
  workspaceId: string,
): DeskAssigneePicker {
  const local: DeskAssigneePicker = async (request) =>
    pickDeskAssignee(EMPTY_DESK_PICKER_STATE, { ...request, mode: 'balanced' }).userId;
  if (!fetcher) return local;
  return async (request) => {
    try {
      const res = await fetcher.fetch('https://helpdesk-workflow-worker/desk/assign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...request }),
      });
      if (!res.ok) throw new Error(`assignment router answered ${res.status}`);
      const body = (await res.json()) as { userId?: string | null };
      return body.userId ?? null;
    } catch (err) {
      console.warn('[desk-assignment] router unreachable, picking locally:', err);
      return local(request);
    }
  };
}

/** Teammates who may take a conversation now, with their open counts. */
export async function deskAssignmentCandidates(
  db: AnyDb,
  settings: DeskAssignmentSettings,
): Promise<DeskAssignmentCandidate[]> {
  const away = new Set(settings.awayMemberIds);
  const ids = settings.memberIds.filter((id) => !away.has(id));
  if (ids.length === 0) return [];

  const m = schema.workspaceMembers;
  const active = await db
    .select({ userId: m.userId })
    .from(m)
    .where(
      and(
        inArray(m.userId, ids),
        isNull(m.deletedAt),
        sql`upper(${m.status}) = 'ACTIVE'`,
        sql`upper(${m.memberType}) = 'INTERNAL'`,
      ),
    );
  const userIds = Array.from(new Set(active.map((r) => r.userId)));
  if (userIds.length === 0) return [];

  const c = schema.deskConversations;
  const counts = await db
    .select({ userId: c.assigneeId, open: sql<number>`count(*)` })
    .from(c)
    .where(and(eq(c.state, 'open'), inArray(c.assigneeId, userIds)))
    .groupBy(c.assigneeId);
  const openBy = new Map(counts.map((r) => [r.userId, Number(r.open)]));
  return userIds.map((userId) => ({ userId, open: openBy.get(userId) ?? 0 }));
}

/**
 * Give an open, unowned conversation to a teammate, if the workspace has
 * auto-assignment on and someone can take it. Returns the `assigned` event
 * (author `system`, `metadata.auto`) for the caller to publish, or null when
 * nothing changed. Safe under concurrent customer messages: the owner is
 * claimed with a conditional update before the event is written.
 */
export async function autoAssignDeskConversation(
  db: AnyDb,
  input: { generateId: IdGenerator; conversationId: string; pick: DeskAssigneePicker },
): Promise<{ conversation: DeskConversation; message: DeskMessage } | null> {
  const c = schema.deskConversations;
  const [conversation] = await db
    .select({ id: c.id, state: c.state, assigneeId: c.assigneeId })
    .from(c)
    .where(eq(c.id, input.conversationId))
    .limit(1);
  if (!conversation || conversation.assigneeId || conversation.state !== 'open') return null;

  const { settings } = await getDeskAssignmentSettings(db);
  if (settings.mode === 'off') return null;
  const candidates = await deskAssignmentCandidates(db, settings);
  if (candidates.length === 0) return null;

  const userId = await input.pick({ mode: settings.mode, candidates, maxOpen: settings.maxOpenPerMember });
  if (!userId || !candidates.some((x) => x.userId === userId)) return null;

  const claimed = await db
    .update(c)
    .set({ assigneeId: userId, updatedAt: new Date() })
    .where(and(eq(c.id, input.conversationId), isNull(c.assigneeId)))
    .returning({ id: c.id });
  if (claimed.length === 0) return null;

  return appendDeskMessage(db, {
    generateId: input.generateId,
    conversationId: input.conversationId,
    kind: 'event',
    authorType: 'system',
    metadata: { eventType: 'assigned', assigneeId: userId, auto: true },
    assigneeId: userId,
  });
}
