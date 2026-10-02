/**
 * Meeting session routes — flat /api/meeting-sessions/* surface backed by `meetingSessions`.
 *
 * Permissions: sessions:read | sessions:create | sessions:update | sessions:delete.
 *
 * Action endpoints (static paths registered BEFORE /:id):
 *   GET  /active          — active session (?meetingId=)
 *   GET  /latest          — latest session (?meetingId=)
 *   POST /start           — start a new session (body: { meetingId, join? })
 *   POST /:id/join        — join a session (get RTK auth token)
 *   POST /:id/leave       — leave a session (auto-ends when last participant leaves)
 *   POST /:id/end         — end a session
 *   GET  /:id/recordings       — LEGACY list of RealtimeKit recordings for a session (+ saved URL)
 *
 * Recording, transcript and summary routes (start/stop, ai-options, access,
 * delete, transcribe, summarize, transcription) live in ./recording.ts and are
 * mounted before the generic /:id CRUD below. The recorder state columns are
 * server-owned: POST / and PATCH /:id never write them.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createMeetingSessionSchema, updateMeetingSessionSchema } from '@weldsuite/core-api-client/schemas/meeting-sessions';
import { SERVER_OWNED_MEETING_SESSION_FIELDS } from '@weldsuite/app-api-client/schemas/weldmeet-recordings';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  createMeeting as createRtkMeeting,
  addParticipant,
  ensurePresets,
  RTK_PRESETS,
  getRecordings,
} from '@weldsuite/cloudflare-realtime';
import { endMeetingSession, publishSessionStarted, publishMeetingUpdated } from '../../services/weldmeet/meeting-lifecycle';
import { RTK_SESSION_MAPPING_TTL_SECONDS, rtkSessionMappingKey } from '../../services/rtk-webhook';
import { meetingSessionRecordingRoutes } from './recording';
import { resolveParticipantLink, type ResolvedParticipantLink } from '../../lib/participant-resolver';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import type { Context } from 'hono';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.meetingSessions;

/** Drop the server-owned columns (recorder, transcript, summary state, ids) from a client body. */
function stripServerOwned(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const key of SERVER_OWNED_MEETING_SESSION_FIELDS) delete out[key];
  return out;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read a workspace member's display info, preferring KV cache to avoid a
 * tenant-DB roundtrip on every join. 1h TTL, write-through.
 */
async function getMemberDisplayCached(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  orgId: string,
  userId: string,
): Promise<{ name: string; picture?: string }> {
  const cacheKey = `member-display:${orgId}:${userId}`;
  try {
    const cached = await c.env.WORKSPACE_CACHE?.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as { name?: string; picture?: string };
      return { name: parsed.name ?? 'Unknown', picture: parsed.picture };
    }
  } catch { /* fall through to DB */ }

  const db = c.get('tenantDb');
  const { workspaceMembers } = schema;
  const [author] = await db
    .select({ name: workspaceMembers.name, picture: workspaceMembers.picture })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);

  const result = { name: author?.name ?? 'Unknown', picture: author?.picture ?? undefined };
  c.executionCtx.waitUntil(
    c.env.WORKSPACE_CACHE?.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 }) ??
      Promise.resolve(),
  );
  return result;
}

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type SessionRow = typeof schema.meetingSessions.$inferSelect;
type MeetingRow = typeof schema.meetings.$inferSelect;

/** Build the session-participant record for a freshly joined RTK participant. */
function buildSessionParticipant(
  userId: string,
  userName: string,
  avatar: string | undefined,
  link: ResolvedParticipantLink,
  cfSessionId: string,
): MeetingSessionParticipant {
  return {
    userId,
    userName,
    userAvatar: avatar,
    joinedAt: new Date().toISOString(),
    cfSessionId,
    hasAudio: false,
    hasVideo: false,
    hasScreenShare: false,
    ...(link.workspaceMemberId ? { workspaceMemberId: link.workspaceMemberId } : {}),
    ...(link.personId ? { personId: link.personId } : {}),
  };
}

