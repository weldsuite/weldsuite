/**
 * DB-backed integration tests for /api/workflows.
 *
 * Workflows use the `workflows:*` permission set (WeldConnect automation).
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { workflowsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { type Database } from '../../db';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>(
    '@weldsuite/entity-events',
  );
  return { ...actual, publishEntityEvent: vi.fn() };
});

import { publishEntityEvent } from '@weldsuite/entity-events';
const mockedPublish = publishEntityEvent as ReturnType<typeof vi.fn>;

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/workflows · pglite integration', () => {
  it('POST / writes a workflow and publishes workflow.created', async () => {
    mockedPublish.mockClear();
    const { request } = createTestApp('/api/workflows', workflowsRoutes, {
      context: { permissions: permissions('workflows:create'), tenantDb: db },
    });

    const res = await request('/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'E2E Workflow' }),
    });

    expect(res.status).toBe(201);
    // The route returns just `{ id }` from the service; the full row
    // lives in DB and is exercised by GET /:id covered below.
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toMatch(/^wf_/);

    expect(mockedPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'workflow',
        action: 'created',
      }),
    );
  });

  describe('WeldConnect MVP activation gate', () => {
    const validFlow = {
      triggers: [{ id: 'trigger-1', type: 'entity_event', entityType: 'person', eventType: 'created' }],
      steps: [
        {
          id: 'step-1',
          type: 'send_email',
          config: { to: '{{trigger.record.email}}', subject: 'Welcome', body: '<p>Hi</p>' },
        },
      ],
    };
    const unsupportedFlow = {
      triggers: [{ id: 'trigger-1', type: 'webhook' }],
      steps: [{ id: 'step-1', type: 'http_request', config: { url: 'https://example.test', method: 'GET' } }],
    };

    function app() {
      return createTestApp('/api/workflows', workflowsRoutes, {
        context: {
          permissions: permissions('workflows:create', 'workflows:update', 'workflows:read'),
          tenantDb: db,
        },
      }).request;
    }

    async function create(request: ReturnType<typeof app>, body: Record<string, unknown>) {
      const res = await request('/api/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { res, id: res.status === 201 ? ((await res.json()) as { data: { id: string } }).data.id : '' };
    }

    function setStatus(request: ReturnType<typeof app>, id: string, status: string) {
      return request(`/api/workflows/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    }

    it('lets an unsupported workflow be saved as a draft but not activated', async () => {
      const request = app();
      const { res, id } = await create(request, { name: 'Legacy', ...unsupportedFlow });
      expect(res.status).toBe(201);

      const activate = await setStatus(request, id, 'active');
      expect(activate.status).toBe(400);
      const body = (await activate.json()) as {
        error: { details: { reason: string; issues: Array<{ code: string }> } };
      };
      expect(body.error.details.reason).toBe('weldconnect_unsupported');
      expect(body.error.details.issues.map((i) => i.code)).toEqual(['unsupported_trigger', 'unsupported_action']);
    });

    it('rejects creating an unsupported workflow as active', async () => {
      const { res } = await create(app(), { name: 'Straight to live', status: 'active', ...unsupportedFlow });
      expect(res.status).toBe(400);
    });

    it('activates a supported workflow', async () => {
      const request = app();
      const { id } = await create(request, { name: 'Welcome email', ...validFlow });
      expect((await setStatus(request, id, 'active')).status).toBe(200);
    });

    it('blocks adding an unsupported step to a live workflow but allows renaming it', async () => {
      const request = app();
      const { id } = await create(request, { name: 'Live', status: 'active', ...validFlow });

      const addStep = await request(`/api/workflows/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: [...validFlow.steps, { id: 'step-2', type: 'delay', config: { minutes: 5 } }] }),
      });
      expect(addStep.status).toBe(400);

      const rename = await request(`/api/workflows/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Live (renamed)' }),
      });
      expect(rename.status).toBe(200);
    });

    it('leaves CRM sequences out of the gate', async () => {
      const request = app();
      const { id } = await create(request, {
        name: 'Sequence',
        tags: ['__type:sequence'],
        triggers: [{ id: 'trigger-enrollment', type: 'manual' }],
        steps: [{ id: 'step-1', type: 'delay', config: { days: 1 } }],
      });
      expect((await setStatus(request, id, 'active')).status).toBe(200);
    });

    it('excludes sequences from the list when asked', async () => {
      const request = app();
      const { id: sequenceId } = await create(request, { name: 'Hidden sequence', tags: ['__type:sequence'] });
      const { id: workflowId } = await create(request, { name: 'Visible workflow' });

      const res = await request('/api/workflows?excludeTags=__type:sequence&limit=100');
      const ids = ((await res.json()) as { data: Array<{ id: string }> }).data.map((w) => w.id);
      expect(ids).toContain(workflowId);
      expect(ids).not.toContain(sequenceId);
    });
  });

  it('GET /:id returns 404 for a missing workflow', async () => {
    const { request } = createTestApp('/api/workflows', workflowsRoutes, {
      context: { permissions: permissions('workflows:read'), tenantDb: db },
    });
    const res = await request('/api/workflows/wf_missing_123');
    expect(res.status).toBe(404);
  });
});
