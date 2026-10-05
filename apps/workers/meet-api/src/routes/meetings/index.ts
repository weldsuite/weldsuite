/**
 * Meeting routes — flat /api/meetings/* surface backed by `meetings`.
 *
 * Permissions: meetings:read | meetings:create | meetings:update | meetings:delete.
 *   meetings:scope:all elevates from own-only default to cross-organizer access.
 *
 * Action endpoints (static paths registered BEFORE /:id):
 *   GET  /upcoming          — upcoming meetings for the current user
 *   GET  /recordings        — recorded sessions (state only, never file URLs)
 *   GET  /ai-pricing        — credits per meeting minute (transcript, summary) + balance
 *   GET  /join/:joinCode    — resolve meeting by join code
 *   POST /start-instant     — create + start + join in a single round-trip
 *   GET  /:id/recording              — ALIAS: latest recorded session's state + fresh tokenized URLs
 *   POST /:id/recording/transcribe   — ALIAS: Whisper over the latest recorded session (sessions:update)
 *   GET  /:id/recording/transcription        — ALIAS: session transcript, legacy meeting-keyed fallback
 *   GET  /:id/recording/transcription-status — ALIAS: poll transcription status
 *   PATCH /:id/cancel                — cancel meeting (sendNotification=true)
 *
 * The per-meeting recording routes are thin aliases for the session-scoped ones
 * in meeting-sessions (services/weldmeet/session-recording.ts is the source of
 * truth); they resolve the meeting's latest session that has recorder state.
 */

import { Hono } from 'hono';
import { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, inArray, isNotNull, isNull, like, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  hasContextPermission,
  requirePermission,
} from '@weldsuite/permissions/server';
import {
  createMeetingSchema,
  inviteMeetingAttendeesSchema,
  updateMeetingSchema,
  type CreateMeetingInput,
  type MeetingAttendeeWriteInput,
  type UpdateMeetingInput,
} from '@weldsuite/core-api-client/schemas/meetings';
import { hostControlsSchema, DEFAULT_HOST_CONTROLS } from '@weldsuite/core-api-client/schemas/weldmeet';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import {
  MeetingBillingUnavailableError,
  getMeetingAiPricing,
  getMeetingBalance,
  resolveMeetingMetering,
} from '@weldsuite/meet-domain/billing';
import { findSessionTranscription } from '@weldsuite/meet-domain/transcript-store';
import { transcribeRecordingSchema } from '@weldsuite/app-api-client/schemas/weldmeet-recordings';
import {
  authorizeSession,
  buildRecordingInfo,
  buildTranscriptionPayload,
  buildTranscriptionStatus,
  findLatestRecordedSession,
  isResponse,
  mintRecordingAccess,
  transcribeRecording,
} from '../../services/weldmeet/session-recording';
import { reconcileRecordingFromRtk } from '../../services/weldmeet/recording-reconcile';
import { startInstantMeeting } from '../../services/weldmeet/start-instant';
import { generateJoinCode } from '../../services/weldmeet/join-code';
import { publishMeetingUpdated } from '../../services/realtime/weldmeet-publisher';
import { resolveParticipantLink } from '../../lib/participant-resolver';
import {
  buildMeetingJoinUrl,
  getMeetingPortalUrl,
  mergeInvitees,
  normalizeInvitees,
  sendInvitationEmail,
  toMeetingAttendees,
  type ResolvedInvitee,
} from '../../services/weldmeet/invitations';
import type { MeetingAttendee } from '@weldsuite/db/schema/meetings';

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
  if (await hasContextPermission(c, 'meetings:scope:all')) return undefined;
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

function buildListFilters(q: Record<string, string>, scope: string | undefined): SQL[] {
  const conditions: SQL[] = [isNull(t.deletedAt)];
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
  const view = viewCondition(q.view);
  if (view) conditions.push(view);
  return conditions;
}

