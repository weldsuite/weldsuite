/**
 * Meeting routes — flat /api/meetings/* surface backed by `meetings`.
 *
 * Permissions: meetings:read | meetings:create | meetings:update | meetings:delete.
 *   meetings:scope:all elevates from own-only default to cross-organizer access.
 *
 * Action endpoints (static paths registered BEFORE /:id):
 *   GET  /upcoming          — upcoming meetings for the current user
 *   GET  /recordings        — sessions with a recording URL or pending key
 *   GET  /join/:joinCode    — resolve meeting by join code
 *   POST /start-instant     — create + start + join in a single round-trip
 *   GET  /:id/recording              — recording URL (202 while still processing)
 *   POST /:id/recording/transcribe   — trigger transcription
 *   GET  /:id/recording/transcription        — full transcription + segments
 *   GET  /:id/recording/transcription-status — poll transcription status
 *   PATCH /:id/cancel                — cancel meeting (sendNotification=true)
 */

import { Hono } from 'hono';
import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import {
  ensurePermissionsResolved,
  requirePermission,
} from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import { createMeetingSchema, updateMeetingSchema } from '@weldsuite/core-api-client/schemas/meetings';
import { hostControlsSchema, DEFAULT_HOST_CONTROLS } from '@weldsuite/core-api-client/schemas/weldmeet';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '../../db';
import { getRecordings } from '@weldsuite/cloudflare-realtime';
import { startInstantMeeting } from '../../services/weldmeet/start-instant';
import { publishMeetingUpdated } from '../../services/realtime/weldmeet-publisher';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.meetings;

// In-call host-control policy fields. Nullable in Postgres, so a fully
// resolved view falls back to DEFAULT_HOST_CONTROLS field-by-field.
const HOST_CONTROL_KEYS = [
  'hostManagement',
  'allowScreenShare',
  'allowMicrophone',
  'allowVideo',
  'allowHandRaise',
  'allowReactions',
  'allowAnnotations',
  'allowVirtualBackgrounds',
  'allowParticipantRecord',
  'allowThirdPartyAccess',
  'noiseCancellation',
  'enableCaptions',
  'autoRecord',
  'hostMustJoinFirst',
  'lockAfterStart',
  'autoEndOnInactivity',
  'autoEndInactivityMinutes',
] as const;

function projectHostControls(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of HOST_CONTROL_KEYS) {
    const v = row[key];
    out[key] = v === null || v === undefined ? (DEFAULT_HOST_CONTROLS as unknown as Record<string, unknown>)[key] : v;
  }
  return out;
}

async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  const resolved = await ensurePermissionsResolved(c);
  const perms = resolved?.permissions ?? [];
  if (hasPermission(perms, 'meetings:scope:all')) return undefined;
  return c.get('userId');
}

const MEETING_DENIED = 'You do not have access to this meeting';

/**
 * Resolve a meeting by id and apply the same organizer scope as scopeFor():
 * own-only unless the caller holds meetings:scope:all. For recording/
 * transcription sub-resources that query meeting_sessions rather than joining
 * the meetings row, so they don't bypass the organizer boundary.
 */
async function canAccessMeetingById(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  meetingId: string,
): Promise<'ok' | 'denied' | 'not-found'> {
  const db = c.get('tenantDb');
  const scope = await scopeFor(c);
  const [m] = await db
    .select({ organizerId: t.organizerId })
    .from(t)
    .where(and(eq(t.id, meetingId), isNull(t.deletedAt)))
    .limit(1);
  if (!m) return 'not-found';
  if (scope && m.organizerId !== scope) return 'denied';
  return 'ok';
}

