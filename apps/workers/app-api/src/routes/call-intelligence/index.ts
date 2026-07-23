/**
 * Call intelligence routes — /api/call-intelligence/* surface for phone-number
 * management, WebRTC token generation, call statistics, and call-level
 * transcription sub-routes. The voipCalls CRUD surface lives in /api/calls.
 *
 * Phone-number management: CRUD for `voipPhoneNumbers` (soft-delete).
 * WebRTC token:            POST /token → Telnyx short-lived JWT.
 * Stats:                   GET  /stats → aggregate counters over voipCalls.
 * Call transcription:      GET|POST /calls/:id/transcription[/status]
 *
 * Permissions: activities:read | activities:create | activities:update | activities:delete.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { ensurePermissionsResolved, requirePermission } from '@weldsuite/permissions/server';
import { hasPermission } from '@weldsuite/permissions';
import { publishEntityEvent } from '@weldsuite/entity-events';
import {
  createPhoneNumberSchema,
  updatePhoneNumberSchema,
  createCallTranscriptionSchema,
} from '@weldsuite/app-api-client/schemas/call-intelligence';
import type { Env, Variables } from '../../types';
import { error, noContent, success } from '../../lib/response';
import { generateId } from '../../lib/id';
import { schema } from '../../db';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const CALL_DENIED = 'You do not have access to this call';

/** Own-only (call owner) unless the caller holds activities:scope:all. */
async function scopeFor(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<string | undefined> {
  const resolved = await ensurePermissionsResolved(c);
  if (hasPermission(resolved?.permissions ?? [], 'activities:scope:all')) return undefined;
  return c.get('userId');
}

/**
 * A call's transcript inherits the call's owner scope. Used by the transcription
 * sub-routes that query crm_transcriptions by activityId and would otherwise
 * expose any owner's PII transcript to an activities:read holder.
 */
async function canAccessCall(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  callId: string,
): Promise<'ok' | 'denied' | 'not-found'> {
  const db = c.get('tenantDb');
  const scope = await scopeFor(c);
  const [call] = await db
    .select({ userId: schema.voipCalls.userId })
    .from(schema.voipCalls)
    .where(eq(schema.voipCalls.id, callId))
    .limit(1);
  if (!call) return 'not-found';
  if (scope && call.userId !== scope) return 'denied';
  return 'ok';
}

// ============================================================================
// Phone Number CRUD — /api/call-intelligence/phone-numbers
// ============================================================================

app.get('/phone-numbers', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const q = c.req.query();
  const { voipPhoneNumbers } = schema;
  const conditions: any[] = [isNull(voipPhoneNumbers.deletedAt)];
  if (q.status) conditions.push(eq(voipPhoneNumbers.status, q.status));
  if (q.provider) conditions.push(eq(voipPhoneNumbers.provider, q.provider));
  try {
    const results = await db
      .select()
      .from(voipPhoneNumbers)
      .where(and(...conditions))
      .orderBy(desc(voipPhoneNumbers.isDefault), desc(voipPhoneNumbers.createdAt));
    return success(c, results);
  } catch (err) {
    console.error('[app-api/call-intelligence] list phone numbers failed:', err);
    return error.internal(c, 'Failed to fetch phone numbers');
  }
});

app.post('/phone-numbers', requirePermission('activities:create'), zValidator('json', createPhoneNumberSchema), async (c) => {
  const db = c.get('tenantDb');
  const { voipPhoneNumbers } = schema;
  const data = c.req.valid('json') as Record<string, any>;
  const id = generateId('vnum');
  const now = new Date();
  try {
    await db.insert(voipPhoneNumbers).values({
      id,
      provider: data.provider as string,
      phoneNumber: data.phoneNumber as string,
      formattedNumber: data.formattedNumber as string | undefined,
      countryCode: data.countryCode as string,
      numberType: (data.numberType as string | undefined) ?? 'local',
      status: data.status as string,
      providerPhoneNumberId: data.providerPhoneNumberId as string | undefined,
      providerConnectionId: data.providerConnectionId as string | undefined,
      displayName: data.displayName as string | undefined,
      description: data.description as string | undefined,
      isDefault: (data.isDefault as boolean | undefined) ?? false,
      allowInbound: (data.allowInbound as boolean | undefined) ?? true,
      allowOutbound: (data.allowOutbound as boolean | undefined) ?? true,
      enableRecording: (data.enableRecording as boolean | undefined) ?? true,
      createdAt: now,
      updatedAt: now,
    } as unknown as typeof voipPhoneNumbers.$inferInsert);
    publishEntityEvent({
      c,
      entityType: 'call',
      entityId: id,
      action: 'created',
      data: { id, phoneNumber: data.phoneNumber as string },
    });
    return success(c, { id }, 201);
  } catch (err) {
    console.error('[app-api/call-intelligence] create phone number failed:', err);
    return error.internal(c, 'Failed to create phone number');
  }
});

