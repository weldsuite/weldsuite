/**
 * Meeting Lifecycle: end a WeldMeet session.
 *
 * Shared by every path that ends a session: the host's end / leave routes and
 * the Cloudflare RealtimeKit webhook (meet-api), and the guest leave route of
 * the meeting portal (Next.js). It therefore only depends on the tenant
 * database handle, the RealtimeKit REST client and two OPTIONAL bindings, never
 * on a worker `Env` or a Hono context.
 *
 * The WeldChat call path lives in `@weldsuite/chat-domain/call-lifecycle`.
 */

import { and, eq, ne, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  endMeeting as endRtkMeeting,
  getLiveParticipantCount,
  kickAllParticipants as kickAllRtkParticipants,
  type CloudflareRealtimeEnv,
  type RealtimeKvNamespace,
} from '@weldsuite/cloudflare-realtime';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import * as schema from '@weldsuite/db/schema';
import type { MeetingAttendee } from '@weldsuite/db/schema/meetings';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import { generateId } from '@weldsuite/worker-kit/id';

/** Any tenant Drizzle handle (Neon HTTP in the workers, Neon websocket in the portal). */
export type MeetingLifecycleDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/** Service binding shape (Cloudflare `Fetcher`, or an adapter that calls the realtime-worker over HTTP). */
export interface RealtimeFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * What {@link endMeetingSession} reads. Everything but the RealtimeKit config
 * is optional: a missing `WORKSPACE_CACHE` skips the KV cleanup and a missing
 * `REALTIME` skips the live "session ended" push (the DB stays the source of
 * truth either way).
 */
export type MeetingLifecycleEnv = Omit<CloudflareRealtimeEnv, 'WORKSPACE_CACHE'> & {
  WORKSPACE_CACHE?: RealtimeKvNamespace & { delete(key: string): Promise<void> };
  REALTIME?: RealtimeFetcher;
};

// ============================================================================
// Schedule
// ============================================================================

/**
 * A scheduled meeting is past once its end (or, without one, start + 1h) has
 * elapsed. Unscheduled meetings ("Create a meeting for later", instant
 * meetings) are reusable rooms: they are never past, so ending a session
 * returns them to 'scheduled' and the same link can start a new session.
 */
export function isMeetingPast(
  meeting: { scheduledEnd: Date | null; scheduledStart: Date | null } | undefined,
  now: Date,
): boolean {
  if (meeting?.scheduledEnd) return new Date(meeting.scheduledEnd).getTime() < now.getTime();
  if (meeting?.scheduledStart) {
    return new Date(meeting.scheduledStart).getTime() < now.getTime() - 60 * 60_000;
  }
  return false;
}

// ============================================================================
// CRM activity
// ============================================================================

export interface LinkedPerson {
  personId: string | null;
  contactId: string | null;
}

/**
 * The CRM people linked to a meeting: session participants and meeting
 * attendees that carry a `personId` and/or the legacy `contactId`. One entry
 * per person (matched on personId, else on contactId), so a guest who is both
 * an attendee and a participant is logged once. Workspace members have neither
 * link and drop out.
 */
export function collectLinkedPeople(
  participants: ReadonlyArray<Pick<MeetingSessionParticipant, 'personId' | 'contactId'>>,
  attendees: ReadonlyArray<Pick<MeetingAttendee, 'personId' | 'contactId'>>,
): LinkedPerson[] {
  const byPerson = new Map<string, LinkedPerson>();
  const byContactOnly = new Map<string, LinkedPerson>();

  for (const raw of [...participants, ...attendees]) {
    const personId = raw.personId || null;
    const contactId = raw.contactId || null;
    if (!personId && !contactId) continue;

    if (personId) {
      const existing = byPerson.get(personId);
      if (existing) {
        existing.contactId = existing.contactId ?? contactId;
      } else {
        byPerson.set(personId, { personId, contactId });
      }
    } else if (contactId && !byContactOnly.has(contactId)) {
      byContactOnly.set(contactId, { personId: null, contactId });
    }
  }

  // A contact-only entry that a person entry already carries as back-reference is the same human.
  const covered = new Set([...byPerson.values()].map((p) => p.contactId).filter(Boolean));
  return [
    ...byPerson.values(),
    ...[...byContactOnly.values()].filter((p) => !covered.has(p.contactId)),
  ];
}

/**
 * Log the ended meeting on the timeline of every linked CRM person: one
 * completed `meeting` activity each, assigned to the organizer. Best effort:
 * a failure is logged and never fails the end of the session.
 */
