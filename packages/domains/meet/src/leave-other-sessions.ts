/**
 * WeldMeet: "one call at a time" for meeting sessions.
 *
 * A user is in at most ONE live call at a time across WeldMeet sessions and
 * WeldChat calls, enforced here on the server so it holds across tabs and
 * devices (the browser tab asks first; the server just enforces). After a user
 * SUCCESSFULLY joins a call, `leaveOtherMeetingSessions` drops them from every
 * other meeting session they are still in, and `evictSupersededConnection`
 * drops their OLDER connection when they join the same session again from
 * another tab or device. The chat side is `leaveOtherActiveCalls` in
 * `@weldsuite/chat-domain/call-participants`; each worker runs both after a join.
 *
 * Eviction is always a LEAVE, never an END for everyone: a session is only
 * ended through `endMeetingSessionIfEmpty`, which asks RealtimeKit whether
 * anyone is still connected. An organizer who is evicted therefore never ends a
 * meeting that others are still in.
 *
 * The evicted clients are told why BEFORE the RealtimeKit connection is
 * kicked: a `call_superseded` event on `chat.user.<userId>` (see
 * `CallSupersededEvent` in `@weldsuite/realtime/types`).
 *
 * Guests of the meeting portal (`guest:<email>` participants) never match: the
 * rule is about workspace members' user ids.
 *
 * Everything here is best effort: it logs and swallows its own errors so it can
 * run from a `waitUntil` without ever risking the join that triggered it.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { removeParticipant } from '@weldsuite/cloudflare-realtime';
import { publishEntityEventRaw, type EntityEventPublisherEnv } from '@weldsuite/entity-events';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import type { CallSupersededEvent } from '@weldsuite/realtime/types';
import * as schema from '@weldsuite/db/schema';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import {
  endMeetingSessionIfEmpty,
  type MeetingLifecycleDb,
  type MeetingLifecycleEnv,
} from './meeting-lifecycle';

/** The bindings these helpers read: the lifecycle env plus the entity-event hub queue. */
export type LeaveOtherSessionsEnv = MeetingLifecycleEnv & EntityEventPublisherEnv;

type SessionRow = typeof schema.meetingSessions.$inferSelect;

/** Options of {@link leaveOtherMeetingSessions}. */
export interface LeaveOtherSessionsOptions {
  /**
   * When the join that triggers this eviction started (ms since epoch; default:
   * now, at the moment of the call). A participation that began AFTER it is
   * left alone: it is a newer join elsewhere racing this one, and the delayed
   * eviction must not kick it.
   */
  triggeredAt?: number;
}

/** Tell the user's clients why their connection is about to disappear. Best effort. */
async function announceSuperseded(
  env: Pick<MeetingLifecycleEnv, 'REALTIME'>,
  orgId: string,
  userId: string,
  data: CallSupersededEvent,
): Promise<void> {
  if (!env.REALTIME || !orgId) return;
  try {
    await new RealtimePublisher(env.REALTIME).chatCallSuperseded(orgId, userId, data);
  } catch (err) {
    console.error('[MeetingLeaveOthers] call_superseded publish failed', { id: data.id, err });
  }
}

/** Disconnect one RealtimeKit participant. Best effort: the session may already be gone. */
async function evictRtkParticipant(
  env: MeetingLifecycleEnv,
  cfAppId: string | null | undefined,
  cfSessionId: string | null | undefined,
  logCtx: { sessionId: string },
): Promise<void> {
  if (!cfAppId || !cfSessionId) return;
  try {
    await removeParticipant(env, cfAppId, cfSessionId);
  } catch (err) {
    console.error('[MeetingLeaveOthers] RTK participant removal failed', { ...logCtx, cfAppId, err });
  }
}

/**
 * The RealtimeKit participant id of `previous`' still-live connection when it
 * differs from the connection just created (`newCfSessionId`); null when there
 * is nothing to evict. An entry that already left, or one that carries the same
 * id as the new connection, is never returned: the connection just created is
 * never evicted.
 */
export function supersededCfSessionId(
  previous: Pick<MeetingSessionParticipant, 'cfSessionId' | 'leftAt'> | undefined,
  newCfSessionId: string,
): string | null {
  if (!previous || previous.leftAt) return null;
  if (!previous.cfSessionId || previous.cfSessionId === newCfSessionId) return null;
  return previous.cfSessionId;
}

/**
 * The user joined `session` again (another tab, device, or a reloaded page):
 * drop the OLDER connection. Announces `call_superseded` (carrying the evicted
 * id, so the tab that is still valid can ignore it), then removes the old
 * RealtimeKit participant. The session itself and the new entry are untouched.
 */
export async function evictSupersededConnection(
  env: MeetingLifecycleEnv,
  orgId: string,
  userId: string,
  session: Pick<SessionRow, 'id' | 'meetingId' | 'cfAppId'>,
  oldCfSessionId: string,
): Promise<void> {
  await announceSuperseded(env, orgId, userId, {
    kind: 'meet',
    id: session.id,
    meetingId: session.meetingId,
    cfSessionId: oldCfSessionId,
  });
  await evictRtkParticipant(env, session.cfAppId, oldCfSessionId, { sessionId: session.id });
}