/**
 * `?view=` presets for the platform's Upcoming / History pages.
 *
 * upcoming: not finished yet. Running meetings always count; a scheduled one
 *   counts until its end (or start + 1h without an end); unscheduled "for
 *   later" rooms never expire.
 * history: finished, failed or cancelled meetings, plus any meeting that has
 *   an ended session. Instant and "for later" meetings go back to 'scheduled'
 *   when their session ends so the link stays reusable, so the session is
 *   what puts them in the history.
 */
function viewCondition(view: string | undefined): SQL | undefined {
  if (view === 'upcoming') {
    return sql`(${t.status} IN ('scheduled', 'in_progress') AND (${t.status} = 'in_progress' OR ${t.scheduledStart} IS NULL OR coalesce(${t.scheduledEnd}, ${t.scheduledStart} + interval '1 hour') >= (now() AT TIME ZONE 'utc')))`;
  }
  if (view === 'history') {
    return sql`(${t.status} IN ('completed', 'failed', 'cancelled') OR EXISTS (SELECT 1 FROM meeting_sessions ms WHERE ms.meeting_id = ${t.id} AND ms.status = 'ended'))`;
  }
  return undefined;
}

type MeetingRow = typeof t.$inferSelect;

interface MeetingOrganizer {
  userId: string;
  name: string;
  avatar: string | null;
}

interface MeetingLastSession {
  id: string;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  /** Seconds. */
  duration: number | null;
  recordingStatus: string | null;
  participants: Array<{
    userId: string;
    userName: string;
    userAvatar?: string;
    joinedAt: string;
    leftAt?: string;
    firstJoinedAt?: string;
    priorSeconds?: number;
    stints?: number;
  }>;
}

/** Workspace members by user id, for the `organizer` on every list item (one query). */
async function loadOrganizers(
  db: Database,
  organizerIds: string[],
): Promise<Map<string, MeetingOrganizer>> {
  const out = new Map<string, MeetingOrganizer>();
  if (organizerIds.length === 0) return out;
  const { workspaceMembers } = schema;
  const members = await db
    .select({
      userId: workspaceMembers.userId,
      name: workspaceMembers.name,
      email: workspaceMembers.email,
      avatar: workspaceMembers.picture,
    })
    .from(workspaceMembers)
    .where(inArray(workspaceMembers.userId, organizerIds));
  for (const m of members) {
    if (!out.has(m.userId)) {
      out.set(m.userId, { userId: m.userId, name: m.name || m.email || '', avatar: m.avatar ?? null });
    }
  }
  return out;
}

/** The newest session (by createdAt) of each meeting, in one query. */
async function loadLastSessions(
  db: Database,
  meetingIds: string[],
): Promise<Map<string, MeetingLastSession>> {
  const out = new Map<string, MeetingLastSession>();
  if (meetingIds.length === 0) return out;
  const { meetingSessions } = schema;
  const rows = await db
    .selectDistinctOn([meetingSessions.meetingId], {
      meetingId: meetingSessions.meetingId,
      id: meetingSessions.id,
      status: meetingSessions.status,
      startedAt: meetingSessions.startedAt,
      endedAt: meetingSessions.endedAt,
      duration: meetingSessions.duration,
      recordingStatus: meetingSessions.recordingStatus,
      participants: meetingSessions.participants,
    })
    .from(meetingSessions)
    .where(inArray(meetingSessions.meetingId, meetingIds))
    .orderBy(meetingSessions.meetingId, desc(meetingSessions.createdAt), desc(meetingSessions.id));
  for (const r of rows) {
    out.set(r.meetingId, {
      id: r.id,
      status: r.status,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      duration: r.duration,
      recordingStatus: r.recordingStatus,
      participants: (r.participants ?? []).map((p) => ({
        userId: p.userId,
        userName: p.userName,
        userAvatar: p.userAvatar,
        joinedAt: p.joinedAt,
        leftAt: p.leftAt,
        firstJoinedAt: p.firstJoinedAt,
        priorSeconds: p.priorSeconds,
        stints: p.stints,
      })),
    });
  }
  return out;
}

