/**
 * Meeting bot session routes — flat /api/meeting-bot-sessions/* surface backed
 * by `meetingBotSessions`. Records a bot attendee joining an external meeting
 * to capture audio for transcription and call intelligence. Also exposes
 * sub-routes for transcription management on a session.
 *
 * Permissions: activities:read | activities:create | activities:update | activities:delete.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { ensurePermissionsResolved, requirePermission } from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createMeetingBotSessionSchema,
  updateMeetingBotSessionSchema,
} from '@weldsuite/app-api-client/schemas/meeting-bot-sessions';
import type { Env, Variables } from '../../types';
import { cursorPagination, error, list, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.meetingBotSessions;

const SESSION_DENIED = 'You do not have access to this meeting bot session';

/** Own-only (session owner) unless the caller holds activities:scope:all. */
async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  const resolved = await ensurePermissionsResolved(c);
  if (hasPermission(resolved?.permissions ?? [], 'activities:scope:all')) return undefined;
  return c.get('userId');
}

/** Resolve a session's owner scope — for the transcription sub-routes that
 *  query crm_transcriptions by activityId rather than loading the session. */
async function canAccessSession(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  sessionId: string,
): Promise<'ok' | 'denied' | 'not-found'> {
  const db = c.get('tenantDb');
  const scope = await scopeFor(c);
  const [s] = await db.select({ userId: t.userId }).from(t).where(eq(t.id, sessionId)).limit(1);
  if (!s) return 'not-found';
  if (scope && s.userId !== scope) return 'denied';
  return 'ok';
}

const sessionTranscriptionBodySchema = z.object({
  language: z.string().optional(),
}).optional();

app.get('/', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const limit = Math.min(q.limit ? parseInt(q.limit, 10) : 25, 100);

  const conditions: any[] = [];
  if (q.status) conditions.push(eq(t.status, q.status));
  const scope = await scopeFor(c);
  if (scope) conditions.push(eq(t.userId, scope));

  if (q.cursor) {
    const [cur] = await db
      .select({ createdAt: t.createdAt, id: t.id })
      .from(t)
      .where(eq(t.id, q.cursor))
      .limit(1);
    if (cur) {
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
    console.error('[app-api/meeting-bot-sessions] list failed:', err);
    return error.internal(c, 'Failed to list meeting bot sessions');
  }
});

app.get('/:id', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [row] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!row) return error.notFound(c, 'Meeting bot session', id);
    const scope = await scopeFor(c);
    if (scope && row.userId !== scope) return error.forbidden(c, SESSION_DENIED);
    return success(c, row);
  } catch (err) {
    console.error('[app-api/meeting-bot-sessions] get failed:', err);
    return error.internal(c, 'Failed to fetch meeting bot session');
  }
});

app.post('/', requirePermission('activities:create'), zValidator('json', createMeetingBotSessionSchema), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('mbs');
  const now = new Date();
  try {
    await db.insert(t).values({
      id,
      userId,
      meetingUrl: data.meetingUrl as string,
      platform: (data.platform as string | undefined) ?? 'unknown',
      title: (data.title as string | undefined) ?? `Meeting ${now.toLocaleString()}`,
      status: 'pending',
      enableTranscription: (data.enableTranscription as boolean | undefined) ?? false,
      enableDiarization: (data.enableDiarization as boolean | undefined) ?? true,
      language: (data.language as string | undefined) ?? 'en',
      contactId: data.contactId as string | undefined,
      opportunityId: data.opportunityId as string | undefined,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'meeting_bot_session',
      entityId: id,
      action: 'created',
      data: { id, status: 'pending', meetingUrl: data.meetingUrl as string },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/meeting-bot-sessions] create failed:', err);
    return error.internal(c, 'Failed to create meeting bot session');
  }
});