/** Latest moment this entry was (re)joined: a rejoin that kept `joinedAt` records it in `lastJoinAt`. */
function latestJoinMs(p: MeetingSessionParticipant): number {
  const joined = Date.parse(p.joinedAt);
  const last = p.lastJoinAt ? Date.parse(p.lastJoinAt) : Number.NaN;
  return Math.max(Number.isNaN(joined) ? 0 : joined, Number.isNaN(last) ? 0 : last);
}

/**
 * Remove `userId` from every OTHER waiting/active meeting session they are
 * still in (all of them when `exceptSessionId` is null, e.g. when the join that
 * triggers this is a WeldChat call). Per session: announce `call_superseded`,
 * remove the user's RealtimeKit connection, stamp `leftAt` on their entry and,
 * only when no active participant is left, end the session once RealtimeKit
 * confirms the room is empty (`endMeetingSessionIfEmpty`).
 */
export async function leaveOtherMeetingSessions(
  db: MeetingLifecycleDb,
  env: LeaveOtherSessionsEnv,
  orgId: string,
  userId: string,
  exceptSessionId: string | null,
  opts: LeaveOtherSessionsOptions = {},
): Promise<void> {
  const triggeredAt = opts.triggeredAt ?? Date.now();
  const { meetingSessions } = schema;
  try {
    const sessions = await db
      .select()
      .from(meetingSessions)
      .where(
        and(
          inArray(meetingSessions.status, ['waiting', 'active']),
          sql`${meetingSessions.participants} @> ${JSON.stringify([{ userId }])}::jsonb`,
        ),
      );

    for (const session of sessions) {
      if (session.id === exceptSessionId) continue;
      try {
        await leaveSession(db, env, orgId, userId, session, triggeredAt);
      } catch (err) {
        console.error('[MeetingLeaveOthers] leaving session failed', { sessionId: session.id, err });
      }
    }
  } catch (err) {
    console.error('[MeetingLeaveOthers] leaveOtherMeetingSessions failed', err);
  }
}

/** Drop `userId` from one session: announce, evict the RTK connection, mark left, end if empty. */
async function leaveSession(
  db: MeetingLifecycleDb,
  env: LeaveOtherSessionsEnv,
  orgId: string,
  userId: string,
  session: SessionRow,
  triggeredAt: number,
): Promise<void> {
  const { meetingSessions } = schema;
  const mine = (session.participants ?? []).find((p) => p.userId === userId && !p.leftAt);
  if (!mine) return; // not actually in this session
  if (latestJoinMs(mine) > triggeredAt) return; // a newer join, not the one superseded

  // Tell the user's clients why, BEFORE the room is pulled from under them.
  await announceSuperseded(env, orgId, userId, {
    kind: 'meet',
    id: session.id,
    meetingId: session.meetingId,
    cfSessionId: mine.cfSessionId || null,
  });

  await evictRtkParticipant(env, session.cfAppId, mine.cfSessionId, { sessionId: session.id });

  // Stamp leftAt on the entry in SQL, from the row as it is now: webhooks write
  // this column too (`meeting.participantJoined` / `participantLeft`), so a
  // read-modify-write from the snapshot above would overwrite them. Only the
  // connection that was evicted is stamped (matched on its RealtimeKit id): a
  // rejoin that raced in under a new id stays.
  const leftAt = new Date().toISOString();
  const [updated] = await db
    .update(meetingSessions)
    .set({
      participants: sql`(
        SELECT COALESCE(
          jsonb_agg(
            CASE WHEN e.p->>'userId' = ${userId}
                   AND COALESCE(e.p->>'leftAt', '') = ''
                   AND COALESCE(e.p->>'cfSessionId', '') = ${mine.cfSessionId ?? ''}
              THEN e.p || jsonb_build_object('leftAt', ${leftAt}::text)
              ELSE e.p
            END
            ORDER BY e.ord
          ),
          '[]'::jsonb
        )
        FROM jsonb_array_elements(COALESCE(${meetingSessions.participants}, '[]'::jsonb)) WITH ORDINALITY AS e(p, ord)
      )`,
      updatedAt: new Date(),
    })
    .where(and(eq(meetingSessions.id, session.id), ne(meetingSessions.status, 'ended')))
    .returning({ participants: meetingSessions.participants });
  if (!updated) return; // the session ended in the meantime

  const participants = updated.participants ?? [];

  // Entity event so the platform refreshes this session's participant list: the
  // webhook for the kick finds the entry already left and publishes nothing.
  try {
    await publishEntityEventRaw({
      env,
      workspaceId: orgId,
      userId: 'system',
      entityType: 'meeting_session',
      action: 'updated',
      entityId: session.id,
      data: { ...session, participants },
      source: 'system',
    });
  } catch (err) {
    console.error('[MeetingLeaveOthers] entity event publish failed', { sessionId: session.id, err });
  }

  // Only when our list shows nobody left, and then only if RealtimeKit agrees
  // the room is empty: the list drifts, and ending kicks whoever is inside.
  if (participants.every((p) => !!p.leftAt)) {
    await endMeetingSessionIfEmpty(db, env, orgId, session.id, session, session.meetingId);
  }
}