/** List items: the meeting row plus `organizer` and, with `?include=lastSession`, `lastSession`. */
async function decorateMeetings(db: Database, rows: MeetingRow[], include: Set<string>) {
  const [organizers, lastSessions] = await Promise.all([
    loadOrganizers(db, [...new Set(rows.map((r) => r.organizerId))]),
    include.has('lastSession')
      ? loadLastSessions(db, rows.map((r) => r.id))
      : Promise.resolve(null),
  ]);
  return rows.map((row) => ({
    ...row,
    organizer: organizers.get(row.organizerId) ?? null,
    ...(lastSessions ? { lastSession: lastSessions.get(row.id) ?? null } : {}),
  }));
}

app.get('/', requirePermission('meetings:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? Number.parseInt(q.limit, 10) : 25, 100);
  const scope = await scopeFor(c);

  const conditions = buildListFilters(q, scope);
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
    const include = new Set((q.include ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    const items = await decorateMeetings(db, data, include);
    return list(c, items, cursorPagination(totalCount, hasMore, nextCursor));
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
 * GET /recordings - Recorded sessions the caller may see (own meetings unless
 * meetings:scope:all), newest first. State only: no RealtimeKit calls and no
 * file URLs (`recordingUrl` is always null). Call
 * POST /meeting-sessions/:id/recording/access to play or download one.
 * Legacy rows that predate the recorder state (recordingStatus null) are still
 * listed until the backfill gives them a status.
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
        cfAppId: meetingSessions.cfAppId,
        recordingStatus: meetingSessions.recordingStatus,
        recordingAudioKey: meetingSessions.recordingAudioKey,
        recordingDurationSeconds: meetingSessions.recordingDurationSeconds,
        recordingSizeBytes: meetingSessions.recordingSizeBytes,
        summaryStatus: meetingSessions.summaryStatus,
        hasTranscript: sql<boolean>`EXISTS (SELECT 1 FROM crm_transcriptions ct WHERE ct.activity_id = ${meetingSessions.id} AND ct.status = 'completed')`,
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
            isNotNull(meetingSessions.recordingStatus),
            isNotNull(meetingSessions.recordingUrl),
            isNotNull(meetingSessions.recordingKey),
          ),
          or(isNull(meetingSessions.recordingStatus), ne(meetingSessions.recordingStatus, 'deleted')),
          isNull(t.deletedAt),
          // Organizer scope: own recordings only unless meetings:scope:all.
          scope ? eq(t.organizerId, scope) : undefined,
        ),
      )
      .orderBy(desc(meetingSessions.startedAt))
      .limit(50);

    return success(
      c,
      rows.map(({ recordingAudioKey, summaryStatus, ...row }) => ({
        ...row,
        recordingUrl: null,
        recordingKey: null,
        hasAudio: Boolean(recordingAudioKey),
        hasSummary: summaryStatus === 'completed',
      })),
    );
  } catch (err) {
    console.error('[meet-api/meetings] recordings failed:', err);
    return error.internal(c, 'Failed to list recordings');
  }
});

/**
 * GET /ai-pricing - Credits per MEETING MINUTE for a transcript and a summary
 * (master system_settings `weldmeet.ai_pricing`, defaults when unset) plus the
 * workspace balance, for the estimate in the start-recording dialog.
 */
