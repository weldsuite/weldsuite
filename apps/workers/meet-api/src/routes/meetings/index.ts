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
} from '@weldsuite/core-api-client/schemas/meetings';
import { hostControlsSchema, DEFAULT_HOST_CONTROLS } from '@weldsuite/core-api-client/schemas/weldmeet';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '@weldsuite/worker-kit/response';
import { generateId } from '@weldsuite/worker-kit/id';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { schema } from '@weldsuite/worker-kit/db';
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
  return conditions;
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

      // Inviter (for the email copy) and organizer (for the .ics ORGANIZER).
      const people = await db
        .select({
          userId: schema.workspaceMembers.userId,
          name: schema.workspaceMembers.name,
          email: schema.workspaceMembers.email,
        })
        .from(schema.workspaceMembers)
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
            ? sendInvitationEmail(env.RESEND_API_KEY, {
                meeting: existing,
                organizer: {
                  name: inviter?.name || organizer?.name || 'Someone',
                  email: organizer?.email ?? '',
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
 * `status` says why (recording | processing | failed).
 */
app.get('/:id/recording', requirePermission('meetings:read'), async (c) => {
  const orgId = c.get('orgId');
  if (!orgId) return error.orgRequired(c);

  const meetingId = c.req.param('id');
  try {
    const session = await resolveRecordedSession(c, meetingId);
    if (session instanceof Response) return session;
    if (!session) return error.notFound(c, 'Recording');

    const auth = await authorizeSession(c, session.id);
    if (isResponse(auth)) return auth;
    const info = await buildRecordingInfo(c.get('tenantDb'), session);

    let access: { url: string; audioUrl: string | null; expiresAt: string } | null = null;
    if (info.status === 'ready') {
      const minted = await mintRecordingAccess(c, auth);
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

/**
 * The create/update schemas accept schedule times as ISO strings, but the
 * timestamp columns need a `Date`. `null` clears the column; absent keys are
 * left out so PATCH does not touch them.
 */
function withScheduleDates(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  for (const key of ['scheduledStart', 'scheduledEnd'] as const) {
    const value = out[key];
    if (typeof value === 'string') out[key] = new Date(value);
  }
  return out;
}

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
  // Every meeting needs a join code: it is the identifier in the public share
  // link (`<portal>/<workspace>/<joinCode>`). Generated server-side like the
  // start-instant path; a client-supplied value is not trusted.
  const joinCode = generateJoinCode();
  try {
    const values = withScheduleDates(data);
    if (Array.isArray(data.attendees)) values.attendees = toMeetingAttendees(data.attendees);
    await db.insert(t).values({ id, ...values, joinCode, waitingRoom, organizerId, createdAt: now, updatedAt: now } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'meeting',
      entityId: id,
      action: 'created',
      data: { id, title: data.title, status: data.status, hostId: organizerId },
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
  const data = c.req.valid('json') as Record<string, any>;
  const scope = await scopeFor(c);
  const conditions: any[] = [eq(t.id, id), isNull(t.deletedAt)];
  if (scope) conditions.push(eq(t.organizerId, scope));
  try {
    const [existing] = await db.select().from(t).where(and(...conditions)).limit(1);
    if (!existing) return error.notFound(c, 'Meeting', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(withScheduleDates(data))) if (v !== undefined) update[k] = v;
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
