/**
 * Ringing agents' browsers for a waiting WeldDesk phone call.
 *
 * A round dials every ringable member (up to 10) on their own softphone
 * credential: `sip:<sipUsername>@sip.telnyx.com` on the voice connection, one
 * `desk_phone_call_legs` row per dialled leg. The legs carry a `client_state`
 * of `{ workspaceId, agentLegId, parentCallId }` (no `callId`), so the call's
 * own webhook dispatch never mistakes an agent leg for the call.
 */

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { deskTeamMemberIds, getDeskAssignmentSettings } from '@weldsuite/db/lib/desk-assignment';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { encodeClientState, telnyxDial, telnyxHangup, type TelnyxEnv } from '../lib/telnyx';
import {
  onlineUserIds,
  publishPhoneQueueChange,
  sendPhoneInboxEvent,
  waitingCallsCondition,
  type PhoneEndedReason,
  type PhoneIncomingEvent,
} from '../lib/desk-phone-realtime';
import { loadRouteForNumber, resolveRouteOptions } from '../lib/desk-phone-options';
import { matchCallerByPhone } from './desk-phone-crm';

export type VoipCallRow = typeof schema.voipCalls.$inferSelect;

export interface PhoneCtx {
  env: TelnyxEnv;
  db: Database;
  /** The Clerk org id: what client_state, realtime and the tenant lookup key on. */
  workspaceId: string;
}

export const SIP_DOMAIN = 'sip.telnyx.com';
/** A leg that rang less than this and hung up does not start another round (a broken credential must not spin a dial loop). */
export const MIN_RING_MS_FOR_NEXT_ROUND = 10_000;
export const MAX_LEGS_PER_CALL = 40;
export const MAX_LEGS_PER_ROUND = 10;
/** How far back an unfinished call or leg still makes a member busy. */
const BUSY_WINDOW_MS = 4 * 60 * 60 * 1000;

export function sipAddress(sipUsername: string): string {
  return `sip:${sipUsername}@${SIP_DOMAIN}`;
}

export interface StaffedAgent {
  userId: string;
  sipUsername: string;
}

/**
 * Members who could take a call of this team before presence and busy are
 * looked at: `available`, with a credential, an active internal member, not
 * marked away, and in the team when the team has members.
 */
export async function staffedAgents(db: Database, departmentId: string | null): Promise<StaffedAgent[]> {
  const a = schema.deskPhoneAgents;
  const rows = await db
    .select({ userId: a.userId, sipUsername: a.sipUsername })
    .from(a)
    .where(and(eq(a.available, true), isNotNull(a.sipUsername)));
  const withSip = rows.flatMap((r) => (r.sipUsername ? [{ userId: r.userId, sipUsername: r.sipUsername }] : []));
  if (withSip.length === 0) return [];

  const { settings } = await getDeskAssignmentSettings(db);
  const away = new Set(settings.awayMemberIds);
  const team = await deskTeamMemberIds(db, departmentId);
  const teamSet = team ? new Set(team) : null;
  const wanted = withSip.filter((r) => !away.has(r.userId) && (!teamSet || teamSet.has(r.userId)));
  if (wanted.length === 0) return [];

  const m = schema.workspaceMembers;
  const active = await db
    .select({ userId: m.userId })
    .from(m)
    .where(
      and(
        inArray(
          m.userId,
          wanted.map((r) => r.userId),
        ),
        isNull(m.deletedAt),
        sql`upper(${m.status}) = 'ACTIVE'`,
        sql`upper(${m.memberType}) = 'INTERNAL'`,
      ),
    );
  const activeIds = new Set(active.map((r) => r.userId));
  return wanted.filter((r) => activeIds.has(r.userId));
}

/**
 * Members already on a call: a leg of theirs ringing or answered, or an
 * unfinished call of theirs started in the last 4 hours (a caller still
 * waiting for an agent is not "theirs" yet, whoever the number is assigned to).
 */