app.get('/', requirePermission('meetings:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);
  const scope = await scopeFor(c);

  const conditions: any[] = [isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.organizerId, scope));
  if (q.search) {
    conditions.push(like(t.title, `%${q.search}%`));
  }
  if (q.status !== undefined && q.status !== '') {
    const statuses = q.status.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length === 1) conditions.push(eq(t.status, statuses[0]));
    else if (statuses.length > 1) conditions.push(inArray(t.status, statuses));
  }
  // Filter by a CRM counterparty (Company or Person). We look inside the
  // `attendees` JSONB array for any element whose `counterpartyId` matches.
  // Uses Postgres' `@>` containment operator, which can use a GIN index if
  // one is added later.
  if (q.counterpartyId !== undefined && q.counterpartyId !== '') {
    const needle = JSON.stringify([{ counterpartyId: q.counterpartyId }]);
    conditions.push(sql`${t.attendees} @> ${needle}::jsonb`);
  }
  // Match meetings where the given Person is an attendee — used by the
  // person panel. Matches on `personId` (canonical) OR `contactId` (legacy
  // back-reference) so meetings created before the Companies/People
  // migration still surface.
  if (q.personId !== undefined && q.personId !== '') {
    const byPerson = JSON.stringify([{ personId: q.personId }]);
    const byContact = JSON.stringify([{ contactId: q.personId }]);
    conditions.push(
      sql`(${t.attendees} @> ${byPerson}::jsonb OR ${t.attendees} @> ${byContact}::jsonb)`,
    );
  }
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
    console.error('[app-api/meetings] list failed:', err);
    return error.internal(c, 'Failed to list meetings');
  }
});

// ============================================================================
// Action endpoints — static paths registered BEFORE /:id
// ============================================================================

/**
 * GET /upcoming - Upcoming meetings for the current user (?days=7&limit=20)
 */
app.get('/upcoming', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const userId = c.get('userId');
  const days = Number(c.req.query('days') ?? '7');
  const limit = Math.min(Number(c.req.query('limit') ?? '20'), 100);

  try {
    const db = c.get('tenantDb');

    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    const rows = await db
      .select()
      .from(t)
      .where(
        and(
          isNull(t.deletedAt),
          or(eq(t.status, 'scheduled'), eq(t.status, 'in_progress')),
          or(
            eq(t.organizerId, userId),
            sql`${t.attendees}::jsonb @> ${JSON.stringify([{ userId }])}::jsonb`,
          ),
          sql`${t.scheduledStart} >= ${now.toISOString()}`,
          sql`${t.scheduledStart} <= ${future.toISOString()}`,
        ),
      )
      .orderBy(t.scheduledStart)
      .limit(limit);

    return success(c, rows);
  } catch (err) {
    console.error('[app-api/meetings] upcoming failed:', err);
    return error.internal(c, 'Failed to list upcoming meetings');
  }
});

/**
 * GET /recordings - List sessions with a recording URL or pending key.
 * For rows with recordingKey but no recordingUrl, attempts to resolve
 * the URL from Cloudflare RealtimeKit and persists it.
 */
app.get('/recordings', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  try {
    const db = c.get('tenantDb');
    const { meetingSessions } = schema;
    const scope = await scopeFor(c);

    const rows = await db
      .select({
        sessionId: meetingSessions.id,
        meetingId: meetingSessions.meetingId,
        recordingUrl: meetingSessions.recordingUrl,
        recordingKey: meetingSessions.recordingKey,
        cfAppId: meetingSessions.cfAppId,
        startedAt: meetingSessions.startedAt,
        endedAt: meetingSessions.endedAt,
        duration: meetingSessions.duration,
        maxParticipants: meetingSessions.maxParticipants,
        meetingTitle: t.title,
        meetingType: t.meetingType,
      })
      .from(meetingSessions)
      .innerJoin(t, eq(meetingSessions.meetingId, t.id))
      .where(
        and(
          or(
            sql`${meetingSessions.recordingUrl} IS NOT NULL`,
            sql`${meetingSessions.recordingKey} IS NOT NULL`,
          ),
          isNull(t.deletedAt),
          // Organizer scope: own recordings only unless meetings:scope:all.
          scope ? eq(t.organizerId, scope) : undefined,
        ),
      )
      .orderBy(desc(meetingSessions.startedAt))
      .limit(50);

    // For sessions with a recordingKey but no recordingUrl, try to resolve
    for (const row of rows) {
      if (!row.recordingUrl && row.recordingKey) {
        try {
          const rtkId = row.cfAppId ?? row.recordingKey;
          const recs = await getRecordings(c.env, rtkId);
          const found = recs.find((r: any) => r.download_url);
          if (found?.download_url) {
            (row as any).recordingUrl = found.download_url;
            await db
              .update(meetingSessions)
              .set({ recordingUrl: found.download_url, updatedAt: new Date() })
              .where(eq(meetingSessions.id, row.sessionId));
          }
        } catch { /* recording may still be processing */ }
      }
    }

    return success(c, rows);
  } catch (err) {
    console.error('[app-api/meetings] recordings failed:', err);
    return error.internal(c, 'Failed to list recordings');
  }
});