/**
 * If the meeting still points at a live session, end it when it is stale
 * (empty for a minute, or waiting for 5); otherwise report a conflict.
 */
async function endStaleSessionOrConflict(
  db: Database,
  env: Env,
  orgId: string,
  meetingId: string,
  activeSessionId: string,
): Promise<'ok' | 'conflict'> {
  const [existingSession] = await db.select().from(t).where(eq(t.id, activeSessionId)).limit(1);
  if (!existingSession || existingSession.status === 'ended') return 'ok';

  const age = Date.now() - new Date(existingSession.createdAt).getTime();
  const participants: MeetingSessionParticipant[] = existingSession.participants ?? [];
  const activeParticipants = participants.filter((p) => !p.leftAt);
  const isStale =
    (activeParticipants.length === 0 && age > 60_000) ||
    (existingSession.status === 'waiting' && age > 5 * 60_000);

  if (!isStale) return 'conflict';
  await endMeetingSession(db, env, orgId, existingSession.id, existingSession, meetingId);
  return 'ok';
}

/** Register the calling member with RTK as part of `POST /start?join=true`. */
async function joinStartedSession(
  c: AppContext,
  params: {
    orgId: string;
    userId: string;
    userName: string;
    memberPicture: string | undefined;
    rtkMeetingId: string;
    isHost: boolean;
  },
): Promise<{ authToken: string; entry: MeetingSessionParticipant }> {
  const { orgId, userId, userName, memberPicture, rtkMeetingId, isHost } = params;
  const link = await resolveParticipantLink(c.get('tenantDb'), c.env, orgId, { userId, name: userName });
  const avatar = link.avatarUrl ?? memberPicture;
  const rtkParticipant = await addParticipant(c.env, rtkMeetingId, {
    name: userName,
    customParticipantId: userId,
    presetName: isHost ? RTK_PRESETS.HOST : RTK_PRESETS.MEMBER,
    picture: avatar,
  });
  return {
    authToken: rtkParticipant.token,
    entry: buildSessionParticipant(userId, userName, avatar, link, rtkParticipant.id),
  };
}

/**
 * Host-control policy gates for joining. Returns the blocking outcome, or
 * null when the user may join.
 */
function checkJoinPolicy(
  meeting: MeetingRow,
  session: SessionRow,
  userId: string,
): 'locked' | 'host_must_join_first' | null {
  if (meeting.lockAfterStart && session.status === 'active') {
    const attendees = (meeting.attendees ?? []) as Array<{ userId?: string }>;
    const isPreInvited = attendees.some((a) => a.userId === userId);
    if (!isPreInvited) return 'locked';
  }

  if (meeting.hostMustJoinFirst) {
    const hostPresent = !!session.participants?.some?.((p) => p.userId === meeting.organizerId);
    if (!hostPresent) return 'host_must_join_first';
  }
  return null;
}

// ============================================================================
// Action endpoints — static paths registered BEFORE /:id
// ============================================================================

/**
 * GET /active - Get the active (waiting|active) session for a meeting.
 * ?meetingId=  (required)
 * Also performs stale-session cleanup.
 */
app.get('/active', requirePermission('sessions:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const meetingId = c.req.query('meetingId');
  if (!meetingId) return error.badRequest(c, 'meetingId query parameter is required');

  try {
    const db = c.get('tenantDb');
    const { meetings } = schema;

    const [session] = await db
      .select()
      .from(t)
      .where(
        and(
          eq(t.meetingId, meetingId),
          or(eq(t.status, 'waiting'), eq(t.status, 'active')),
        ),
      )
      .limit(1);

    if (session) {
      // Resolve inactivity policy from the parent meeting row
      const [meetingRow] = await db
        .select({
          autoEndOnInactivity: meetings.autoEndOnInactivity,
          autoEndInactivityMinutes: meetings.autoEndInactivityMinutes,
        })
        .from(meetings)
        .where(eq(meetings.id, meetingId))
        .limit(1);

      const inactivityMs =
        meetingRow?.autoEndOnInactivity === false
          ? Number.POSITIVE_INFINITY
          : (meetingRow?.autoEndInactivityMinutes ?? 10) * 60_000;

      const now = Date.now();
      const participants: MeetingSessionParticipant[] = session.participants ?? [];
      const activeParticipants = participants.filter((p) => !p.leftAt);

      const isStale =
        (session.status === 'waiting' &&
          now - new Date(session.createdAt).getTime() > inactivityMs) ||
        (session.status === 'active' &&
          activeParticipants.length === 0 &&
          now - new Date(session.updatedAt).getTime() > inactivityMs);

      if (isStale) {
        try {
          await endMeetingSession(db, c.env, orgId, session.id, session, meetingId);
        } catch { /* best effort */ }
        return success(c, null);
      }
    }

    return success(c, session ?? null);
  } catch (err) {
    console.error('[app-api/meeting-sessions] active failed:', err);
    return error.internal(c, 'Failed to get active session');
  }
});

