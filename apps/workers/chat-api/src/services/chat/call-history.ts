/**
 * WeldChat call history: a member's phone-style "recents" list, served by
 * `GET /api/chat-calls/history`.
 *
 * Which calls are theirs:
 * - every call in a DM or group DM they belong to. Those calls ring every
 *   member, so one they never picked up is a missed call for them;
 * - calls in any other channel that they started or joined. A channel call
 *   rings nobody, so one they never took part in is not in their history.
 *
 * Direction and outcome are per viewer, see {@link callOutcomeFor}.
 */

import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { ChatCallParticipant } from '@weldsuite/db/schema/chat-calls';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { wasAnswered } from '@weldsuite/chat-domain/call-lifecycle';

export type CallDirection = 'incoming' | 'outgoing';

/**
 * - `ongoing`: still ringing or live.
 * - `answered`: the viewer was in the call (or, for their own call, somebody picked up).
 * - `missed`: it rang the viewer and they never joined; for the viewer's own
 *   call, nobody picked up (clients word that one "No answer").
 * - `declined`: the viewer declined it, or (their own call) the person it rang did.
 */
export type CallOutcome = 'ongoing' | 'answered' | 'missed' | 'declined';

export interface CallPerson {
  userId: string;
  name: string | null;
  avatar: string | null;
}

export interface CallOutcomeInput {
  status: string;
  initiatorId: string;
  participants?: ChatCallParticipant[] | null;
  metadata?: Record<string, unknown> | null;
}

export function callDirection(call: { initiatorId: string }, viewerId: string): CallDirection {
  return call.initiatorId === viewerId ? 'outgoing' : 'incoming';
}

/** Who declined the call. Recorded by `declineRingingCall`; null on calls declined before it was. */
export function callDeclinedBy(call: { metadata?: Record<string, unknown> | null }): string | null {
  const by = call.metadata?.declinedBy;
  return typeof by === 'string' && by ? by : null;
}

function viewerJoined(call: CallOutcomeInput, viewerId: string): boolean {
  return (call.participants ?? []).some((p) => p.userId === viewerId && !!p.joinedAt);
}

/** How the call went for `viewerId`. */
export function callOutcomeFor(call: CallOutcomeInput, viewerId: string): CallOutcome {
  if (call.status === 'ringing' || call.status === 'active') return 'ongoing';

  if (call.initiatorId === viewerId) {
    if (call.status === 'declined') return 'declined';
    // The participant list, not the status: a call ended twice can read `ended`
    // although nobody ever picked up.
    return wasAnswered(call) ? 'answered' : 'missed';
  }

  // Incoming. Someone else in a group answering does not make it answered for this viewer.
  if (viewerJoined(call, viewerId)) return 'answered';
  if (call.status === 'declined') {
    // Another member of a group DM declined: for this viewer it just stopped ringing.
    const by = callDeclinedBy(call);
    return by && by !== viewerId ? 'missed' : 'declined';
  }
  return 'missed';
}

/**
 * The person a DM call row shows: whoever called for an incoming call, the
 * member called for an outgoing one (the first other member in a group DM).
 * Null for a channel call, which shows the channel instead.
 */
export function callCounterpart(
  call: { initiatorId: string; initiatorName: string },
  viewerId: string,
  channelType: string | null,
  otherMembers: CallPerson[],
  people: ReadonlyMap<string, { name: string | null; picture: string | null }>,
): CallPerson | null {
  if (channelType !== 'dm') return null;
  if (call.initiatorId !== viewerId) {
    const info = people.get(call.initiatorId);
    return {
      userId: call.initiatorId,
      name: info?.name ?? call.initiatorName,
      avatar: info?.picture ?? null,
    };
  }
  return otherMembers[0] ?? null;
}

export interface CallHistoryItem {
  id: string;
  channelId: string;
  channelType: string | null;
  channelName: string | null;
  callType: string;
  status: string;
  direction: CallDirection;
  outcome: CallOutcome;
  initiatorId: string;
  initiatorName: string;
  /** DM calls: the person to show (see {@link callCounterpart}); null for channel calls. */
  counterpart: CallPerson | null;
  /** DM calls: every member but the viewer (more than one in a group DM); empty for channel calls. */
  otherMembers: CallPerson[];
  startedAt: Date | null;
  endedAt: Date | null;
  /** Seconds, set when the call ended; null for declined and ongoing calls. */
  duration: number | null;
  createdAt: Date;
}

export interface CallHistoryPage {
  items: CallHistoryItem[];
  totalCount: number;
  hasMore: boolean;
  /** The last row's id; pass it back as `cursor` for the next page. */
  cursor: string | null;
}

export const CALL_HISTORY_DEFAULT_LIMIT = 30;
export const CALL_HISTORY_MAX_LIMIT = 100;

/** The calls that belong in `viewerId`'s history (see the file header). */
function visibleTo(viewerId: string): SQL {
  const { chatCalls, chatChannels, chatChannelMembers } = schema;
  const myChannels = sql`(SELECT m.channel_id FROM ${chatChannelMembers} m WHERE m.user_id = ${viewerId})`;
  return and(
    isNull(chatChannels.deletedAt),
    or(
      and(eq(chatChannels.type, 'dm'), sql`${chatCalls.channelId} IN ${myChannels}`),
      eq(chatCalls.initiatorId, viewerId),
      sql`${chatCalls.participants} @> ${JSON.stringify([{ userId: viewerId }])}::jsonb`,
    ),
  ) as SQL;
}

