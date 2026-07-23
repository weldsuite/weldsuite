/**
 * Workflow AI-builder routes — /api/workflow-builder/*
 *
 *  - POST   /drafts                 — start a new chat-driven workflow draft
 *  - GET    /drafts/:id             — load current draft state (resume)
 *  - POST   /drafts/:id/chat        — AI is currently unavailable (503)
 *  - POST   /drafts/:id/finalize    — mark the draft finalized + set name/description
 *
 * AI has been physically removed from WeldSuite. `/chat` used to be a
 * pass-through to the AGENT_WORKER service binding, which ran the AI loop and
 * applied tool-call side effects to the draft row; that binding no longer
 * exists, so the endpoint now short-circuits to a 503 before touching the
 * draft or its chat history. The other endpoints are plain DB CRUD over the
 * draft row and are unaffected.
 *
 * Permissions: tasks:read | tasks:create | tasks:update.
 */

import { z } from 'zod';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requirePermission } from '@weldsuite/permissions/server';
import {
  createBuilderDraftInput,
  finalizeBuilderDraftInput,
} from '@weldsuite/core-api-client/schemas/weldconnect-builder';
import type { Env, Variables } from '../../types';
import { error, success } from '../../lib/response';
import * as builder from '../../services/workflow-builder';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const chatBodySchema = z.object({ message: z.string().min(1).max(2000) });

app.post('/drafts', requirePermission('tasks:create'), zValidator('json', createBuilderDraftInput), async (c) => {
  const db = c.get('tenantDb');
  const userId = c.get('userId');
  try {
    const draft = await builder.createBuilderDraft(db, userId);
    return success(c, draft, 201);
  } catch (err) {
    console.error('[app-api/workflow-builder] createDraft failed:', err);
    return error.internal(c, 'Failed to create builder draft');
  }
});

app.get('/drafts/:id', requirePermission('tasks:read'), async (c) => {
  const db = c.get('tenantDb');
  const id = c.req.param('id');
  try {
    const draft = await builder.getBuilderDraft(db, id);
    if (!draft) return error.notFound(c, 'Workflow draft', id);
    return success(c, draft);
  } catch (err) {
    console.error('[app-api/workflow-builder] getDraft failed:', err);
    return error.internal(c, 'Failed to load builder draft');
  }
});

app.post('/drafts/:id/chat', requirePermission('tasks:update'), zValidator('json', chatBodySchema), async (c) => {
  return c.json({ error: { code: 'ai_unavailable', message: 'AI is currently unavailable' } }, 503);
});

app.post(
  '/drafts/:id/finalize',
  requirePermission('tasks:update'),
  zValidator('json', finalizeBuilderDraftInput),
  async (c) => {
    const db = c.get('tenantDb');
    const id = c.req.param('id');
    const data = c.req.valid('json');
    try {
      const draft = await builder.finalizeBuilderDraft(db, id, data);
      if (!draft) return error.notFound(c, 'Workflow draft', id);
      return success(c, { id: draft.id });
    } catch (err) {
      console.error('[app-api/workflow-builder] finalize failed:', err);
      return error.internal(c, 'Failed to finalize builder draft');
    }
  },
);

export const workflowBuilderRoutes = app;