/**
 * GET /join/:joinCode - Resolve meeting by join code
 */
app.get('/join/:joinCode', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const joinCode = c.req.param('joinCode');

  try {
    const db = c.get('tenantDb');
    const [meeting] = await db
      .select()
      .from(t)
      .where(and(eq(t.joinCode, joinCode), isNull(t.deletedAt)))
      .limit(1);

    if (!meeting) return error.notFound(c, 'Meeting');

    return success(c, meeting);
  } catch (err) {
    console.error('[app-api/meetings] join lookup failed:', err);
    return error.internal(c, 'Failed to resolve join code');
  }
});

/**
 * POST /start-instant - Create + start + join in a single round-trip.
 *
 * Body: { title?, meetingType?, accessType?, waitingRoom? }
 */
app.post(
  '/start-instant',
  requirePermission('meetings:create'),
  zValidator(
    'json',
    z.object({
      title: z.string().max(255).optional(),
      meetingType: z.enum(['video', 'audio']).optional(),
      accessType: z
        .enum(['workspace', 'invited_only', 'anyone_with_link'])
        .optional(),
      waitingRoom: z.boolean().optional(),
    }),
  ),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);

    const userId = c.get('userId');
    const input = c.req.valid('json');

    try {
      const db = c.get('tenantDb');
      const { workspaceMembers } = schema;

      const [member] = await db
        .select({ name: workspaceMembers.name, email: workspaceMembers.email, picture: workspaceMembers.picture })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .limit(1);

      const result = await startInstantMeeting(db, c.env, c.executionCtx, {
        userId,
        orgId,
        user: {
          name: member?.name ?? 'Unknown',
          email: member?.email ?? undefined,
          picture: member?.picture ?? undefined,
        },
        input,
      });

      console.log('[app-api/meetings] start-instant timings', result.timings);

      publishEntityEvent({
        c,
        entityType: 'meeting',
        entityId: result.meetingId,
        action: 'created',
        data: { id: result.meetingId, title: input.title ?? 'Instant Meeting', status: 'in_progress', hostId: userId },
      });

      return success(c, result, 201);
    } catch (err) {
      console.error('[app-api/meetings] start-instant failed:', err);
      return error.internal(c, 'Failed to start instant meeting');
    }
  },
);

// ============================================================================
// Sub-resource action endpoints for /:id — registered BEFORE the generic
// /:id handler so they are not captured by the param route.
// ============================================================================

/**
 * PATCH /:id/cancel - Cancel meeting
 * ?sendNotification=true  — send cancellation emails to attendees
 */
app.patch('/:id/cancel', requirePermission('meetings:update'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const id = c.req.param('id');
  const sendNotification = c.req.query('sendNotification') === 'true';

  try {
    const db = c.get('tenantDb');

    const [existing] = await db
      .select()
      .from(t)
      .where(and(eq(t.id, id), isNull(t.deletedAt)))
      .limit(1);

    if (!existing) return error.notFound(c, 'Meeting', id);
    {
      const scope = await scopeFor(c);
      if (scope && existing.organizerId !== scope) return error.forbidden(c, MEETING_DENIED);
    }
    if (existing.status === 'cancelled') {
      return error.badRequest(c, 'Meeting is already cancelled');
    }

    await db
      .update(t)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(t.id, id));

    try {
      if (orgId) {
        await publishMeetingUpdated(c.env, orgId, { meetingId: id, status: 'cancelled' });
      }
    } catch (e) {
      console.error('[app-api/meetings] cancel realtime publish failed:', e);
    }

    publishEntityEvent({
      c,
      entityType: 'meeting',
      entityId: id,
      action: 'updated',
      data: { id, title: existing.title, status: 'cancelled', hostId: existing.organizerId },
    });

    // Email notifications are a best-effort, non-blocking side effect.
    // The full email logic from api-worker/meetings.ts is omitted here:
    // the frontend controls sendNotification; the WeldMail / transactional-email
    // wiring belongs in the weldmail domain (delegate). Log a note if requested.
    if (sendNotification) {
      console.log('[app-api/meetings] cancel sendNotification requested — email dispatch is handled by WeldMail');
    }

    return success(c, { ok: true });
  } catch (err) {
    console.error('[app-api/meetings] cancel failed:', err);
    return error.internal(c, 'Failed to cancel meeting');
  }
});