app.get('/ai-pricing', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);
  try {
    const pricing = await getMeetingAiPricing(c.env);
    const metering = await resolveMeetingMetering(c.env, orgId, c.get('userId'));
    return success(c, { ...pricing, balance: await getMeetingBalance(metering) });
  } catch (err) {
    if (err instanceof MeetingBillingUnavailableError) {
      return error.unavailable(c, 'Credit metering is unavailable for this workspace');
    }
    console.error('[meet-api/meetings] ai-pricing failed:', err);
    return error.internal(c, 'Failed to load pricing');
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
 * POST /:id/invitations - Invite people to a meeting (TASK-717).
 *
 * Invitees are workspace members, CRM people or any email address. Each new
 * invitee is added to `attendees` (role attendee, status pending) and, unless
 * `sendEmail: false`, emailed the public join link (+ .ics when scheduled).
 * Re-inviting an existing attendee leaves them untouched.
 *
 * Allowed for the organizer, `meetings:scope:all` holders, and members who
 * are already an invited attendee (the in-room "Add people").
 */
app.post(
  '/:id/invitations',
  requirePermission('meetings:update'),
  zValidator('json', inviteMeetingAttendeesSchema),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);
    const db = c.get('tenantDb');
    const userId = c.get('userId');
    const id = c.req.param('id');
    const body = c.req.valid('json');

    try {
      const [existing] = await db
        .select()
        .from(t)
        .where(and(eq(t.id, id), isNull(t.deletedAt)))
        .limit(1);
      if (!existing) return error.notFound(c, 'Meeting', id);

      const currentAttendees = (existing.attendees ?? []) as MeetingAttendee[];
      const isInvitedMember = currentAttendees.some(
        (a) => a.userId === userId && a.source !== 'walk_in',
      );
      if (existing.organizerId !== userId && !isInvitedMember) {
        const scope = await scopeFor(c);
        if (scope) return error.forbidden(c, MEETING_DENIED);
      }
      if (existing.status === 'cancelled' || existing.status === 'completed') {
        return error.badRequest(c, 'Cannot invite people to a meeting that has ended or was cancelled');
      }
      if (!existing.joinCode) {
        return error.badRequest(c, 'Meeting has no join link');
      }

      const env = c.env;
      const invitees: ResolvedInvitee[] = [];
      for (const invitee of normalizeInvitees(body.invitees)) {
        const link = await resolveParticipantLink(db, env, orgId, {
          email: invitee.email,
          name: invitee.name,
        });
        let memberUserId = '';
        if (link.workspaceMemberId) {
          const [member] = await db
            .select({ userId: schema.workspaceMembers.userId })
            .from(schema.workspaceMembers)
            .where(eq(schema.workspaceMembers.id, link.workspaceMemberId))
            .limit(1);
          memberUserId = member?.userId ?? '';
        }
        invitees.push({
          email: invitee.email,
          name: link.displayName || invitee.name || invitee.email,
          userId: memberUserId,
          avatar: link.avatarUrl,
          workspaceMemberId: link.workspaceMemberId,
          personId: link.personId,
        });
      }

      const { attendees, added, alreadyInvited } = mergeInvitees(currentAttendees, invitees);

      if (added.length > 0) {
        await db
          .update(t)
          .set({ attendees, updatedAt: new Date() })
          .where(and(eq(t.id, id), isNull(t.deletedAt)));

        publishEntityEvent({
          c,
          entityType: 'meeting',
          entityId: id,
          action: 'updated',
          data: { id, title: existing.title, status: existing.status, hostId: existing.organizerId },
        });
        try {
          await publishMeetingUpdated(env, orgId, { meetingId: id, title: existing.title });
        } catch (e) {
          console.error('[meet-api/meetings] invitations realtime publish failed:', e);
        }
      }

      // Inviter (for the email copy) and organizer (for the .ics ORGANIZER),
      // plus the organizer's preferred timezone when it's on file.
      const people = await db
        .select({
          userId: schema.workspaceMembers.userId,
          name: schema.workspaceMembers.name,
          email: schema.workspaceMembers.email,
          timezone: schema.userPreferences.timezone,
        })
        .from(schema.workspaceMembers)
        .leftJoin(schema.userPreferences, eq(schema.userPreferences.userId, schema.workspaceMembers.userId))
        .where(inArray(schema.workspaceMembers.userId, [userId, existing.organizerId]));
      const inviter = people.find((p) => p.userId === userId);
      const organizer = people.find((p) => p.userId === existing.organizerId) ?? inviter;

      const joinUrl = buildMeetingJoinUrl(
        getMeetingPortalUrl(env.MEETING_PORTAL_URL),
        orgId,
        existing.joinCode,
      );
      const sendEmail = body.sendEmail !== false;
      const sent = await Promise.all(
        added.map((attendee) =>
          sendEmail
            ? sendInvitationEmail(env, {
                meeting: existing,
                organizer: {
                  name: inviter?.name || organizer?.name || 'Someone',
                  email: organizer?.email ?? '',
                  timezone: organizer?.timezone ?? undefined,
                },
                joinUrl,
                attendee: { email: attendee.email, name: attendee.name },
              })
            : Promise.resolve(false),
        ),
      );

      return success(c, {
        attendees,
        invited: added.map((a, i) => ({ email: a.email, name: a.name, emailSent: sent[i] })),
        alreadyInvited,
      });
    } catch (err) {
      console.error('[meet-api/meetings] invitations failed:', err);
      return error.internal(c, 'Failed to invite people');
    }
  },
);

