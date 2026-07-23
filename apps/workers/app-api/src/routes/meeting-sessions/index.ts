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
 *   POST /:id/recording/start  — mark session as recording
 *   POST /:id/recording/stop   — stop recording, persist key for later URL fetch
 *   GET  /:id/recordings       — list recordings for a session (CF RTK + saved URL)
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createMeetingSessionSchema, updateMeetingSessionSchema } from '@weldsuite/core-api-client/schemas/meeting-sessions';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';
import {
  createMeeting as createRtkMeeting,
  addParticipant,
  ensurePresets,
  RTK_PRESETS,
  getRecordings,
} from '@weldsuite/cloudflare-realtime';
import { endMeetingSession, publishSessionStarted, publishMeetingUpdated } from '../../services/weldmeet/meeting-lifecycle';
import { resolveParticipantLink } from '../../lib/participant-resolver';
import type { MeetingSessionParticipant } from '@weldsuite/db/schema/meeting-sessions';
import type { Context } from 'hono';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.meetingSessions;

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
        const [existingSession] = await db
          .select()
          .from(t)
          .where(eq(t.id, meeting.activeSessionId))
          .limit(1);

        if (existingSession && existingSession.status !== 'ended') {
          const age = Date.now() - new Date(existingSession.createdAt).getTime();
          const participants: MeetingSessionParticipant[] = existingSession.participants ?? [];
          const activeParticipants = participants.filter((p) => !p.leftAt);
          const isStale =
            (activeParticipants.length === 0 && age > 60_000) ||
            (existingSession.status === 'waiting' && age > 5 * 60_000);

          if (isStale) {
            await endMeetingSession(db, c.env, orgId, existingSession.id, existingSession, meetingId);
          } else {
            return error.conflict(c, 'A session is already active for this meeting');
          }
        }
      }
      timings.stale = Date.now() - t0;

      const userName = member.name;
      const sessionId = generateId('msess');
      const now = new Date();

      await ensurePresets(c.env, c.executionCtx);
      timings.presets = Date.now() - t0;

      const rtkMeeting = await createRtkMeeting(c.env, meeting.title);
      timings.rtkCreate = Date.now() - t0;

      // KV mapping for inbound webhook resolution — fire and forget
      c.executionCtx.waitUntil(
        c.env.WORKSPACE_CACHE.put(
          `rtk-meeting:${rtkMeeting.id}`,
          JSON.stringify({ orgId, type: 'session', sessionId, meetingId }),
          { expirationTtl: 86400 },
        ).catch((e) => console.warn('[meeting-sessions/start] KV write failed (non-fatal):', e)),
      );

      const isHost = meeting.organizerId === userId;
      let authToken: string | undefined;
      let firstParticipantEntry: MeetingSessionParticipant | undefined;

      if (joinInline) {
        const link = await resolveParticipantLink(db, c.env, orgId, {
          userId,
          name: userName,
        });
        const avatar = link.avatarUrl ?? member.picture;
        const rtkParticipant = await addParticipant(c.env, rtkMeeting.id, {
          name: userName,
          customParticipantId: userId,
          presetName: isHost ? RTK_PRESETS.HOST : RTK_PRESETS.MEMBER,
          picture: avatar,
        });
        authToken = rtkParticipant.token;
        firstParticipantEntry = {
          userId,
          userName,
          userAvatar: avatar,
          joinedAt: new Date().toISOString(),
          cfSessionId: rtkParticipant.id,
          hasAudio: false,
          hasVideo: false,
          hasScreenShare: false,
          ...(link.workspaceMemberId ? { workspaceMemberId: link.workspaceMemberId } : {}),
          ...(link.personId ? { personId: link.personId } : {}),
        };
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
    if (meeting && !isHost) {
      if (meeting.lockAfterStart && session.status === 'active') {
        const attendees = (meeting.attendees ?? []) as Array<{ userId?: string }>;
        const isPreInvited = attendees.some((a) => a.userId === userId);
        if (!isPreInvited) {
          return error.forbidden(c, 'This meeting is locked. New participants are not allowed.');
        }
      }

      if (meeting.hostMustJoinFirst) {
        const hostPresent = !!session.participants?.some?.((p) => p.userId === meeting.organizerId);
        if (!hostPresent) {
          return success(c, { sessionId, status: 'waiting' as const, reason: 'host_must_join_first' });
        }
      }
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

    const participant: MeetingSessionParticipant = {
      userId,
      userName,
      userAvatar: avatar,
      joinedAt: new Date().toISOString(),
      cfSessionId: rtkParticipant.id,
      hasAudio: false,
      hasVideo: false,
      hasScreenShare: false,
      ...(link.workspaceMemberId ? { workspaceMemberId: link.workspaceMemberId } : {}),
      ...(link.personId ? { personId: link.personId } : {}),
    };

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

/**
 * POST /:id/recording/start - Mark session as recording
 */
app.post('/:id/recording/start', requirePermission('sessions:update'), async (c) => {
  const sessionId = c.req.param('id');
  const userId = c.get('userId');

  try {
    const db = c.get('tenantDb');
    const { meetings } = schema;

    const [session] = await db
      .select({ meetingId: t.meetingId })
      .from(t)
      .where(eq(t.id, sessionId))
      .limit(1);
    if (!session) return error.notFound(c, 'Session', sessionId);

    const [meeting] = await db
      .select({ organizerId: meetings.organizerId, allowParticipantRecord: meetings.allowParticipantRecord })
      .from(meetings)
      .where(eq(meetings.id, session.meetingId))
      .limit(1);

    if (meeting && meeting.organizerId !== userId && !meeting.allowParticipantRecord) {
      return error.forbidden(c, 'Only the meeting organizer can start a recording.');
    }

    await db
      .update(t)
      .set({ recordingEnabled: true, updatedAt: new Date() })
      .where(eq(t.id, sessionId));

    return success(c, { ok: true });
  } catch (err) {
    console.error('[app-api/meeting-sessions] recording/start failed:', err);
    return error.internal(c, 'Failed to start recording');
  }
});

/**
 * POST /:id/recording/stop - Stop recording, persist cfAppId as key for URL fetch
 */
app.post('/:id/recording/stop', requirePermission('sessions:update'), async (c) => {
  const sessionId = c.req.param('id');

  try {
    const db = c.get('tenantDb');

    const [session] = await db
      .select({ cfAppId: t.cfAppId })
      .from(t)
      .where(eq(t.id, sessionId))
      .limit(1);
    if (!session) return error.notFound(c, 'Session', sessionId);

    await db
      .update(t)
      .set({
        recordingEnabled: false,
        recordingKey: session.cfAppId ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(t.id, sessionId));

    // Try to fetch the recording URL right away (may not be ready yet)
    let recordingUrl: string | undefined;
    if (session.cfAppId) {
      try {
        const recordings = await getRecordings(c.env, session.cfAppId);
        const latest = recordings.find((r: any) => r.download_url);
        if (latest?.download_url) {
          recordingUrl = latest.download_url;
          await db
            .update(t)
            .set({ recordingUrl, updatedAt: new Date() })
            .where(eq(t.id, sessionId));
        }
      } catch (e) {
        console.error('[app-api/meeting-sessions] recording URL not ready yet:', e);
      }
    }

    return success(c, { ok: true, recordingUrl });
  } catch (err) {
    console.error('[app-api/meeting-sessions] recording/stop failed:', err);
    return error.internal(c, 'Failed to stop recording');
  }
});

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
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

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
  const data = c.req.valid('json') as Record<string, any>;
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
  const data = c.req.valid('json') as Record<string, any>;
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