export async function busyUserIds(db: Database, userIds: string[], exceptCallIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const cutoff = new Date(Date.now() - BUSY_WINDOW_MS);
  const l = schema.deskPhoneCallLegs;
  const c = schema.voipCalls;
  const legs = await db
    .select({ userId: l.userId })
    .from(l)
    .where(and(inArray(l.userId, userIds), inArray(l.status, ['ringing', 'answered']), gt(l.createdAt, cutoff)));
  const calls = await db
    .select({ userId: c.userId })
    .from(c)
    .where(
      and(
        inArray(c.userId, userIds),
        isNull(c.endedAt),
        gt(c.initiatedAt, cutoff),
        exceptCallIds.length > 0 ? notInArray(c.id, exceptCallIds) : undefined,
        or(isNull(c.queueEnteredAt), isNotNull(c.agentAnsweredAt)),
      ),
    );
  return new Set([...legs.map((r) => r.userId), ...calls.map((r) => r.userId)]);
}

/** Longest idle first (never answered a call counts as longest), then by user id. */
async function byIdleTime(db: Database, agents: StaffedAgent[]): Promise<StaffedAgent[]> {
  if (agents.length <= 1) return agents;
  const c = schema.voipCalls;
  const rows = await db
    .select({ userId: c.answeredByUserId, last: sql<string | Date | null>`max(${c.agentAnsweredAt})` })
    .from(c)
    .where(
      inArray(
        c.answeredByUserId,
        agents.map((a) => a.userId),
      ),
    )
    .groupBy(c.answeredByUserId);
  const last = new Map(rows.map((r) => [r.userId, r.last ? new Date(r.last).getTime() : 0]));
  return [...agents].sort(
    (x, y) => (last.get(x.userId) ?? 0) - (last.get(y.userId) ?? 0) || x.userId.localeCompare(y.userId),
  );
}

/** The caller as the rung members see them. */
export async function describeCaller(
  db: Database,
  call: Pick<VoipCallRow, 'fromNumber' | 'deskConversationId'>,
): Promise<{ callerName: string | null; customerName: string | null }> {
  let callerName: string | null = null;
  let customerName: string | null = null;
  if (call.deskConversationId) {
    const [conversation] = await db
      .select({ name: schema.deskConversations.name })
      .from(schema.deskConversations)
      .where(eq(schema.deskConversations.id, call.deskConversationId))
      .limit(1);
    callerName = conversationCallerName(conversation?.name, call.fromNumber);
  }
  try {
    const match = await matchCallerByPhone(db, call.fromNumber);
    callerName = match.callerName ?? callerName;
    customerName = match.customerName;
  } catch (err) {
    console.error('[desk-phone] CRM caller match failed:', err);
  }
  return { callerName, customerName };
}

/** The conversation's name when it is a name, not just the number. */
export function conversationCallerName(name: string | null | undefined, fromNumber: string): string | null {
  const trimmed = name?.trim();
  return trimmed && trimmed !== fromNumber ? trimmed : null;
}

async function incomingEvent(ctx: PhoneCtx, call: VoipCallRow): Promise<PhoneIncomingEvent> {
  const who = await describeCaller(ctx.db, call);
  return {
    callId: call.id,
    conversationId: call.deskConversationId,
    fromNumber: call.fromNumber,
    callerName: who.callerName,
    customerName: who.customerName,
    departmentId: call.departmentId,
    waitingSince: (call.queueEnteredAt ?? call.initiatedAt).toISOString(),
  };
}

/** Mark a leg ended; true when this call did it (a duplicate or a later event finds it ended already). */
export async function endLeg(db: Database, legId: string): Promise<boolean> {
  const l = schema.deskPhoneCallLegs;
  const claimed = await db
    .update(l)
    .set({ status: 'ended', endedAt: new Date() })
    .where(and(eq(l.id, legId), ne(l.status, 'ended')))
    .returning({ id: l.id });
  return claimed.length > 0;
}

/** Hang up a Telnyx leg; a leg that is already gone is not an error. */
export async function hangupBestEffort(env: TelnyxEnv, callControlId: string | null | undefined): Promise<void> {
  if (!callControlId) return;
  try {
    await telnyxHangup(env, callControlId);
  } catch (err) {
    console.warn(`[desk-phone] hangup of ${callControlId} failed (call probably gone):`, err);
  }
}