/**
 * The latest session of a meeting that has recorder state, after the meeting-level
 * organizer check. Returns the Response to send when there is none / not allowed.
 * With `legacyOk`, a meeting without such a session yields null instead of a 404
 * (legacy meeting-keyed transcripts still resolve).
 */
async function resolveRecordedSession(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  meetingId: string,
  { legacyOk = false }: { legacyOk?: boolean } = {},
) {
  const access = await canAccessMeetingById(c, meetingId);
  if (access === 'not-found') return error.notFound(c, 'Meeting', meetingId);
  if (access === 'denied') return error.forbidden(c, MEETING_DENIED);
  const session = await findLatestRecordedSession(c.get('tenantDb'), meetingId);
  if (!session && !legacyOk) return error.notFound(c, 'Recording');
  return session;
}

/**
 * GET /:id/recording - ALIAS for the latest recorded session. The session's
 * recording state plus, once it is ready, fresh tokenized `url` / `audioUrl`
 * (valid until `expiresAt`; never store them). Not ready yet: `url` is null and
 * `status` says why (recording | processing | failed). A meeting that was never
 * recorded answers 200 with `data: null` (an unknown meeting is still 404, no
 * access 403), so "no recording" is not an error for the caller.
 */
app.get('/:id/recording', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const meetingId = c.req.param('id');
  try {
    const session = await resolveRecordedSession(c, meetingId, { legacyOk: true });
    if (session instanceof Response) return session;
    if (!session) return success(c, null);

    const auth = await authorizeSession(c, session.id);
    if (isResponse(auth)) return auth;
    // No webhook for a while: ask RealtimeKit directly (throttled).
    const current = await reconcileRecordingFromRtk(c.env, c.get('tenantDb'), orgId, auth.session);
    const info = await buildRecordingInfo(c.get('tenantDb'), current);

    let access: { url: string; audioUrl: string | null; expiresAt: string } | null = null;
    if (info.status === 'ready') {
      const minted = await mintRecordingAccess(c, { ...auth, session: current });
      if (minted instanceof Response) return minted;
      access = minted;
    }
    return success(c, {
      ...info,
      duration: session.duration,
      url: access?.url ?? null,
      audioUrl: access?.audioUrl ?? null,
      expiresAt: access?.expiresAt ?? null,
    });
  } catch (err) {
    console.error('[meet-api/meetings] recording get failed:', err);
    return error.internal(c, 'Failed to get recording');
  }
});

/**
 * POST /:id/recording/transcribe - ALIAS: Whisper over the latest recorded
 * session. Spends credits, so it needs sessions:update (not meetings:read).
 */
app.post(
  '/:id/recording/transcribe',
  requirePermission('sessions:update'),
  requirePermission('recordings:read'),
  async (c) => {
    const orgId = c.get('orgId');
    if (!orgId) return error.orgRequired(c);

    let body: unknown = {};
    try { body = await c.req.json(); } catch { /* no body is fine */ }
    const parsed = transcribeRecordingSchema.safeParse(body);
    if (!parsed.success) return error.badRequest(c, 'Invalid transcription options', parsed.error.flatten());

    try {
      const session = await resolveRecordedSession(c, c.req.param('id'));
      if (session instanceof Response) return session;
      if (!session) return error.notFound(c, 'Recording');
      return await transcribeRecording(c, session.id, parsed.data);
    } catch (err) {
      console.error('[meet-api/meetings] transcribe failed:', err);
      return error.internal(c, 'Failed to trigger transcription');
    }
  },
);