/**
 * GET /:id/recording - Recording URL for a meeting.
 * Returns 202 with processing indicator when the URL is not yet ready.
 */
app.get('/:id/recording', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const meetingId = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const access = await canAccessMeetingById(c, meetingId);
    if (access === 'not-found') return error.notFound(c, 'Meeting', meetingId);
    if (access === 'denied') return error.forbidden(c, MEETING_DENIED);
    const { meetingSessions } = schema;

    // Find the latest ended session with a recording (URL or pending key)
    const [session] = await db
      .select({
        id: meetingSessions.id,
        recordingUrl: meetingSessions.recordingUrl,
        recordingKey: meetingSessions.recordingKey,
        cfAppId: meetingSessions.cfAppId,
        duration: meetingSessions.duration,
      })
      .from(meetingSessions)
      .where(
        and(
          eq(meetingSessions.meetingId, meetingId),
          eq(meetingSessions.status, 'ended'),
          or(
            sql`${meetingSessions.recordingUrl} IS NOT NULL`,
            sql`${meetingSessions.recordingKey} IS NOT NULL`,
          ),
        ),
      )
      .orderBy(desc(meetingSessions.createdAt))
      .limit(1);

    if (!session) return error.notFound(c, 'Recording');

    if (session.recordingUrl) {
      return success(c, {
        url: session.recordingUrl,
        sessionId: session.id,
        duration: session.duration,
      });
    }

    // URL not ready — try to fetch from Cloudflare
    const cfId = session.recordingKey || session.cfAppId;
    if (!cfId) return error.notFound(c, 'Recording');

    try {
      const recordings = await getRecordings(c.env, cfId);
      const latest = recordings.find((r: any) => r.download_url);
      if (latest?.download_url) {
        await db
          .update(meetingSessions)
          .set({ recordingUrl: latest.download_url, updatedAt: new Date() })
          .where(eq(meetingSessions.id, session.id));
        return success(c, {
          url: latest.download_url,
          sessionId: session.id,
          duration: session.duration,
        });
      }
    } catch (e) {
      console.error('[app-api/meetings] CF recording fetch failed:', e);
    }

    // Recording still processing
    return c.json({ data: null, processing: true }, 202);
  } catch (err) {
    console.error('[app-api/meetings] recording get failed:', err);
    return error.internal(c, 'Failed to get recording URL');
  }
});

/**
 * POST /:id/recording/transcribe - Trigger transcription for a meeting recording
 */