app.patch('/:id', requirePermission('activities:update'), zValidator('json', updateMeetingBotSessionSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Meeting bot session', id);
    const scope = await scopeFor(c);
    if (scope && existing.userId !== scope) return error.forbidden(c, SESSION_DENIED);
    const dateFields = ['joinedAt', 'leftAt'];
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) {
        update[k] = dateFields.includes(k) ? (v ? new Date(v as string) : null) : v;
      }
    }
    await db.update(t).set(update).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'meeting_bot_session',
      entityId: id,
      action: 'updated',
      data: { id },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/meeting-bot-sessions] update failed:', err);
    return error.internal(c, 'Failed to update meeting bot session');
  }
});

app.delete('/:id', requirePermission('activities:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Meeting bot session', id);
    const scope = await scopeFor(c);
    if (scope && existing.userId !== scope) return error.forbidden(c, SESSION_DENIED);
    await db.delete(t).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'meeting_bot_session',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/meeting-bot-sessions] delete failed:', err);
    return error.internal(c, 'Failed to delete meeting bot session');
  }
});

// ============================================================================
// Transcription sub-routes — /api/meeting-bot-sessions/:id/transcription
// ============================================================================

app.get('/:id/transcription', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const sessionId = c.req.param('id');
  const { crmTranscriptions, crmTranscriptSegments } = schema;
  const access = await canAccessSession(c, sessionId);
  if (access === 'not-found') return error.notFound(c, 'Meeting bot session', sessionId);
  if (access === 'denied') return error.forbidden(c, SESSION_DENIED);
  try {
    const [transcription] = await db
      .select()
      .from(crmTranscriptions)
      .where(eq(crmTranscriptions.activityId, sessionId))
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
    console.error('[app-api/meeting-bot-sessions] get transcription failed:', err);
    return error.internal(c, 'Failed to fetch transcription');
  }
});

app.get('/:id/transcription/status', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const sessionId = c.req.param('id');
  const { crmTranscriptions } = schema;
  const access = await canAccessSession(c, sessionId);
  if (access === 'not-found') return error.notFound(c, 'Meeting bot session', sessionId);
  if (access === 'denied') return error.forbidden(c, SESSION_DENIED);
  try {
    const [row] = await db
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
      .where(eq(crmTranscriptions.activityId, sessionId))
      .limit(1);
    if (!row) return success(c, { exists: false });
    return success(c, { exists: true, ...row });
  } catch (err) {
    console.error('[app-api/meeting-bot-sessions] transcription status failed:', err);
    return error.internal(c, 'Failed to fetch transcription status');
  }
});

app.post(
  '/:id/transcription',
  requirePermission('activities:create'),
  zValidator('json', sessionTranscriptionBodySchema),
  async (c) => {
    const db = c.get('tenantDb');
    const sessionId = c.req.param('id');
    const { crmTranscriptions, meetingBotSessions } = schema;
    const body = c.req.valid('json') ?? {};
    try {
      const [session] = await db
        .select()
        .from(meetingBotSessions)
        .where(eq(meetingBotSessions.id, sessionId))
        .limit(1);
      if (!session) return error.notFound(c, 'Meeting bot session', sessionId);
      {
        const scope = await scopeFor(c);
        if (scope && session.userId !== scope) return error.forbidden(c, SESSION_DENIED);
      }
      const [existing] = await db
        .select({ id: crmTranscriptions.id })
        .from(crmTranscriptions)
        .where(eq(crmTranscriptions.activityId, sessionId))
        .limit(1);
      if (existing) return error.conflict(c, 'Transcription already exists for this session');
      const id = generateId('trans');
      const now = new Date();
      await db.insert(crmTranscriptions).values({
        id,
        activityId: sessionId,
        status: 'pending',
        language: body.language ?? 'en',
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof crmTranscriptions.$inferInsert);
      return success(c, { id }, 201);
    } catch (err) {
      console.error('[app-api/meeting-bot-sessions] create transcription failed:', err);
      return error.internal(c, 'Failed to create transcription');
    }
  },
);

export const meetingBotSessionsRoutes = app;