/**
 * The transcription row for a meeting: the latest recorded session's first, then
 * the legacy row keyed by meeting id (AssemblyAI era, read-only).
 */
async function findMeetingTranscription(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  meetingId: string,
  session: Awaited<ReturnType<typeof findLatestRecordedSession>>,
) {
  const db = c.get('tenantDb');
  if (session) {
    const own = await findSessionTranscription(db, session.id);
    if (own) return own;
  }
  return findSessionTranscription(db, meetingId);
}

/**
 * GET /:id/recording/transcription - ALIAS: full transcript + segments (and the
 * session summary when there is one).
 */
app.get('/:id/recording/transcription', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const meetingId = c.req.param('id');
  try {
    const session = await resolveRecordedSession(c, meetingId, { legacyOk: true });
    if (session instanceof Response) return session;
    const transcription = await findMeetingTranscription(c, meetingId, session);
    if (!transcription) return error.notFound(c, 'Transcription');
    return success(c, await buildTranscriptionPayload(c.get('tenantDb'), transcription, session));
  } catch (err) {
    console.error('[meet-api/meetings] transcription get failed:', err);
    return error.internal(c, 'Failed to fetch transcription');
  }
});

/**
 * GET /:id/recording/transcription-status - ALIAS: poll transcript + summary status.
 */
