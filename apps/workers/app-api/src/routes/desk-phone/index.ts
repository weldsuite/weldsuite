/**
 * WeldDesk phone — voice agents + inbound routes.
 * Mounted at /api/desk/phone/*
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createDeskVoiceAgentSchema,
  updateDeskVoiceAgentSchema,
  upsertDeskPhoneRouteSchema,
} from '@weldsuite/core-api-client/schemas/desk-phone';
import type { Env, Variables } from '../../types';
import { schema } from '../../db';
import { generateId } from '../../lib/id';
import { error, list, noContent, success, cursorPagination } from '../../lib/response';
import {
  isTelnyxConfigured,
  telnyxCreateAssistant,
  telnyxUpdateAssistant,
  telnyxDeleteAssistant,
  telnyxTransfer,
  encodeClientState,
  type TelnyxEnv,
} from '../../lib/telnyx';

const app = new Hono<{ Bindings: Env & TelnyxEnv; Variables: Variables }>();

function toAgentJson(row: typeof schema.deskVoiceAgents.$inferSelect) {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    name: row.name,
    systemPrompt: row.systemPrompt,
    greeting: row.greeting,
    telnyxAssistantId: row.telnyxAssistantId,
    enabled: row.enabled,
    forwardToE164: row.forwardToE164,
    model: row.model,
    voice: row.voice,
  };
}

function toRouteJson(row: typeof schema.deskPhoneRoutes.$inferSelect) {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    voipPhoneNumberId: row.voipPhoneNumberId,
    action: row.action,
    voiceAgentId: row.voiceAgentId,
    forwardToE164: row.forwardToE164,
    schedule: row.schedule,
  };
}

// ── Voice agents ──────────────────────────────────────────────────────────

app.get('/agents', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const rows = await db
    .select()
    .from(schema.deskVoiceAgents)
    .where(isNull(schema.deskVoiceAgents.deletedAt));
  const data = rows.map(toAgentJson);
  return list(c, data, cursorPagination(data.length, false, null));
});

app.get('/agents/:id', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(schema.deskVoiceAgents)
    .where(and(eq(schema.deskVoiceAgents.id, id), isNull(schema.deskVoiceAgents.deletedAt)))
    .limit(1);
  if (!row) return error.notFound(c, 'Voice agent', id);
  return success(c, toAgentJson(row));
});

app.post(
  '/agents',
  requirePermission('settings:manage'),
  zValidator('json', createDeskVoiceAgentSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    const now = new Date();
    const id = generateId('dva');

    let telnyxAssistantId: string | null = null;
    if (isTelnyxConfigured(c.env)) {
      try {
        const created = await telnyxCreateAssistant(c.env, {
          name: data.name,
          instructions: data.systemPrompt,
          greeting: data.greeting,
          model: data.model,
          voice: data.voice,
          transferToE164: data.forwardToE164,
        });
        telnyxAssistantId = created.id;
      } catch (err) {
        console.error('[desk-phone] Failed to create Telnyx assistant:', err);
        return error.badRequest(c, 'Failed to create Telnyx AI assistant');
      }
    }

    const [row] = await db
      .insert(schema.deskVoiceAgents)
      .values({
        id,
        createdAt: now,
        updatedAt: now,
        name: data.name,
        systemPrompt: data.systemPrompt,
        greeting: data.greeting ?? null,
        telnyxAssistantId,
        enabled: data.enabled ?? true,
        forwardToE164: data.forwardToE164 ?? null,
        model: data.model ?? null,
        voice: data.voice ?? null,
      })
      .returning();

    return success(c, toAgentJson(row), 201);
  },
);

app.patch(
  '/agents/:id',
  requirePermission('settings:manage'),
  zValidator('json', updateDeskVoiceAgentSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');

    const [existing] = await db
      .select()
      .from(schema.deskVoiceAgents)
      .where(and(eq(schema.deskVoiceAgents.id, id), isNull(schema.deskVoiceAgents.deletedAt)))
      .limit(1);
    if (!existing) return error.notFound(c, 'Voice agent', id);

    const next = {
      name: data.name ?? existing.name,
      systemPrompt: data.systemPrompt ?? existing.systemPrompt,
      greeting: data.greeting !== undefined ? data.greeting : existing.greeting,
      enabled: data.enabled ?? existing.enabled,
      forwardToE164:
        data.forwardToE164 !== undefined ? data.forwardToE164 : existing.forwardToE164,
      model: data.model !== undefined ? data.model : existing.model,
      voice: data.voice !== undefined ? data.voice : existing.voice,
    };

    let telnyxAssistantId = existing.telnyxAssistantId;
    if (isTelnyxConfigured(c.env)) {
      try {
        const payload = {
          name: next.name,
          instructions: next.systemPrompt,
          greeting: next.greeting,
          model: next.model,
          voice: next.voice,
          transferToE164: next.forwardToE164,
        };
        if (telnyxAssistantId) {
          await telnyxUpdateAssistant(c.env, telnyxAssistantId, payload);
        } else {
          const created = await telnyxCreateAssistant(c.env, payload);
          telnyxAssistantId = created.id;
        }
      } catch (err) {
        console.error('[desk-phone] Failed to sync Telnyx assistant:', err);
        return error.badRequest(c, 'Failed to sync Telnyx AI assistant');
      }
    }

    const [row] = await db
      .update(schema.deskVoiceAgents)
      .set({
        ...next,
        telnyxAssistantId,
        updatedAt: new Date(),
      })
      .where(eq(schema.deskVoiceAgents.id, id))
      .returning();

    return success(c, toAgentJson(row));
  },
);

app.delete('/agents/:id', requirePermission('settings:manage'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');

  const [existing] = await db
    .select()
    .from(schema.deskVoiceAgents)
    .where(and(eq(schema.deskVoiceAgents.id, id), isNull(schema.deskVoiceAgents.deletedAt)))
    .limit(1);
  if (!existing) return error.notFound(c, 'Voice agent', id);

  if (existing.telnyxAssistantId && isTelnyxConfigured(c.env)) {
    try {
      await telnyxDeleteAssistant(c.env, existing.telnyxAssistantId);
    } catch (err) {
      console.error('[desk-phone] Failed to delete Telnyx assistant (continuing):', err);
    }
  }

  await db
    .update(schema.deskVoiceAgents)
    .set({ deletedAt: new Date(), updatedAt: new Date(), enabled: false })
    .where(eq(schema.deskVoiceAgents.id, id));

  return noContent(c);
});

// ── Phone routes ──────────────────────────────────────────────────────────

app.get('/routes', requirePermission('conversations:read'), async (c) => {
  const db = c.get('tenantDb');
  const rows = await db.select().from(schema.deskPhoneRoutes);
  const data = rows.map(toRouteJson);
  return list(c, data, cursorPagination(data.length, false, null));
});

app.put(
  '/routes',
  requirePermission('settings:manage'),
  zValidator('json', upsertDeskPhoneRouteSchema),
  async (c) => {
    const db = c.get('tenantDb');
    const data = c.req.valid('json');
    const now = new Date();

    const [phone] = await db
      .select()
      .from(schema.voipPhoneNumbers)
      .where(
        and(
          eq(schema.voipPhoneNumbers.id, data.voipPhoneNumberId),
          isNull(schema.voipPhoneNumbers.deletedAt),
        ),
      )
      .limit(1);
    if (!phone) return error.notFound(c, 'Phone number', data.voipPhoneNumberId);

    if (data.voiceAgentId) {
      const [agent] = await db
        .select()
        .from(schema.deskVoiceAgents)
        .where(
          and(
            eq(schema.deskVoiceAgents.id, data.voiceAgentId),
            isNull(schema.deskVoiceAgents.deletedAt),
          ),
        )
        .limit(1);
      if (!agent) return error.notFound(c, 'Voice agent', data.voiceAgentId);
    }

    const [existing] = await db
      .select()
      .from(schema.deskPhoneRoutes)
      .where(eq(schema.deskPhoneRoutes.voipPhoneNumberId, data.voipPhoneNumberId))
      .limit(1);

    if (existing) {
      const [row] = await db
        .update(schema.deskPhoneRoutes)
        .set({
          action: data.action,
          voiceAgentId: data.voiceAgentId ?? null,
          forwardToE164: data.forwardToE164 ?? null,
          updatedAt: now,
        })
        .where(eq(schema.deskPhoneRoutes.id, existing.id))
        .returning();
      return success(c, toRouteJson(row));
    }

    const [row] = await db
      .insert(schema.deskPhoneRoutes)
      .values({
        id: generateId('dpr'),
        createdAt: now,
        updatedAt: now,
        voipPhoneNumberId: data.voipPhoneNumberId,
        action: data.action,
        voiceAgentId: data.voiceAgentId ?? null,
        forwardToE164: data.forwardToE164 ?? null,
        schedule: null,
      })
      .returning();

    return success(c, toRouteJson(row), 201);
  },
);

/**
 * POST /routes/forward-live — cold-transfer an active inbound call.
 */