app.patch('/phone-numbers/:id', requirePermission('activities:update'), zValidator('json', updatePhoneNumberSchema), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { voipPhoneNumbers } = schema;
  const data = c.req.valid('json') as Record<string, any>;
  try {
    const [existing] = await db
      .select()
      .from(voipPhoneNumbers)
      .where(and(eq(voipPhoneNumbers.id, id), isNull(voipPhoneNumbers.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Phone number', id);
    const update: Record<string, any> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) update[k] = v;
    await db
      .update(voipPhoneNumbers)
      .set(update)
      .where(and(eq(voipPhoneNumbers.id, id), isNull(voipPhoneNumbers.deletedAt)));
    publishEntityEvent({
      c,
      entityType: 'call',
      entityId: id,
      action: 'updated',
      data: { id },
    });
    return success(c, { id });
  } catch (err) {
    console.error('[app-api/call-intelligence] update phone number failed:', err);
    return error.internal(c, 'Failed to update phone number');
  }
});

app.delete('/phone-numbers/:id', requirePermission('activities:delete'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const { voipPhoneNumbers } = schema;
  try {
    const [existing] = await db
      .select()
      .from(voipPhoneNumbers)
      .where(and(eq(voipPhoneNumbers.id, id), isNull(voipPhoneNumbers.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Phone number', id);
    await db
      .update(voipPhoneNumbers)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(voipPhoneNumbers.id, id));
    publishEntityEvent({
      c,
      entityType: 'call',
      entityId: id,
      action: 'deleted',
      data: { id },
    });
    return noContent(c);
  } catch (err) {
    console.error('[app-api/call-intelligence] delete phone number failed:', err);
    return error.internal(c, 'Failed to delete phone number');
  }
});

// ============================================================================
// WebRTC Token — POST /api/call-intelligence/token
// ============================================================================

app.post('/token', requirePermission('activities:read'), async (c) => {
  try {
    const apiKey = (c.env as any).TELNYX_API_KEY as string | undefined;
    const sipConnectionId = (c.env as any).TELNYX_SIP_CONNECTION_ID as string | undefined;

    if (!apiKey || !sipConnectionId) {
      return success(c, {
        token: null,
        message: 'Telnyx is not configured. Set TELNYX_API_KEY and TELNYX_SIP_CONNECTION_ID.',
        configured: false,
        provider: 'telnyx' as const,
      });
    }

    let credentialId: string | null = null;

    const listResp = await fetch(
      `https://api.telnyx.com/v2/telephony_credentials?filter[connection_id]=${sipConnectionId}&page[size]=1`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (listResp.ok) {
      const listData = (await listResp.json()) as { data: Array<{ id: string }> };
      if (listData.data?.length > 0) credentialId = listData.data[0].id;
    }

    if (!credentialId) {
      const credResp = await fetch('https://api.telnyx.com/v2/telephony_credentials', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: sipConnectionId, name: 'weldsuite-webrtc' }),
      });
      if (!credResp.ok) {
        const credErr = await credResp.text();
        console.error('[app-api/call-intelligence] Telnyx credential creation failed:', credResp.status, credErr);
        throw new Error(`Failed to create credential: ${credResp.status}`);
      }
      const credData = (await credResp.json()) as { data: { id: string } };
      credentialId = credData.data.id;
    }

    const tokenResp = await fetch(
      `https://api.telnyx.com/v2/telephony_credentials/${credentialId}/token`,
      { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` } },
    );
    if (!tokenResp.ok) {
      const tokenErr = await tokenResp.text();
      console.error('[app-api/call-intelligence] Telnyx token generation failed:', tokenResp.status, tokenErr);
      throw new Error(`Failed to generate token: ${tokenResp.status}`);
    }
    const token = await tokenResp.text();
    return success(c, { token, configured: true, provider: 'telnyx' as const });
  } catch (err) {
    console.error('[app-api/call-intelligence] token generation failed:', err);
    return error.internal(c, 'Failed to generate Voice token');
  }
});

// ============================================================================
// Call Statistics — GET /api/call-intelligence/stats
// ============================================================================

app.get('/stats', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const { voipCalls } = schema;
  try {
    const [stats] = await db
      .select({
        totalCalls: sql<number>`count(*)::int`,
        completedCalls: sql<number>`count(*) filter (where ${voipCalls.status} = 'completed')::int`,
        totalDuration: sql<number>`coalesce(sum(${voipCalls.duration}), 0)::int`,
        avgDuration: sql<number>`coalesce(avg(${voipCalls.duration}), 0)::int`,
        inboundCalls: sql<number>`count(*) filter (where ${voipCalls.direction} = 'inbound')::int`,
        outboundCalls: sql<number>`count(*) filter (where ${voipCalls.direction} = 'outbound')::int`,
        recordedCalls: sql<number>`count(*) filter (where ${voipCalls.isRecorded} = true)::int`,
        totalCreditsConsumed: sql<number>`coalesce(sum(${voipCalls.creditsConsumed}), 0)::int`,
      })
      .from(voipCalls);
    return success(c, stats ?? {
      totalCalls: 0, completedCalls: 0, totalDuration: 0, avgDuration: 0,
      inboundCalls: 0, outboundCalls: 0, recordedCalls: 0, totalCreditsConsumed: 0,
    });
  } catch (err) {
    console.error('[app-api/call-intelligence] stats failed:', err);
    return error.internal(c, 'Failed to fetch call statistics');
  }
});

// ============================================================================
// Call Transcription sub-routes — /api/call-intelligence/calls/:id/transcription
// ============================================================================

app.get('/calls/:id/transcription', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const callId = c.req.param('id');
  const { crmTranscriptions, crmTranscriptSegments } = schema;
  const access = await canAccessCall(c, callId);
  if (access === 'not-found') return error.notFound(c, 'VoIP call', callId);
  if (access === 'denied') return error.forbidden(c, CALL_DENIED);
  try {
    const [transcription] = await db
      .select()
      .from(crmTranscriptions)
      .where(eq(crmTranscriptions.activityId, callId))
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
    console.error('[app-api/call-intelligence] get call transcription failed:', err);
    return error.internal(c, 'Failed to fetch transcription');
  }
});

app.get('/calls/:id/transcription/status', requirePermission('activities:read'), async (c) => {
  const db = c.get('tenantDb');
  const callId = c.req.param('id');
  const { crmTranscriptions } = schema;
  const access = await canAccessCall(c, callId);
  if (access === 'not-found') return error.notFound(c, 'VoIP call', callId);
  if (access === 'denied') return error.forbidden(c, CALL_DENIED);
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
      .where(eq(crmTranscriptions.activityId, callId))
      .limit(1);
    if (!row) return success(c, { exists: false });
    return success(c, { exists: true, ...row });
  } catch (err) {
    console.error('[app-api/call-intelligence] call transcription status failed:', err);
    return error.internal(c, 'Failed to fetch transcription status');
  }
});

app.post(
  '/calls/:id/transcription',
  requirePermission('activities:create'),
  zValidator('json', createCallTranscriptionSchema.optional()),
  async (c) => {
    const db = c.get('tenantDb');
    const callId = c.req.param('id');
    const { crmTranscriptions, voipCalls } = schema;
    const body = c.req.valid('json') ?? {};
    try {
      const [call] = await db.select().from(voipCalls).where(eq(voipCalls.id, callId)).limit(1);
      if (!call) return error.notFound(c, 'VoIP call', callId);
      {
        const scope = await scopeFor(c);
        if (scope && call.userId !== scope) return error.forbidden(c, CALL_DENIED);
      }
      const [existing] = await db
        .select({ id: crmTranscriptions.id })
        .from(crmTranscriptions)
        .where(eq(crmTranscriptions.activityId, callId))
        .limit(1);
      if (existing) return error.conflict(c, 'Transcription already exists for this call');
      const id = generateId('trans');
      const now = new Date();
      await db.insert(crmTranscriptions).values({
        id,
        activityId: callId,
        status: 'pending',
        language: body.language ?? 'en',
        createdAt: now,
        updatedAt: now,
      } as unknown as typeof crmTranscriptions.$inferInsert);
      return success(c, { id }, 201);
    } catch (err) {
      console.error('[app-api/call-intelligence] create call transcription failed:', err);
      return error.internal(c, 'Failed to create transcription');
    }
  },
);

export const callIntelligenceRoutes = app;