/**
 * GET /latest - Get the most recent session for a meeting (any status).
 * ?meetingId=  (required)
 */
app.get('/latest', requirePermission('sessions:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const meetingId = c.req.query('meetingId');
  if (!meetingId) return error.badRequest(c, 'meetingId query parameter is required');

  try {
    const db = c.get('tenantDb');

    const [session] = await db
      .select()
      .from(t)
      .where(eq(t.meetingId, meetingId))
      .orderBy(desc(t.createdAt))
      .limit(1);

    return success(c, session ?? null);
  } catch (err) {
    console.error('[app-api/meeting-sessions] latest failed:', err);
    return error.internal(c, 'Failed to get latest session');
  }
});

/**
 * POST /start - Start a new meeting session.
 *
 * Body: { meetingId, join? }
 * ?join=true — also adds the calling user as a participant and returns the
 *              RTK auth token in the same response, saving a second round-trip.
 */
app.post(
  '/start',
  requirePermission('sessions:create'),
  zValidator('json', z.object({ meetingId: z.string().min(1) })),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);

    const userId = c.get('userId');
    const { meetingId } = c.req.valid('json');
    const joinInline = c.req.query('join') === 'true';

    const t0 = Date.now();
    const timings: Record<string, number> = {};

    try {
      const db = c.get('tenantDb');
      const { meetings } = schema;

      const [meetingResult, member] = await Promise.all([
        db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1),
        getMemberDisplayCached(c, orgId, userId),
      ]);
      timings.read = Date.now() - t0;

      const [meeting] = meetingResult;
      if (!meeting) return error.notFound(c, 'Meeting', meetingId);
      if (meeting.status === 'cancelled') return error.badRequest(c, 'Meeting is cancelled');

      // Check no active session already
      if (meeting.activeSessionId) {
        const outcome = await endStaleSessionOrConflict(db, c.env, orgId, meetingId, meeting.activeSessionId);
        if (outcome === 'conflict') return error.conflict(c, 'A session is already active for this meeting');
      }
      timings.stale = Date.now() - t0;

      const userName = member.name;
      const sessionId = generateId('msess');
      const now = new Date();

      await ensurePresets(c.env, c.executionCtx);
      timings.presets = Date.now() - t0;

      // autoRecord: RealtimeKit itself starts recording when the first person joins
      // (no client-side effect). audioExport: keep an audio-only MP3 next to any
      // recording (transcribe afterwards, audio player).
      const rtkMeeting = await createRtkMeeting(c.env, meeting.title, {
        recordOnStart: meeting.autoRecord === true && meeting.allowRecording !== false,
        audioExport: true,
      });
      timings.rtkCreate = Date.now() - t0;

      // KV mappings for inbound webhook resolution — fire and forget.
      // rtk-meeting: 24 h, deleted when the session ends. rtk-session: 14 days and
      // never deleted at end: recording / transcript / summary webhooks arrive later.
      c.executionCtx.waitUntil(
        Promise.all([
          c.env.WORKSPACE_CACHE.put(
            `rtk-meeting:${rtkMeeting.id}`,
            JSON.stringify({ orgId, type: 'session', sessionId, meetingId }),
            { expirationTtl: 86400 },
          ),
          c.env.WORKSPACE_CACHE.put(
            rtkSessionMappingKey(rtkMeeting.id),
            JSON.stringify({ orgId, sessionId, meetingId }),
            { expirationTtl: RTK_SESSION_MAPPING_TTL_SECONDS },
          ),
        ]).catch((e) => console.warn('[meeting-sessions/start] KV write failed (non-fatal):', e)),
      );

      const isHost = meeting.organizerId === userId;
      let authToken: string | undefined;
      let firstParticipantEntry: MeetingSessionParticipant | undefined;

      if (joinInline) {
        const joined = await joinStartedSession(c, {
          orgId,
          userId,
          userName,
          memberPicture: member.picture,
          rtkMeetingId: rtkMeeting.id,
          isHost,
        });
        authToken = joined.authToken;
        firstParticipantEntry = joined.entry;
        timings.rtkJoin = Date.now() - t0;
      }

      const initialParticipants = firstParticipantEntry ? [firstParticipantEntry] : [];

      await db.insert(t).values({
        id: sessionId,
        meetingId,
        sessionType: meeting.meetingType ?? 'video',
        status: joinInline ? 'active' : 'waiting',
        cfAppId: rtkMeeting.id,
        startedBy: userId,
        startedByName: userName,
        participants: initialParticipants,
        maxParticipants: initialParticipants.length,
        createdAt: now,
        updatedAt: now,
        ...(joinInline ? { startedAt: now } : {}),
      });

      await db
        .update(meetings)
        .set({ status: 'in_progress', activeSessionId: sessionId, updatedAt: now })
        .where(eq(meetings.id, meetingId));
      timings.dbWrite = Date.now() - t0;

      c.executionCtx.waitUntil(
        (async () => {
          try {
            await publishSessionStarted(c.env, orgId, { meetingId, sessionId, startedBy: userId });
            await publishMeetingUpdated(c.env, orgId, { meetingId, status: 'in_progress' });
          } catch (e) {
            console.error('[meeting-sessions/start] Realtime publish failed:', e);
          }
        })(),
      );

      publishEntityEvent({
        c,
        entityType: 'meeting_session',
        entityId: sessionId,
        action: 'created',
        data: { id: sessionId, meetingId, status: joinInline ? 'active' : 'waiting', startedBy: userId },
      });

      timings.total = Date.now() - t0;
      console.log('[app-api/meeting-sessions] start timings', { meetingId, sessionId, joinInline, ...timings });

      return success(
        c,
        {
          sessionId,
          status: joinInline ? 'active' : 'waiting',
          rtkMeetingId: rtkMeeting.id,
          ...(joinInline ? { authToken, participants: initialParticipants } : {}),
        },
        201,
      );
    } catch (err) {
      console.error('[app-api/meeting-sessions] start failed:', err, { timings });
      return error.internal(c, 'Failed to start session');
    }
  },
);

