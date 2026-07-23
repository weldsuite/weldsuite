/**
 * Transcription routes — flat /api/transcriptions/* surface backed by
 * `crmTranscriptions` + `crmTranscriptSegments`. Transcriptions are linked to
 * CRM activities (calls, meeting bot sessions) via `activityId`.
 *
 * Formerly mounted under /activities/:activityId/transcription in api-worker.
 * This flat surface lets callers manage transcriptions by transcription ID
 * directly. The activity-lookup sub-routes live on /api/activities/:id/
 * and /api/meeting-bot-sessions/:id/ respectively.
 *
 * PII note: transcript text (fullText, segment text) is PII-sensitive.
 *
 * Permissions: activities:read | activities:create | activities:update | activities:delete.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { ensurePermissionsResolved, requirePermission } from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createTranscriptionSchema,
  updateTranscriptionSchema,
  createTranscriptSegmentsSchema,
} from '@weldsuite/app-api-client/schemas/transcriptions';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const t = schema.crmTranscriptions;

const ACTIVITY_DENIED = 'You do not have access to this transcript';

/** Own-only unless the caller holds activities:scope:all. */
async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  const resolved = await ensurePermissionsResolved(c);
  if (hasPermission(resolved?.permissions ?? [], 'activities:scope:all')) return undefined;
  return c.get('userId');
}

/**
 * A transcription's activityId is polymorphic — it references a voip call, a
 * meeting-bot session, or a CRM activity. Resolve the owner across all three.
 */
async function resolveActivityOwner(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  activityId: string,
): Promise<string | undefined> {
  const db = c.get('tenantDb');
  const [call] = await db
    .select({ u: schema.voipCalls.userId })
    .from(schema.voipCalls)
    .where(eq(schema.voipCalls.id, activityId))
    .limit(1);
  if (call) return call.u;
  const [session] = await db
    .select({ u: schema.meetingBotSessions.userId })
    .from(schema.meetingBotSessions)
    .where(eq(schema.meetingBotSessions.id, activityId))
    .limit(1);
  if (session) return session.u;
  const [activity] = await db
    .select({ u: schema.crmActivities.assignedToId })
    .from(schema.crmActivities)
    .where(eq(schema.crmActivities.id, activityId))
    .limit(1);
  if (activity) return activity.u;
  return undefined;
}

/**
 * True if the caller may read/act on a transcript linked to `activityId`.
 * scope:all always passes; otherwise the linked activity must be owned by the
 * caller. An unresolvable activity denies scoped callers (fail-closed on PII).
 */
async function canAccessActivity(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  activityId: string,
): Promise<boolean> {
  const scope = await scopeFor(c);
  if (!scope) return true;
  return (await resolveActivityOwner(c, activityId)) === scope;
}

// ============================================================================
// Core CRUD
// ============================================================================

app.get('/:id', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { crmTranscriptSegments } = schema;
  try {
    const [transcription] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!transcription) return error.notFound(c, 'Transcription', id);
    if (!(await canAccessActivity(c, transcription.activityId))) return error.forbidden(c, ACTIVITY_DENIED);
    const segments = await db
      .select()
      .from(crmTranscriptSegments)
      .where(eq(crmTranscriptSegments.transcriptionId, id))
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
    console.error('[app-api/transcriptions] get failed:', err);
    return error.internal(c, 'Failed to fetch transcription');
  }
});

/**
 * GET /transcriptions/by-activity/:activityId — look up by the linked activity.
 * Covers both CRM activities and meeting bot session IDs (both use activityId column).
 */
app.get('/by-activity/:activityId', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const activityId = c.req.param('activityId');
  const { crmTranscriptSegments } = schema;
  try {
    const [transcription] = await db
      .select()
      .from(t)
      .where(eq(t.activityId, activityId))
      .limit(1);
    if (!transcription) return error.notFound(c, 'Transcription');
    if (!(await canAccessActivity(c, activityId))) return error.forbidden(c, ACTIVITY_DENIED);
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
    console.error('[app-api/transcriptions] get-by-activity failed:', err);
    return error.internal(c, 'Failed to fetch transcription');
  }
});

app.get('/by-activity/:activityId/status', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const activityId = c.req.param('activityId');
  if (!(await canAccessActivity(c, activityId))) return error.forbidden(c, ACTIVITY_DENIED);
  try {
    const [row] = await db
      .select({
        id: t.id,
        status: t.status,
        errorMessage: t.errorMessage,
        processingStartedAt: t.processingStartedAt,
        processingCompletedAt: t.processingCompletedAt,
        wordCount: t.wordCount,
        speakerCount: t.speakerCount,
      })
      .from(t)
      .where(eq(t.activityId, activityId))
      .limit(1);
    if (!row) return success(c, { exists: false });
    return success(c, { exists: true, ...row });
  } catch (err) {
    console.error('[app-api/transcriptions] status-by-activity failed:', err);
    return error.internal(c, 'Failed to fetch transcription status');
  }
});

