/**
 * /api/workflow-builder on pglite: drafts (create, load, finalize), the chat
 * that answers 503 since the AI teardown, and the refusals.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const { workflowBuilderRoutes } = await import('./index');

let db: Database;

const ALL = ['workflows:read', 'workflows:create', 'workflows:update'];

function app(granted: string[] = ALL) {
  return createTestApp('/api/workflow-builder', workflowBuilderRoutes, {
    context: { permissions: permissions(...granted), tenantDb: db },
  }).request;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workflows).values({
    id: 'wf_b_built',
    name: 'Built',
    status: 'draft',
    triggers: [{ id: 't1', type: 'entity_event', name: 'Lead created', config: { entityType: 'lead' } }],
    steps: [
      { id: 's1', type: 'condition', name: 'Big deal?', config: { expression: 'amount > 1000' } },
      { id: 's2', type: 'send_email', name: 'Tell sales', description: 'Ping the team', config: { to: 'sales@x.test' } },
      { id: 's3', type: 'delay', name: 'Wait' },
    ],
    settings: { builderState: { isBuilderDraft: true, chatHistory: [{ role: 'user', content: 'hi' }], finalized: false } },
    tags: ['ai-builder'],
  });
}, 60_000);

describe('/api/workflow-builder/drafts', () => {
  it('creates an empty draft and loads it', async () => {
    const request = app();
    const created = await request('/api/workflow-builder/drafts', post({ initialMessage: 'Route new leads' }));
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string; name: string; trigger: unknown; steps: unknown[] } };
    expect(data).toMatchObject({ name: 'Untitled AI workflow', status: 'draft', trigger: null, steps: [], finalized: false });

    const loaded = await request(`/api/workflow-builder/drafts/${data.id}`);
    expect(loaded.status).toBe(200);
  });

  it('reads a draft as builder nodes', async () => {
    const res = await app()('/api/workflow-builder/drafts/wf_b_built');
    const { data } = (await res.json()) as { data: { trigger: unknown; steps: unknown[] } };
    expect(data.trigger).toEqual({
      id: 't1',
      kind: 'trigger',
      triggerType: 'entity_event',
      label: 'Lead created',
      config: { entityType: 'lead' },
    });
    expect(data.steps).toEqual([
      { id: 's1', kind: 'condition', label: 'Big deal?', expression: 'amount > 1000', branches: [] },
      {
        id: 's2',
        kind: 'action',
        actionType: 'send_email',
        label: 'Tell sales',
        description: 'Ping the team',
        config: { to: 'sales@x.test' },
      },
      { id: 's3', kind: 'action', actionType: 'delay', label: 'Wait', config: {} },
    ]);
  });

  it('finalizes a draft, keeping its chat history', async () => {
    const request = app();
    const res = await request('/api/workflow-builder/drafts/wf_b_built/finalize', post({ name: 'Lead router', description: 'From chat' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ id: 'wf_b_built' });
    const loaded = (await (await request('/api/workflow-builder/drafts/wf_b_built')).json()) as {
      data: { name: string; description: string; finalized: boolean };
    };
    expect(loaded.data).toMatchObject({ name: 'Lead router', description: 'From chat', finalized: true });
  });

  it('answers 503 to a chat message, after validating it', async () => {
    const request = app();
    const chat = await request('/api/workflow-builder/drafts/wf_b_built/chat', post({ message: 'Add a step' }));
    expect(chat.status).toBe(503);
    expect(await chat.json()).toEqual({ error: { code: 'ai_unavailable', message: 'AI is currently unavailable' } });
    expect((await request('/api/workflow-builder/drafts/wf_b_built/chat', post({ message: '' }))).status).toBe(400);
  });

  it('404s an unknown draft, validates, and refuses without permission', async () => {
    const request = app();
    expect((await request('/api/workflow-builder/drafts/wf_nope')).status).toBe(404);
    expect((await request('/api/workflow-builder/drafts/wf_nope/finalize', post({}))).status).toBe(404);
    expect((await request('/api/workflow-builder/drafts', post({ initialMessage: 5 }))).status).toBe(400);
    expect((await app(['workflows:read'])('/api/workflow-builder/drafts', post({}))).status).toBe(403);
    expect((await app(['workflows:create'])('/api/workflow-builder/drafts/wf_b_built')).status).toBe(403);
  });
});