// ============================================================================
// /:id action endpoints — registered BEFORE the generic /:id CRUD handler
// ============================================================================

/**
 * POST /:id/join - Join a session (get RealtimeKit auth token)
 */
app.post('/:id/join', requirePermission('sessions:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const userId = c.get('userId');
  const sessionId = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const { meetings, workspaceMembers } = schema;

    const [session] = await db.select().from(t).where(eq(t.id, sessionId)).limit(1);
    if (!session) return error.notFound(c, 'Session', sessionId);
    if (session.status === 'ended') return error.badRequest(c, 'Session has ended');
    if (!session.cfAppId) return error.internal(c, 'Session has no RTK meeting ID');

    const [meeting] = await db
      .select()
      .from(meetings)
      .where(eq(meetings.id, session.meetingId))
      .limit(1);

    const isHost = meeting?.organizerId === userId;

    // Host-control policy gates
    const blocked = meeting && !isHost ? checkJoinPolicy(meeting, session, userId) : null;
    if (blocked === 'locked') {
      return error.forbidden(c, 'This meeting is locked. New participants are not allowed.');
    }
    if (blocked === 'host_must_join_first') {
      return success(c, { sessionId, status: 'waiting' as const, reason: 'host_must_join_first' });
    }

    const [author] = await db
      .select({ name: workspaceMembers.name, picture: workspaceMembers.picture })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, userId))
      .limit(1);

    const userName = author?.name ?? 'Unknown';

    const link = await resolveParticipantLink(db, c.env, orgId, { userId, name: userName });
    const avatar = link.avatarUrl ?? author?.picture ?? undefined;

    // Authenticated platform joiners are trusted members — they skip the
    // waiting room (the waiting room is enforced only for unauthenticated
    // meeting-portal guests). Organizer gets HOST; everyone else MEMBER.
    const rtkParticipant = await addParticipant(c.env, session.cfAppId, {
      name: userName,
      customParticipantId: userId,
      presetName: isHost ? RTK_PRESETS.HOST : RTK_PRESETS.MEMBER,
      picture: avatar,
    });

    const participant = buildSessionParticipant(userId, userName, avatar, link, rtkParticipant.id);

    const participants: MeetingSessionParticipant[] = [...(session.participants ?? [])];
    const filtered = participants.filter((p) => p.userId !== userId);
    filtered.push(participant);

    const now = new Date();
    const updates: Record<string, unknown> = {
      participants: filtered,
      maxParticipants: Math.max(session.maxParticipants ?? 0, filtered.length),
      updatedAt: now,
    };

    if (session.status === 'waiting') {
      updates.status = 'active';
      updates.startedAt = now;
    }

    await db.update(t).set(updates).where(eq(t.id, sessionId));

    return success(c, { sessionId, authToken: rtkParticipant.token, participants: filtered });
  } catch (err: any) {
    console.error('[app-api/meeting-sessions] join failed:', err?.message ?? err);
    return error.internal(c, 'Failed to join session');
  }
});