app.post('/:id/recording/transcribe', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const meetingId = c.req.param('id');
  let body: { language?: string } = {};
  try { body = await c.req.json(); } catch { /* no body is fine */ }

  const DEFAULT_TRANSCRIPTION_CREDIT_RATE = 2; // credits per minute

  try {
    const db = c.get('tenantDb');
    const access = await canAccessMeetingById(c, meetingId);
    if (access === 'not-found') return error.notFound(c, 'Meeting', meetingId);
    if (access === 'denied') return error.forbidden(c, MEETING_DENIED);
    const { meetingSessions, crmTranscriptions, crmTranscriptSegments } = schema;

    // Find the latest ended session with a recording URL
    const [session] = await db
      .select({
        id: meetingSessions.id,
        recordingUrl: meetingSessions.recordingUrl,
        recordingKey: meetingSessions.recordingKey,
        cfAppId: meetingSessions.cfAppId,
        duration: meetingSessions.duration,
      })
      .from(meetingSessions)
      .where(
        and(
          eq(meetingSessions.meetingId, meetingId),
          eq(meetingSessions.status, 'ended'),
          or(
            sql`${meetingSessions.recordingUrl} IS NOT NULL`,
            sql`${meetingSessions.recordingKey} IS NOT NULL`,
          ),
        ),
      )
      .orderBy(desc(meetingSessions.createdAt))
      .limit(1);

    if (!session?.recordingUrl) {
      return error.badRequest(c, 'No recording found for this meeting');
    }

    // Check if transcription already exists (keyed by meetingId as activityId)
    const [existing] = await db
      .select({ id: crmTranscriptions.id, status: crmTranscriptions.status })
      .from(crmTranscriptions)
      .where(eq(crmTranscriptions.activityId, meetingId))
      .limit(1);

    if (existing && existing.status !== 'failed') {
      return success(c, {
        id: existing.id,
        message: 'Transcription already exists or is in progress',
      });
    }

    // Delete a previous failed attempt and retry
    if (existing && existing.status === 'failed') {
      await db
        .delete(crmTranscriptSegments)
        .where(eq(crmTranscriptSegments.transcriptionId, existing.id));
      await db
        .delete(crmTranscriptions)
        .where(eq(crmTranscriptions.id, existing.id));
    }

    const transcriptionId = generateId('trans');
    const now = new Date();

    await db.insert(crmTranscriptions).values({
      id: transcriptionId,
      activityId: meetingId,
      status: 'pending',
      language: body.language || 'en',
      createdAt: now,
      updatedAt: now,
    });

    // Derive R2 file key from the public URL
    const r2PublicUrl = c.env.R2_PUBLIC_URL || 'https://weldsuite-storage-test.weldsuite.org';
    const fileKey = session.recordingUrl.startsWith(r2PublicUrl)
      ? session.recordingUrl.slice(r2PublicUrl.length + 1)
      : undefined;

    const estimatedMinutes = session.duration ? Math.ceil(session.duration / 60) : 5;

    // Dispatch the TRANSCRIBE_RECORDING Cloudflare Workflow (hosted in this
    // worker under the transcribe-recording-v2* names since W4).
    // The binding is guarded — if not present in this worker, log a warning.
    const transcribeWorkflow = (c.env as any).TRANSCRIBE_RECORDING as Workflow | undefined;
    if (!transcribeWorkflow) {
      console.warn('[app-api/meetings] TRANSCRIBE_RECORDING binding not configured — skipping workflow dispatch');
    } else {
      await transcribeWorkflow.create({
        id: transcriptionId,
        params: {
          transcriptionId,
          fileKey,
          fileUrl: fileKey ? undefined : session.recordingUrl,
          language: body.language,
          estimatedMinutes,
          creditRate: DEFAULT_TRANSCRIPTION_CREDIT_RATE,
          entityId: meetingId,
          workspaceId: orgId,
        },
      });
    }

    return success(c, { id: transcriptionId, status: 'pending' }, 201);
  } catch (err) {
    console.error('[app-api/meetings] transcribe failed:', err);
    return error.internal(c, 'Failed to trigger transcription');
  }
});

/**
 * GET /:id/recording/transcription - Get full transcription with segments
 */
app.get('/:id/recording/transcription', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const meetingId = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const access = await canAccessMeetingById(c, meetingId);
    if (access === 'not-found') return error.notFound(c, 'Meeting', meetingId);
    if (access === 'denied') return error.forbidden(c, MEETING_DENIED);
    const { crmTranscriptions, crmTranscriptSegments } = schema;

    const [transcription] = await db
      .select()
      .from(crmTranscriptions)
      .where(eq(crmTranscriptions.activityId, meetingId))
      .limit(1);

    if (!transcription) return error.notFound(c, 'Transcription');

    const segments = await db
      .select()
      .from(crmTranscriptSegments)
      .where(eq(crmTranscriptSegments.transcriptionId, transcription.id))
      .orderBy(asc(crmTranscriptSegments.sequenceNumber));

    return success(c, {
      ...transcription,
      segments: segments.map((seg) => ({
        ...seg,
        start: seg.startTime,
        end: seg.endTime,
        speaker: seg.speakerLabel,
      })),
    });
  } catch (err) {
    console.error('[app-api/meetings] transcription get failed:', err);
    return error.internal(c, 'Failed to fetch transcription');
  }
});

/**
 * GET /:id/recording/transcription-status - Poll transcription status
 */
app.get('/:id/recording/transcription-status', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const meetingId = c.req.param('id');

  try {
    const db = c.get('tenantDb');
    const access = await canAccessMeetingById(c, meetingId);
    if (access === 'not-found') return error.notFound(c, 'Meeting', meetingId);
    if (access === 'denied') return error.forbidden(c, MEETING_DENIED);
    const { crmTranscriptions } = schema;

    const [transcription] = await db
      .select({
        id: crmTranscriptions.id,
        status: crmTranscriptions.status,
        errorMessage: crmTranscriptions.errorMessage,
        processingStartedAt: crmTranscriptions.processingStartedAt,
        processingCompletedAt: crmTranscriptions.processingCompletedAt,
        wordCount: crmTranscriptions.wordCount,
        speakerCount: crmTranscriptions.speakerCount,
      })
      .from(crmTranscriptions)
      .where(eq(crmTranscriptions.activityId, meetingId))
      .limit(1);

    if (!transcription) {
      return success(c, { exists: false });
    }

    return success(c, { exists: true, ...transcription });
  } catch (err) {
    console.error('[app-api/meetings] transcription-status failed:', err);
    return error.internal(c, 'Failed to fetch transcription status');
  }
});