/** Group a page's DM members by channel, plus a name/avatar lookup by user. */
async function loadDmPeople(
  db: Database,
  viewerId: string,
  dmChannelIds: string[],
  initiatorIds: string[],
) {
  const { chatChannelMembers, workspaceMembers } = schema;
  const membersByChannel = new Map<string, CallPerson[]>();
  const people = new Map<string, { name: string | null; picture: string | null }>();
  if (dmChannelIds.length === 0) return { membersByChannel, people };

  const rows = await db
    .select({
      channelId: chatChannelMembers.channelId,
      userId: chatChannelMembers.userId,
      name: workspaceMembers.name,
      picture: workspaceMembers.picture,
    })
    .from(chatChannelMembers)
    .leftJoin(workspaceMembers, eq(workspaceMembers.userId, chatChannelMembers.userId))
    .where(and(inArray(chatChannelMembers.channelId, dmChannelIds), ne(chatChannelMembers.userId, viewerId)));

  for (const row of rows) {
    people.set(row.userId, { name: row.name ?? null, picture: row.picture ?? null });
    const list = membersByChannel.get(row.channelId) ?? [];
    if (!list.some((m) => m.userId === row.userId)) {
      list.push({ userId: row.userId, name: row.name ?? null, avatar: row.picture ?? null });
    }
    membersByChannel.set(row.channelId, list);
  }
  for (const list of membersByChannel.values()) {
    list.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.userId.localeCompare(b.userId));
  }

  // A caller who has since left the DM still gets their own name and avatar.
  const missing = [...new Set(initiatorIds)].filter((id) => id !== viewerId && !people.has(id));
  if (missing.length > 0) {
    const extra = await db
      .select({ userId: workspaceMembers.userId, name: workspaceMembers.name, picture: workspaceMembers.picture })
      .from(workspaceMembers)
      .where(inArray(workspaceMembers.userId, missing));
    for (const row of extra) people.set(row.userId, { name: row.name ?? null, picture: row.picture ?? null });
  }

  return { membersByChannel, people };
}

/**
 * One page of `viewerId`'s call history, newest first. `cursor` is the id of
 * the last call of the previous page; an unknown cursor yields an empty page.
 */
export async function listCallHistory(
  db: Database,
  viewerId: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<CallHistoryPage> {
  const { chatCalls, chatChannels } = schema;
  const limit = Math.min(Math.max(opts.limit ?? CALL_HISTORY_DEFAULT_LIMIT, 1), CALL_HISTORY_MAX_LIMIT);

  const visible = visibleTo(viewerId);
  const pageWhere = opts.cursor
    ? and(
        visible,
        // Compared in SQL against the cursor row itself, so timestamps keep their full precision.
        sql`(${chatCalls.createdAt}, ${chatCalls.id}) < (SELECT cur.created_at, cur.id FROM ${chatCalls} cur WHERE cur.id = ${opts.cursor})`,
      )
    : visible;

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: chatCalls.id,
        channelId: chatCalls.channelId,
        callType: chatCalls.callType,
        status: chatCalls.status,
        initiatorId: chatCalls.initiatorId,
        initiatorName: chatCalls.initiatorName,
        participants: chatCalls.participants,
        metadata: chatCalls.metadata,
        startedAt: chatCalls.startedAt,
        endedAt: chatCalls.endedAt,
        duration: chatCalls.duration,
        createdAt: chatCalls.createdAt,
        channelType: chatChannels.type,
        channelName: chatChannels.name,
      })
      .from(chatCalls)
      .innerJoin(chatChannels, eq(chatChannels.id, chatCalls.channelId))
      .where(pageWhere)
      .orderBy(desc(chatCalls.createdAt), desc(chatCalls.id))
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)` })
      .from(chatCalls)
      .innerJoin(chatChannels, eq(chatChannels.id, chatCalls.channelId))
      .where(visible),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const dmRows = page.filter((r) => r.channelType === 'dm');
  const { membersByChannel, people } = await loadDmPeople(
    db,
    viewerId,
    [...new Set(dmRows.map((r) => r.channelId))],
    dmRows.map((r) => r.initiatorId),
  );

  const items = page.map((row): CallHistoryItem => {
    const otherMembers = row.channelType === 'dm' ? (membersByChannel.get(row.channelId) ?? []) : [];
    return {
      id: row.id,
      channelId: row.channelId,
      channelType: row.channelType,
      channelName: row.channelName,
      callType: row.callType,
      status: row.status,
      direction: callDirection(row, viewerId),
      outcome: callOutcomeFor(row, viewerId),
      initiatorId: row.initiatorId,
      initiatorName: row.initiatorName,
      counterpart: callCounterpart(row, viewerId, row.channelType, otherMembers, people),
      otherMembers,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      duration: row.duration,
      createdAt: row.createdAt,
    };
  });

  return {
    items,
    totalCount: Number(countRows[0]?.count ?? 0),
    hasMore,
    cursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}