app.post('/', requirePermission('activities:create'), zValidator('json', createTranscriptionSchema), async (c) => {
  const db = c.get('tenantDb');
  const data = c.req.valid('json');
  const { crmActivities } = schema;
  try {
    const [activity] = await db
      .select()
      .from(crmActivities)
      .where(and(eq(crmActivities.id, data.activityId), isNull(crmActivities.deletedAt)))
      .limit(1);
    if (!activity) return error.notFound(c, 'Activity', data.activityId);
    if (!(await canAccessActivity(c, data.activityId))) return error.forbidden(c, ACTIVITY_DENIED);
    const [existing] = await db
      .select({ id: t.id })
      .from(t)
      .where(eq(t.activityId, data.activityId))
      .limit(1);
    if (existing) return error.conflict(c, 'Transcription already exists for this activity');
    const id = generateId('trans');
    const now = new Date();
    await db.insert(t).values({
      id,
      activityId: data.activityId,
      status: 'pending',
      language: data.language ?? 'en',
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof t.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'transcription',
      entityId: id,
      action: 'created',
      data: { id, activityId: data.activityId, status: 'pending', language: data.language ?? 'en' },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/transcriptions] create failed:', err);
    return error.internal(c, 'Failed to create transcription');
  }
});

app.patch('/:id', requirePermission('activities:update'), zValidator('json', updateTranscriptionSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Transcription', id);
    if (!(await canAccessActivity(c, existing.activityId))) return error.forbidden(c, ACTIVITY_DENIED);
    const dateFields = ['processingStartedAt', 'processingCompletedAt'];
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) {
        update[k] = dateFields.includes(k) ? (v ? new Date(v as string) : null) : v;
      }
    }
    await db.update(t).set(update).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'transcription',
      entityId: id,
      action: 'updated',
      data: { id },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/transcriptions] update failed:', err);
    return error.internal(c, 'Failed to update transcription');
  }
});

app.delete('/:id', requirePermission('activities:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { crmTranscriptSegments } = schema;
  try {
    const [existing] = await db.select().from(t).where(eq(t.id, id)).limit(1);
    if (!existing) return error.notFound(c, 'Transcription', id);
    if (!(await canAccessActivity(c, existing.activityId))) return error.forbidden(c, ACTIVITY_DENIED);
    await db.delete(crmTranscriptSegments).where(eq(crmTranscriptSegments.transcriptionId, id));
    await db.delete(t).where(eq(t.id, id));
    publishEntityEvent({
      c,
      entityType: 'transcription',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/transcriptions] delete failed:', err);
    return error.internal(c, 'Failed to delete transcription');
  }
});

// ============================================================================
// Segment sub-routes
// ============================================================================

app.get('/:id/segments', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { crmTranscriptSegments } = schema;
  try {
    const [transcription] = await db.select({ id: t.id, activityId: t.activityId }).from(t).where(eq(t.id, id)).limit(1);
    if (!transcription) return error.notFound(c, 'Transcription', id);
    if (!(await canAccessActivity(c, transcription.activityId))) return error.forbidden(c, ACTIVITY_DENIED);
    const segments = await db
      .select()
      .from(crmTranscriptSegments)
      .where(eq(crmTranscriptSegments.transcriptionId, id))
      .orderBy(asc(crmTranscriptSegments.sequenceNumber));
    return success(c, segments);
  } catch (err) {
    console.error('[app-api/transcriptions] get segments failed:', err);
    return error.internal(c, 'Failed to fetch transcript segments');
  }
});

app.post('/:id/segments', requirePermission('activities:create'), zValidator('json', createTranscriptSegmentsSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { crmTranscriptSegments } = schema;
  const { segments } = c.req.valid('json');
  try {
    const [transcription] = await db.select({ id: t.id, activityId: t.activityId }).from(t).where(eq(t.id, id)).limit(1);
    if (!transcription) return error.notFound(c, 'Transcription', id);
    if (!(await canAccessActivity(c, transcription.activityId))) return error.forbidden(c, ACTIVITY_DENIED);
    const now = new Date();
    await db.insert(crmTranscriptSegments).values(
      segments.map((seg) => ({
        id: generateId('seg'),
        transcriptionId: id,
        speakerId: seg.speakerId,
        speakerLabel: seg.speakerLabel ?? `Speaker ${seg.speakerId + 1}`,
        speakerName: seg.speakerName,
        text: seg.text,
        startTime: seg.startTime,
        endTime: seg.endTime,
        timestamp: seg.timestamp,
        confidence: seg.confidence,
        sequenceNumber: seg.sequenceNumber,
        createdAt: now,
      })) as unknown as typeof crmTranscriptSegments.$inferInsert[],
    );
    return success(c, { count: segments.length }, 201);
  } catch (err) {
    console.error('[app-api/transcriptions] create segments failed:', err);
    return error.internal(c, 'Failed to create transcript segments');
  }
});

app.delete('/:id/segments', requirePermission('activities:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { crmTranscriptSegments } = schema;
  try {
    const [transcription] = await db.select({ id: t.id, activityId: t.activityId }).from(t).where(eq(t.id, id)).limit(1);
    if (!transcription) return error.notFound(c, 'Transcription', id);
    if (!(await canAccessActivity(c, transcription.activityId))) return error.forbidden(c, ACTIVITY_DENIED);
    await db.delete(crmTranscriptSegments).where(eq(crmTranscriptSegments.transcriptionId, id));
    return noContent(c);
  } catch (err) {
    console.error('[app-api/transcriptions] delete segments failed:', err);
    return error.internal(c, 'Failed to delete transcript segments');
  }
});

export const transcriptionsRoutes = app;