async function ringLeg(
  ctx: PhoneCtx,
  call: VoipCallRow,
  agent: StaffedAgent,
  ringSeconds: number,
  incoming: PhoneIncomingEvent,
): Promise<boolean> {
  const { env, db, workspaceId } = ctx;
  const legId = generateId('dleg');
  await db.insert(schema.deskPhoneCallLegs).values({ id: legId, callId: call.id, userId: agent.userId, status: 'ringing' });

  const connectionId = env.TELNYX_CONNECTION_ID;
  if (!connectionId) {
    console.error('[desk-phone] TELNYX_CONNECTION_ID is not set, cannot ring agents');
    await endLeg(db, legId);
    return false;
  }
  try {
    const dialed = await telnyxDial(env, {
      connectionId,
      to: sipAddress(agent.sipUsername),
      from: call.fromNumber,
      timeoutSecs: ringSeconds,
      clientState: encodeClientState({ workspaceId, agentLegId: legId, parentCallId: call.id }),
    });
    if (dialed.callControlId) {
      const l = schema.deskPhoneCallLegs;
      await db
        .update(l)
        .set({ providerCallId: dialed.callControlId })
        .where(and(eq(l.id, legId), isNull(l.providerCallId)));
    }
  } catch (err) {
    console.error(`[desk-phone] dial of ${agent.userId} failed:`, err);
    await endLeg(db, legId);
    return false;
  }
  await sendPhoneInboxEvent(env, workspaceId, agent.userId, 'phone.incoming', { ...incoming });
  return true;
}

export interface RingResult {
  /** Members who could take the call before presence and busy (0 = nobody is staffed). */
  staffed: number;
  /** Legs dialled this round. */
  rung: number;
}

/** One round: ring every staffed member who is online and free (at most 10, longest idle first). */
export async function ringAgents(
  ctx: PhoneCtx,
  call: VoipCallRow,
  input: { ringSeconds: number; /** Calls that just ended and must not make their members busy. */ ignoreCallIds?: string[] },
): Promise<RingResult> {
  const { env, db, workspaceId } = ctx;
  const staffed = await staffedAgents(db, call.departmentId);
  if (staffed.length === 0) return { staffed: 0, rung: 0 };

  const online = await onlineUserIds(
    env,
    workspaceId,
    staffed.map((a) => a.userId),
  );
  const onlineAgents = staffed.filter((a) => online.has(a.userId));
  const busy = await busyUserIds(
    db,
    onlineAgents.map((a) => a.userId),
    [call.id, ...(input.ignoreCallIds ?? [])],
  );
  const free = onlineAgents.filter((a) => !busy.has(a.userId));

  const [legCount] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.deskPhoneCallLegs)
    .where(eq(schema.deskPhoneCallLegs.callId, call.id));
  const room = Math.max(0, MAX_LEGS_PER_CALL - Number(legCount?.n ?? 0));
  const chosen = (await byIdleTime(db, free)).slice(0, Math.min(MAX_LEGS_PER_ROUND, room));
  if (chosen.length === 0) return { staffed: staffed.length, rung: 0 };

  const incoming = await incomingEvent(ctx, call);
  const results = await Promise.all(chosen.map((a) => ringLeg(ctx, call, a, input.ringSeconds, incoming)));
  return { staffed: staffed.length, rung: results.filter(Boolean).length };
}

/** Ring one member for a call (queue pickup): no presence or busy filter, the member asked. */
export async function ringMember(
  ctx: PhoneCtx,
  call: VoipCallRow,
  agent: StaffedAgent,
  ringSeconds: number,
): Promise<'ringing' | 'already' | 'failed'> {
  const l = schema.deskPhoneCallLegs;
  const [existing] = await ctx.db
    .select({ id: l.id })
    .from(l)
    .where(and(eq(l.callId, call.id), eq(l.userId, agent.userId), eq(l.status, 'ringing')))
    .limit(1);
  if (existing) return 'already';
  const incoming = await incomingEvent(ctx, call);
  return (await ringLeg(ctx, call, agent, ringSeconds, incoming)) ? 'ringing' : 'failed';
}

/**
 * End every leg of the call that is still ringing (optionally all but one):
 * each is marked ended first, then hung up, so the leg's own `call.hangup`
 * finds it ended and starts nothing. Returns the members whose leg it was.
 */