app.post(
  '/forward-live',
  requirePermission('conversations:update'),
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const callId = typeof body.callId === 'string' ? body.callId : '';
    const to = typeof body.to === 'string' ? body.to : '';
    if (!callId || !/^\+[1-9]\d{6,14}$/.test(to)) {
      return error.badRequest(c, 'callId and E.164 to are required');
    }
    if (!isTelnyxConfigured(c.env)) {
      return error.badRequest(c, 'Phone service is not activated');
    }

    const db = c.get('tenantDb');
    const workspaceId = c.get('workspaceId');
    const [call] = await db
      .select()
      .from(schema.voipCalls)
      .where(eq(schema.voipCalls.id, callId))
      .limit(1);
    if (!call?.providerCallId) return error.notFound(c, 'Call', callId);

    const clientState = encodeClientState({
      callId: call.id,
      workspaceId,
      ...(call.deskConversationId ? { deskConversationId: call.deskConversationId } : {}),
    });

    try {
      await telnyxTransfer(c.env, call.providerCallId, to, {
        clientState,
        from: call.toNumber,
      });
    } catch (err) {
      console.error('[desk-phone] live transfer failed:', err);
      return error.badRequest(c, 'Transfer failed');
    }

    return success(c, { ok: true });
  },
);

export { app as deskPhoneRoutes };
export default app;