/**
 * POST /:id/leave - Leave a session (auto-ends when last participant leaves)
 */
app.post('/:id/leave', requirePermission('sessions:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const userId = c.get('userId');
  const sessionId = c.req.param('id');

  try {
    const db = c.get('tenantDb');

    const [session] = await db.select().from(t).where(eq(t.id, sessionId)).limit(1);
    if (!session) return error.notFound(c, 'Session', sessionId);

    const participants: MeetingSessionParticipant[] = [...(session.participants ?? [])];
    const idx = participants.findIndex((p) => p.userId === userId);
    if (idx >= 0) {
      participants[idx] = { ...participants[idx], leftAt: new Date().toISOString() };
    }

    const activeParticipants = participants.filter((p) => !p.leftAt);

    await db
      .update(t)
      .set({ participants, updatedAt: new Date() })
      .where(eq(t.id, sessionId));

    if (activeParticipants.length === 0) {
      await endMeetingSession(db, c.env, orgId, sessionId, session, session.meetingId);
    }

    return success(c, { ok: true });
  } catch (err) {
    console.error('[app-api/meeting-sessions] leave failed:', err);
    return error.internal(c, 'Failed to leave session');
  }
});

/**
 * POST /:id/end - End a session (organizer / admin action)
 */
app.post('/:id/end', requirePermission('sessions:update'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const sessionId = c.req.param('id');

  try {
    const db = c.get('tenantDb');

    const [session] = await db.select().from(t).where(eq(t.id, sessionId)).limit(1);
    if (!session) return error.notFound(c, 'Session', sessionId);

    await endMeetingSession(db, c.env, orgId, sessionId, session, session.meetingId);

    return success(c, { ok: true });
  } catch (err) {
    console.error('[app-api/meeting-sessions] end failed:', err);
    return error.internal(c, 'Failed to end session');
  }
});

// Recording start/stop, ai-options, access, delete, transcribe, summarize and the
// session transcription reads: see ./recording.ts (static + /:id/recording paths,
// registered before the generic /:id CRUD below).
app.route('/', meetingSessionRecordingRoutes);

/**
 * GET /:id/recordings - List recordings for a session (CF RTK + saved URL)
 */