app.get('/:id/recording/transcription-status', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const meetingId = c.req.param('id');
  try {
    const session = await resolveRecordedSession(c, meetingId, { legacyOk: true });
    if (session instanceof Response) return session;
    const transcription = await findMeetingTranscription(c, meetingId, session);
    return success(c, buildTranscriptionStatus(transcription, session));
  } catch (err) {
    console.error('[meet-api/meetings] transcription-status failed:', err);
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

/** Fields the create / update schemas let a client write, converted to column values. */
type MeetingWritable = Partial<
  Pick<
    typeof t.$inferInsert,
    | 'title'
    | 'description'
    | 'meetingType'
    | 'accessType'
    | 'waitingRoom'
    | 'allowRecording'
    | 'maxParticipants'
    | 'attendees'
    | 'scheduledStart'
    | 'scheduledEnd'
    | 'calendarEventId'
    | 'isRecurring'
    | 'recurrenceRule'
    | 'tags'
  >
>;

/** ISO string to `Date`; `null` clears the column, `undefined` leaves it out. */
function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  return new Date(value);
}

const normalizeEmail = (email: string | undefined): string => (email ?? '').trim().toLowerCase();

/**
 * Turn the attendees a client sent into the stored shape. The client only
 * decides WHO is on the meeting (email) and the display bits (name, avatar,
 * RSVP status). Everything that grants identity or timeline access is
 * server-owned, because a session end logs a CRM activity on every attendee's
 * `personId` and `userId` / `source` / `role` feed access checks:
 *
 *  - an attendee already stored on the meeting (same email) keeps its stored
 *    userId, role, source and links, so the platform can PATCH the stored shape
 *    back without losing them;
 *  - a new attendee is resolved from the email (workspace member, else an
 *    existing or auto-created Person), never from client-supplied ids;
 *  - `role: 'organizer'` can never be asked for: it is only ever set by
 *    withOrganizerAttendee().
 */
async function resolveAttendeeWrites(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  db: Database,
  inputs: MeetingAttendeeWriteInput[],
  stored: MeetingAttendee[],
): Promise<MeetingAttendee[]> {
  const storedByEmail = new Map<string, MeetingAttendee>();
  for (const a of stored) storedByEmail.set(normalizeEmail(a.email), a);

  const seen = new Set<string>();
  const unique: MeetingAttendeeWriteInput[] = [];
  for (const input of inputs) {
    const email = normalizeEmail(input.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    unique.push(input);
  }

  const workspaceKey = c.get('orgId') ?? c.get('workspaceId') ?? '';
  const resolved = await Promise.all(
    unique.map(async (input): Promise<Partial<MeetingAttendee> & { email: string }> => {
      const email = normalizeEmail(input.email);
      const display = {
        ...(input.status ? { status: input.status } : {}),
      };
      const existing = storedByEmail.get(email);
      if (existing) {
        return {
          ...existing,
          ...(input.name ? { name: input.name } : {}),
          ...(input.avatar ? { avatar: input.avatar } : {}),
          ...display,
        };
      }
      const link = await resolveParticipantLink(db, c.env, workspaceKey, { email, name: input.name });
      const avatar = input.avatar || link.avatarUrl;
      return {
        email,
        name: input.name || link.displayName,
        ...(avatar ? { avatar } : {}),
        ...display,
        role: 'attendee',
        ...(link.workspaceMemberId ? { workspaceMemberId: link.workspaceMemberId } : {}),
        ...(link.personId ? { personId: link.personId } : {}),
      };
    }),
  );

  // Members carry their user id on the attendee (invited-member checks use it).
  const memberIds = [...new Set(resolved.map((a) => a.workspaceMemberId).filter((v): v is string => !!v))];
  if (memberIds.length > 0) {
    const members = await db
      .select({ id: schema.workspaceMembers.id, userId: schema.workspaceMembers.userId })
      .from(schema.workspaceMembers)
      .where(inArray(schema.workspaceMembers.id, memberIds));
    const userIdByMember = new Map(members.map((m) => [m.id, m.userId]));
    for (const a of resolved) {
      if (a.workspaceMemberId && a.userId === undefined) a.userId = userIdByMember.get(a.workspaceMemberId) ?? '';
    }
  }

  return toMeetingAttendees(resolved);
}

/**
 * The ONLY path from a request body to meeting columns. Builds the write set
 * field by field, so nothing a client adds to the JSON (id, status, deletedAt,
 * activeSessionId, joinCode, organizerId, host controls, ...) can reach the
 * insert / update, whatever the schema lets through. Absent keys stay absent so
 * PATCH leaves those columns alone. `attendees` are the already server-resolved
 * list (see resolveAttendeeWrites), never the client's.
 */
function pickWritableMeetingFields(
  data: CreateMeetingInput | UpdateMeetingInput,
  attendees: MeetingAttendee[] | undefined,
): MeetingWritable {
  const candidate: MeetingWritable = {
    title: data.title,
    description: data.description,
    meetingType: data.meetingType,
    accessType: data.accessType,
    waitingRoom: data.waitingRoom,
    allowRecording: data.allowRecording,
    maxParticipants: data.maxParticipants,
    attendees,
    scheduledStart: toDate(data.scheduledStart),
    scheduledEnd: toDate(data.scheduledEnd),
    calendarEventId: data.calendarEventId,
    isRecurring: data.isRecurring,
    recurrenceRule: data.recurrenceRule,
    tags: data.tags,
  };
  return Object.fromEntries(
    Object.entries(candidate).filter(([, value]) => value !== undefined),
  ) as MeetingWritable;
}

/**
 * Put the organizer first in the attendee list (role organizer, accepted) unless
 * they are already on it, resolved from workspace_members the way
 * start-instant does. Without a member row there is nothing to show, so the
 * list is left as sent.
 */
async function withOrganizerAttendee(
  db: Database,
  attendees: MeetingAttendee[],
  organizerId: string,
): Promise<MeetingAttendee[]> {
  const { workspaceMembers } = schema;
  const [member] = await db
    .select({
      id: workspaceMembers.id,
      name: workspaceMembers.name,
      email: workspaceMembers.email,
      picture: workspaceMembers.picture,
    })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, organizerId))
    .limit(1);
  if (!member) return attendees;

  const email = member.email?.trim().toLowerCase() ?? '';
  const isOrganizer = (a: MeetingAttendee) => a.userId === organizerId || (email !== '' && a.email === email);
  if (attendees.some(isOrganizer)) {
    // Clients cannot ask for role 'organizer'; it is granted here, by identity.
    return attendees.map((a) =>
      isOrganizer(a) ? { ...a, userId: organizerId, role: 'organizer' as const, status: 'accepted' as const } : a,
    );
  }

  const organizer: MeetingAttendee = {
    userId: organizerId,
    email,
    name: member.name || email || 'Organizer',
    status: 'accepted',
    role: 'organizer',
    workspaceMemberId: member.id,
    ...(member.picture ? { avatar: member.picture } : {}),
  };
  return [organizer, ...attendees];
}