// ============================================================================
// CRUD — /:id and sub-resources below
// ============================================================================

app.get('/:id', requirePermission('meetings:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.organizerId, scope));
  try {
    const [row] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!row) return error.notFound(c, 'Meeting', id);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/meetings] get failed:', err);
    return error.internal(c, 'Failed to fetch meeting');
  }
});

app.post('/', requirePermission('meetings:create'), zValidator('json', createMeetingSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json') as Record<string, any>;
  const userId = c.get('userId');
  const id = generateId('mtg');
  const now = new Date();
  // `organizerId` is NOT NULL at the DB; default to the caller when the
  // body doesn't pass one.
  const organizerId =
    typeof data.organizerId === 'string' && data.organizerId.length > 0
      ? data.organizerId
      : userId;
  // Waiting room defaults ON for every newly created meeting — guests joining
  // via the share link land in the lobby and the host admits them. Callers can
  // still opt out by explicitly passing `waitingRoom: false`.
  const waitingRoom = typeof data.waitingRoom === 'boolean' ? data.waitingRoom : true;
  try {
    await db.insert(t).values({ id, ...data, waitingRoom, organizerId, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'meeting',
      entityId: id,
      action: 'created',
      data: { id, title: data.title, status: data.status, hostId: organizerId },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/meetings] create failed:', err);
    return error.internal(c, 'Failed to create meeting');
  }
});

app.patch('/:id', requirePermission('meetings:update'), zValidator('json', updateMeetingSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.organizerId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Meeting', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'meeting',
      entityId: id,
      action: 'updated',
      data: {
        id,
        title: (update.title as string | null | undefined) ?? existing.title,
        status: (update.status as string | null | undefined) ?? existing.status,
        hostId: existing.organizerId,
      },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/meetings] update failed:', err);
    return error.internal(c, 'Failed to update meeting');
  }
});

// ============================================================================
// PATCH /:id/host-controls — in-call host controls (organizer-only).
//
// Ported from apps/core-api/src/routes/weldmeet/host-controls.ts. Distinct
// from PATCH /:id so the organizer can flip in-meeting policy mid-call WITHOUT
// holding the broader `meetings:update` permission. We gate on `meetings:read`
// (any meeting participant can read) and then enforce organizer ownership.
// Registered before DELETE /:id; the two-segment path never collides with
// PATCH /:id (single segment).
//
// NOTE: this handler keeps its own hard organizer check (existing.organizerId
// === userId) and intentionally does NOT use scopeFor() — the organizer
// identity check is an in-call security boundary, not a visibility scope.
// ============================================================================

app.patch(
  '/:id/host-controls',
  requirePermission('meetings:read'),
  zValidator('json', hostControlsSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const input = c.req.valid('json') as Record<string, unknown>;

    try {
      const [existing] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Meeting', id);

      // Only the organizer can change host controls on their meeting.
      if (existing.organizerId !== userId) {
        return error.forbidden(c, 'Only the meeting organizer can change host controls');
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      for (const key of HOST_CONTROL_KEYS) {
        if (input[key] !== undefined) updates[key] = input[key];
      }
      await db.update(t).set(updates).where(eq(t.id, id));

      const [after] = await db.select().from(t).where(eq(t.id, id)).limit(1);
      const controls = projectHostControls(after as Record<string, unknown>);

      publishEntityEvent({
        c,
        entityType: 'meeting',
        entityId: id,
        action: 'updated',
        data: { id, title: existing.title, status: existing.status, hostId: existing.organizerId },
      });

      return success(c, controls);
    } catch (err) {
      console.error('[app-api/meetings] host-controls update failed:', err);
      return error.internal(c, 'Failed to update host controls');
    }
  },
);

app.delete('/:id', requirePermission('meetings:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.organizerId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Meeting', id);
    await db.update(t).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'meeting',
      entityId: id,
      action: 'deleted',
      data: { id, title: existing.title, status: existing.status },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/meetings] delete failed:', err);
    return error.internal(c, 'Failed to delete meeting');
  }
});

export const meetingsRoutes = app;