async function logMeetingActivities(
  db: MeetingLifecycleDb,
  params: {
    meetingId: string;
    sessionId: string;
    participants: MeetingSessionParticipant[];
    startedAt: Date | null;
    endedAt: Date;
    durationSeconds: number;
  },
): Promise<void> {
  try {
    const { meetings, crmActivities } = schema;
    const [meeting] = await db
      .select({
        title: meetings.title,
        organizerId: meetings.organizerId,
        attendees: meetings.attendees,
        calendarEventId: meetings.calendarEventId,
      })
      .from(meetings)
      .where(eq(meetings.id, params.meetingId))
      .limit(1);
    if (!meeting) return;

    const people = collectLinkedPeople(params.participants, meeting.attendees ?? []);
    if (people.length === 0) return;

    const now = new Date();
    await db.insert(crmActivities).values(
      people.map((person) => ({
        id: generateId('act'),
        type: 'meeting',
        subject: meeting.title.slice(0, 255),
        status: 'completed',
        isVirtual: true,
        assignedToId: meeting.organizerId,
        personId: person.personId,
        // Platform convention: person timelines also store the person id in contact_id
        // (manual notes/activities do), so the entry shows under either filter.
        contactId: person.contactId ?? person.personId,
        startTime: params.startedAt ?? params.endedAt,
        endTime: params.endedAt,
        // crm_activities.duration is in minutes.
        duration: Math.round(params.durationSeconds / 60),
        calendarEventId: meeting.calendarEventId,
        createdAt: now,
        updatedAt: now,
      })),
    );
  } catch (err) {
    console.error('[MeetingLifecycle] CRM activity logging failed', {
      sessionId: params.sessionId,
      meetingId: params.meetingId,
      err,
    });
  }
}

// ============================================================================
// Realtime publishers (best effort, skipped without a REALTIME binding)
// ============================================================================

async function publishEnded(
  env: MeetingLifecycleEnv,
  orgId: string,
  data: { meetingId: string; sessionId: string; duration: number; status: string },
): Promise<void> {
  if (!env.REALTIME || !orgId) return;
  const rt = new RealtimePublisher(env.REALTIME);
  await rt.entityUpdated(
    orgId,
    'meeting_session',
    { meetingId: data.meetingId, sessionId: data.sessionId, duration: data.duration, status: 'ended' },
    'system',
  );
  await rt.entityUpdated(orgId, 'meeting', { meetingId: data.meetingId, status: data.status }, 'system');
}

// ============================================================================
// End session
// ============================================================================

/**
 * End a session: mark it ended (stamping everyone still in the room as left),
 * release the meeting (back to 'scheduled' for a reusable room, 'completed'
 * once its schedule is past), tear down the RealtimeKit room, drop the 24 h KV
 * mapping, log the meeting on the linked people's CRM timelines and push the
 * change to the platform.
 *
 * Idempotent: several clients (host end, every kicked guest's /leave, the RTK
 * webhook) race to end the same session. The first one wins the conditional
 * update; the rest return without touching anything, so `endedAt` / `duration`
 * are never overwritten and the CRM activities are written exactly once.
 *
 * `orgId` is the id the realtime hub is keyed by (the Clerk org id).
 */