app.post('/', requirePermission('meetings:create'), zValidator('json', createMeetingSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const userId = c.get('userId');
  const id = generateId('mtg');
  const now = new Date();
  // `organizerId` is NOT NULL at the DB. Creating on behalf of someone else is
  // for callers with meetings:scope:all only; everyone else organizes their own.
  let organizerId = userId;
  if (data.organizerId && data.organizerId !== userId && (await scopeFor(c)) === undefined) {
    // The organizer must be a member of this workspace, or the meeting would be
    // owned by (and its attendee list, CRM activities and host rights granted to)
    // an arbitrary user id.
    const [member] = await db
      .select({ id: schema.workspaceMembers.id })
      .from(schema.workspaceMembers)
      .where(eq(schema.workspaceMembers.userId, data.organizerId))
      .limit(1);
    if (!member) return error.badRequest(c, 'organizerId is not a member of this workspace');
    organizerId = data.organizerId;
  }
  // Waiting room defaults ON for every newly created meeting — guests joining
  // via the share link land in the lobby and the host admits them. Callers can
  // still opt out by explicitly passing `waitingRoom: false`.
  const waitingRoom = data.waitingRoom ?? true;
  // Every meeting needs a join code: it is the identifier in the public share
  // link (`<portal>/<workspace>/<joinCode>`). Generated server-side like the
  // start-instant path; a client-supplied value is not trusted.
  const joinCode = generateJoinCode();
  try {
    const resolvedAttendees = data.attendees ? await resolveAttendeeWrites(c, db, data.attendees, []) : undefined;
    const writable = pickWritableMeetingFields(data, resolvedAttendees);
    const attendees = await withOrganizerAttendee(db, writable.attendees ?? [], organizerId);
    // Server-owned values come last, so no client key can override them.
    await db.insert(t).values({
      ...writable,
      title: data.title,
      attendees,
      id,
      joinCode,
      waitingRoom,
      organizerId,
      createdAt: now,
      updatedAt: now,
    });
    publishEntityEvent({
      c,
      entityType: 'meeting',
      entityId: id,
      action: 'created',
      data: { id, title: data.title, status: 'scheduled', hostId: organizerId },
    });
    return success(c, { id, joinCode }, 201);
  } catch (err) {
    console.error('[app-api/meetings] create failed:', err);
    return error.internal(c, 'Failed to create meeting');
  }
});

app.patch('/:id', requirePermission('meetings:update'), zValidator('json', updateMeetingSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const scope = await scopeFor(c);
  const conditions: SQL[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.organizerId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Meeting', id);
    // Links on attendees are re-resolved server-side; ones already stored for the
    // same email are kept, so the platform can PATCH the stored shape back.
    const resolvedAttendees = data.attendees
      ? await resolveAttendeeWrites(c, db, data.attendees, (existing.attendees ?? []) as MeetingAttendee[])
      : undefined;
    const update = { ...pickWritableMeetingFields(data, resolvedAttendees), updatedAt: new Date() };
    await db.update(t).set(update).where(and(eq(t.id, id), isNull(t.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'meeting',
      entityId: id,
      action: 'updated',
      data: {
        id,
        title: update.title ?? existing.title,
        status: existing.status,
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