app.get('/:id/recordings', requirePermission('sessions:read'), async (c) => {
  const sessionId = c.req.param('id');

  try {
    const db = c.get('tenantDb');

    const [session] = await db
      .select({ cfAppId: t.cfAppId, recordingUrl: t.recordingUrl })
      .from(t)
      .where(eq(t.id, sessionId))
      .limit(1);
    if (!session) return error.notFound(c, 'Session', sessionId);

    let recordings: any[] = [];
    if (session.cfAppId) {
      try {
        recordings = await getRecordings(c.env, session.cfAppId);
      } catch { /* best effort */ }
    }

    return success(c, { recordings, savedUrl: session.recordingUrl });
  } catch (err) {
    console.error('[app-api/meeting-sessions] recordings failed:', err);
    return error.internal(c, 'Failed to get recordings');
  }
});

// ============================================================================
// CRUD list/get/create/update/delete
// ============================================================================

app.get('/', requirePermission('sessions:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [];
  if (q.meetingId !== undefined && q.meetingId !== '') conditions.push(eq(t.meetingId, q.meetingId));
  if (q.status !== undefined && q.status !== '') conditions.push(eq(t.status, q.status));
  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t).where(eq(t.id, q.cursor)).limit(1);
    if (cur?.createdAt) {
      conditions.push(
        sql`(${t.createdAt} < ${cur.createdAt} OR (${t.createdAt} = ${cur.createdAt} AND ${t.id} < ${cur.id}))`,
      );
    }
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const filterConditions = q.cursor ? conditions.slice(0, -1) : conditions;
  const countWhere = filterConditions.length ? and(...filterConditions) : undefined;

  try {
    const [rows, countRes] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.createdAt), desc(t.id)).limit(limit + 1),
      db.select({ count: sql<number>`count(*)` }).from(t).where(countWhere),
    ]);
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1].id : null;
    const totalCount = Number(countRes[0]?.count ?? 0);
    return list(c, data, cursorPagination(totalCount, hasMore, nextCursor));
  } catch (err) {
    console.error('[app-api/meeting-sessions] list failed:', err);
    return error.internal(c, 'Failed to list meeting sessions');
  }
});

app.get('/:id', requirePermission('sessions:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.notFound(c, 'Meeting session', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/meeting-sessions] get failed:', err);
    return error.internal(c, 'Failed to fetch meeting session');
  }
});

app.post('/', requirePermission('sessions:create'), zValidator('json', createMeetingSessionSchema), async (c) => {
  const db = c.get('tenantDb');
  // meetingId is the one server-owned field a create legitimately sets.
  const body = c.req.valid('json') as Record<string, any>;
  const data = { ...stripServerOwned(body), ...(body.meetingId !== undefined ? { meetingId: body.meetingId } : {}) } as Record<string, any>;
  const id = generateId('msn');
  const now = new Date();
  try {
    await db.insert(t).values({ id, ...data, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'meeting_session',
      entityId: id,
      action: 'created',
      data: {
        id,
        meetingId: data.meetingId as string,
        status: (data.status as string | undefined) ?? 'waiting',
        startedBy: data.startedBy as string,
      },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/meeting-sessions] create failed:', err);
    return error.internal(c, 'Failed to create meeting session');
  }
});

app.patch('/:id', requirePermission('sessions:update'), zValidator('json', updateMeetingSessionSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  // Recorder / transcript / summary state and ids are server-owned: strip them.
  const data = stripServerOwned(c.req.valid('json') as Record<string, unknown>);
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Meeting session', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'meeting_session',
      entityId: id,
      action: 'updated',
      data: {
        id,
        meetingId: (update.meetingId as string | undefined) ?? existing.meetingId,
        status: (update.status as string | undefined) ?? existing.status,
        startedBy: (update.startedBy as string | undefined) ?? existing.startedBy,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/meeting-sessions] update failed:', err);
    return error.internal(c, 'Failed to update meeting session');
  }
});

app.delete('/:id', requirePermission('sessions:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Meeting session', id);
    await db.delete(t).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'meeting_session',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/meeting-sessions] delete failed:', err);
    return error.internal(c, 'Failed to delete meeting session');
  }
});

export const meetingSessionsRoutes = app;