export async function endMeetingSession(
  db: MeetingLifecycleDb,
  env: MeetingLifecycleEnv,
  orgId: string,
  sessionId: string,
  session: { startedAt: Date | null; cfAppId: string | null },
  meetingId: string,
): Promise<void> {
  const { meetingSessions, meetings } = schema;

  const now = new Date();
  const duration = session.startedAt
    ? Math.round((now.getTime() - new Date(session.startedAt).getTime()) / 1000)
    : 0;

  // A meeting that ends while still recording: RealtimeKit stops the recorder and
  // follows with recording.statusUpdate UPLOADING / UPLOADED, which drives the rest
  // (copy into the private bucket, status 'ready'). Until then the recording is
  // "processing". Nothing about the recording is linked here any more.

  // Claim the end: only the writer that flips a not-yet-ended row continues.
  //
  // The participants / recording columns are derived in SQL from the row being
  // claimed, not from an earlier read. A guest joining (or leaving) between a
  // read and this write would otherwise be overwritten by the stale snapshot.
  // Everyone still in the room leaves with the session: entries without a
  // `leftAt` get one, earlier leaves are kept.
  const leftAt = now.toISOString();
  const claimed = await db
    .update(meetingSessions)
    .set({
      status: 'ended',
      endedAt: now,
      duration,
      participants: sql`(
        SELECT COALESCE(
          jsonb_agg(
            CASE WHEN COALESCE(e.p->>'leftAt', '') = ''
              THEN e.p || jsonb_build_object('leftAt', ${leftAt}::text)
              ELSE e.p
            END
            ORDER BY e.ord
          ),
          '[]'::jsonb
        )
        FROM jsonb_array_elements(COALESCE(${meetingSessions.participants}, '[]'::jsonb)) WITH ORDINALITY AS e(p, ord)
      )`,
      recordingStatus: sql`CASE WHEN ${meetingSessions.recordingStatus} = 'recording' THEN 'processing' ELSE ${meetingSessions.recordingStatus} END`,
      recordingEnabled: sql`CASE WHEN ${meetingSessions.recordingStatus} = 'recording' THEN false ELSE ${meetingSessions.recordingEnabled} END`,
      updatedAt: now,
    })
    .where(and(eq(meetingSessions.id, sessionId), ne(meetingSessions.status, 'ended')))
    .returning({ participants: meetingSessions.participants });
  if (claimed.length === 0) return;
  const participants = claimed[0].participants ?? [];

  // Update meeting: clear active session, set back to scheduled or completed
  const [meeting] = await db
    .select({
      scheduledEnd: meetings.scheduledEnd,
      scheduledStart: meetings.scheduledStart,
    })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);

  const isPast = isMeetingPast(meeting, now);
  const meetingStatus = isPast ? 'completed' : 'scheduled';

  await db
    .update(meetings)
    .set({
      activeSessionId: null,
      status: meetingStatus,
      updatedAt: now,
    })
    .where(eq(meetings.id, meetingId));

  // Tear down the RTK room (best effort, DB is already the source of truth).
  // Deactivating the meeting alone does not disconnect live participants, so
  // kick them first; the two calls are independent so one failing never
  // skips the other. A kick on an empty or already-inactive room may be
  // rejected, which is expected and only logged.
  if (session.cfAppId) {
    const cfAppId = session.cfAppId;
    try {
      await kickAllRtkParticipants(env, cfAppId);
    } catch (err) {
      console.error('[MeetingLifecycle] RTK kick-all failed', { sessionId, cfAppId, err });
    }
    try {
      await endRtkMeeting(env, cfAppId);
    } catch (err) {
      console.error('[MeetingLifecycle] RTK end meeting failed', { sessionId, cfAppId, err });
    }
  }

  // Clean up the 24 h KV mapping (best effort). The 14-day `rtk-session:` mapping
  // is deliberately LEFT: recording, transcript and summary webhooks arrive after
  // the meeting ends.
  if (session.cfAppId && env.WORKSPACE_CACHE) {
    try {
      await env.WORKSPACE_CACHE.delete(`rtk-meeting:${session.cfAppId}`);
    } catch { /* best effort */ }
  }

  await logMeetingActivities(db, {
    meetingId,
    sessionId,
    participants,
    startedAt: session.startedAt,
    endedAt: now,
    durationSeconds: duration,
  });

  // Realtime publish (best effort)
  try {
    await publishEnded(env, orgId, { meetingId, sessionId, duration, status: meetingStatus });
  } catch (e) {
    console.error('[MeetingLifecycle] Realtime publish failed:', e);
  }
}

// ============================================================================
// End session, but only when the room is empty
// ============================================================================

/**
 * - `ended`: RealtimeKit reported an empty room and the session was ended.
 * - `occupied`: someone is still connected, nothing was touched.
 * - `unknown`: RealtimeKit could not be asked, nothing was touched.
 */
export type EndIfEmptyOutcome = 'ended' | 'occupied' | 'unknown';

/**
 * End a session that LOOKS finished, after asking RealtimeKit whether anyone
 * is still in the room. Every automatic end goes through here: the last
 * participant leaving, the inactivity sweep, a stale session found on start
 * and the `meeting.ended` webhook.
 *
 * Ending kicks everyone, so it must never be decided from our own participant
 * list alone. That list drifts: a leave webhook for a dropped connection lands
 * after the same person rejoined, a second tab closes, a join is recorded for
 * a guest still in the waiting room. Acting on it ended live meetings for
 * everybody in them. RealtimeKit knows who is connected; while it reports
 * anyone, the session stays. When the room really is empty RealtimeKit ends
 * its own session about a minute later and sends `meeting.ended`, which
 * arrives here again and ends ours.
 *
 * Not for the host's "End for all": that is {@link endMeetingSession}.
 */
export async function endMeetingSessionIfEmpty(
  db: MeetingLifecycleDb,
  env: MeetingLifecycleEnv,
  orgId: string,
  sessionId: string,
  session: { startedAt: Date | null; cfAppId: string | null },
  meetingId: string,
): Promise<EndIfEmptyOutcome> {
  if (session.cfAppId) {
    let live: number;
    try {
      live = await getLiveParticipantCount(env, session.cfAppId);
    } catch (err) {
      console.error('[MeetingLifecycle] RTK live participant check failed, keeping the session', {
        sessionId,
        cfAppId: session.cfAppId,
        err,
      });
      return 'unknown';
    }
    if (live > 0) return 'occupied';
  }

  await endMeetingSession(db, env, orgId, sessionId, session, meetingId);
  return 'ended';
}