export async function endRingingLegs(
  ctx: PhoneCtx,
  callId: string,
  exceptLegId?: string,
): Promise<Array<{ userId: string }>> {
  const l = schema.deskPhoneCallLegs;
  const legs = await ctx.db
    .select({ id: l.id, userId: l.userId, providerCallId: l.providerCallId })
    .from(l)
    .where(exceptLegId ? and(eq(l.callId, callId), eq(l.status, 'ringing'), ne(l.id, exceptLegId)) : and(eq(l.callId, callId), eq(l.status, 'ringing')));
  const ended: Array<{ userId: string }> = [];
  const hangups: Array<Promise<void>> = [];
  for (const leg of legs) {
    if (!(await endLeg(ctx.db, leg.id))) continue;
    ended.push({ userId: leg.userId });
    hangups.push(hangupBestEffort(ctx.env, leg.providerCallId));
  }
  await Promise.all(hangups);
  return ended;
}

/** Tell the members whose browsers were ringing that it stopped. */
export async function notifyPhoneEnded(
  ctx: PhoneCtx,
  callId: string,
  members: Array<{ userId: string }>,
  reason: PhoneEndedReason,
): Promise<void> {
  const unique = [...new Set(members.map((m) => m.userId))];
  await Promise.all(
    unique.map((userId) => sendPhoneInboxEvent(ctx.env, ctx.workspaceId, userId, 'phone.ended', { callId, reason })),
  );
}

/**
 * An agent became free (finished a call, switched "take calls" on, or a
 * round for another call ended): ring a round for the oldest waiting call that
 * has no leg ringing. One call per trigger. A call whose newest leg ended less
 * than 10 s after it was dialled is skipped (instantly failing credentials must
 * not spin), and a call nobody can be rung for is left alone. Best-effort.
 */
export async function ringWaitingCalls(ctx: PhoneCtx, opts: { finishedCallId?: string } = {}): Promise<void> {
  try {
    const { db } = ctx;
    const c = schema.voipCalls;
    const l = schema.deskPhoneCallLegs;
    const calls = await db.select().from(c).where(waitingCallsCondition()).orderBy(asc(c.queueEnteredAt), asc(c.id)).limit(10);
    for (const call of calls) {
      if (!call.providerCallId) continue;
      const [ringing] = await db
        .select({ n: sql<number>`count(*)` })
        .from(l)
        .where(and(eq(l.callId, call.id), eq(l.status, 'ringing')));
      if (Number(ringing?.n ?? 0) > 0) continue;
      const [newest] = await db
        .select({ createdAt: l.createdAt, endedAt: l.endedAt })
        .from(l)
        .where(eq(l.callId, call.id))
        .orderBy(desc(l.createdAt))
        .limit(1);
      if (newest?.endedAt && newest.endedAt.getTime() - newest.createdAt.getTime() < MIN_RING_MS_FOR_NEXT_ROUND) continue;
      const options = resolveRouteOptions(await loadRouteForNumber(db, call.toNumber));
      const result = await ringAgents(ctx, call, {
        ringSeconds: options.ringSeconds,
        ignoreCallIds: opts.finishedCallId ? [opts.finishedCallId] : [],
      });
      if (result.rung > 0) return;
    }
  } catch (err) {
    console.error('[desk-phone] ringing waiting calls failed:', err);
  }
}

/** The row-level twin of `waitingCallsCondition`: queued, no agent yet, not ended, no outcome. */
export function isWaitingCall(call: VoipCallRow): boolean {
  return Boolean(call.queueEnteredAt) && !call.agentAnsweredAt && !call.endedAt && !call.outcome;
}

/** The call, when it is still waiting for an agent. */
export async function loadWaitingCall(db: Database, callId: string): Promise<VoipCallRow | null> {
  const [call] = await db
    .select()
    .from(schema.voipCalls)
    .where(and(eq(schema.voipCalls.id, callId), waitingCallsCondition()))
    .limit(1);
  return call ?? null;
}

export async function loadCall(db: Database, callId: string): Promise<VoipCallRow | null> {
  const [call] = await db.select().from(schema.voipCalls).where(eq(schema.voipCalls.id, callId)).limit(1);
  return call ?? null;
}

export { publishPhoneQueueChange };
