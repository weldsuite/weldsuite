/**
 * Every /api/helpdesk-workflows route on pglite: the plain CRUD shape through
 * the shared suite (../../test/crud-suite.ts), then GET /stats, GET
 * /for-chaining, PATCH /:id/status, POST /:id/duplicate, the default
 * workflows (POST /seed-defaults, POST /reset-defaults) and POST
 * /executions/:executionId/resume. Runs against Rust in conformance mode
 * (rust/conformance/suites.json).
 *
 * The tests give no HELPDESK_WORKFLOW binding, so resume takes the local
 * fallback that rewrites the execution row.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { describeCrud } from '../../test/crud-suite';
import { helpdeskWorkflowsRoutes } from './index';

const BASE = '/api/helpdesk-workflows';
const USER = 'user_test_default';
const TEMPLATE_IDS = ['hwf_tpl_collect_info', 'hwf_tpl_welcome', 'hwf_tpl_auto_assign', 'hwf_tpl_csat_resolved'];

describeCrud(BASE, {
  base: BASE,
  routes: helpdeskWorkflowsRoutes,
  table: schema.helpdeskWorkflows,
  gates: { read: 'tickets:read', create: 'tickets:create', update: 'tickets:update', delete: 'tickets:delete' },
  seed: (n) => ({ name: `Workflow ${n}` }),
  // `trigger`, `conditions`, `actions`, `isActive`, `priority` and `metadata`
  // are in the schema but are no columns: Drizzle leaves them out.
  valid: {
    name: 'Route VIPs',
    description: 'Sends VIPs to the senior team',
    trigger: 'conversation.created',
    conditions: [{ field: 'tags' }],
    actions: [{ type: 'assign' }],
    isActive: true,
    priority: 1,
    metadata: { a: 1 },
  },
  unstorable: { name: 'Bad status', status: 'x'.repeat(21) },
  invalid: [
    { name: '' },
    { name: 'x'.repeat(256) },
    { name: 'x', trigger: 'x'.repeat(51) },
    { name: 'x', priority: 1.5 },
    { name: 'x', isActive: 'yes' },
    { description: 'no name' },
  ],
  patch: { name: 'Renamed', description: 'Changed', status: 'paused' },
  invalidPatch: { priority: 'high' },
  filters: [{ query: 'search=Needle', match: { name: 'Needle Workflow' } }],
});

type Row = Record<string, unknown>;
interface ListBody {
  data: Row[];
  pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe(`${BASE} · workflow specifics`, () => {
  let db: Database;
  const app = (...keys: string[]) =>
    createTestApp(BASE, helpdeskWorkflowsRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });
  const at = (s: number) => new Date(Date.UTC(2026, 4, 1, 9, 0, s));
  const ids = (rows: Row[]) => rows.map((r) => r.id);

  async function workflow(id: string) {
    const [row] = await db.select().from(schema.helpdeskWorkflows).where(eq(schema.helpdeskWorkflows.id, id));
    return row;
  }

  async function execution(id: string) {
    const [row] = await db
      .select()
      .from(schema.helpdeskWorkflowExecutions)
      .where(eq(schema.helpdeskWorkflowExecutions.id, id));
    return row!;
  }

  beforeAll(async () => {
    // The same pglite as the suite above (one per file): start from nothing.
    db = (await createPgliteDb()).db;
    await db.delete(schema.helpdeskWorkflowExecutions);
    await db.delete(schema.helpdeskWorkflows);
    const tie = new Date(Date.UTC(2026, 4, 2));
    await db.insert(schema.helpdeskWorkflows).values([
      {
        id: 'wf_active',
        name: 'Greeter',
        description: 'Says hello',
        status: 'active',
        triggers: [{ id: 'trg_1', type: 'entity_event', name: 'Created', isEnabled: true, config: {} }] as never,
        steps: [{ id: 'step_1', type: 'send_message', name: 'Hi', order: 1, config: {} }] as never,
        settings: { logLevel: 'info' } as never,
        tags: ['team'],
        folderId: 'fold_1',
        version: 3,
        executionCount: 12,
        createdBy: 'user_author',
        createdAt: at(1),
        updatedAt: at(1),
      },
      { id: 'wf_draft', name: 'Draft flow', createdAt: at(2), updatedAt: at(2) },
      { id: 'wf_paused', name: 'Paused flow', status: 'paused', createdAt: at(3), updatedAt: at(3) },
      { id: 'wf_archived', name: 'Old flow', status: 'archived', createdAt: at(4), updatedAt: at(4) },
      { id: 'wf_gone', name: 'Gone flow', status: 'active', createdAt: at(5), updatedAt: at(5), deletedAt: at(6) },
      { id: 'wf_t1', name: 'Tie one', status: 'active', createdAt: tie, updatedAt: tie },
      { id: 'wf_t2', name: 'Tie two', createdAt: tie, updatedAt: tie },
      // A soft-deleted default still counts as present for /seed-defaults.
      {
        id: 'wf_tpl_old',
        name: 'Old welcome',
        templateId: 'hwf_tpl_welcome',
        createdAt: at(7),
        updatedAt: at(7),
        deletedAt: at(8),
      },
    ]);
    await db.insert(schema.helpdeskWorkflowExecutions).values([
      { id: 'ex_running', helpdeskWorkflowId: 'wf_active', status: 'running', createdAt: at(1), updatedAt: at(1) },
      {
        id: 'ex_waiting',
        helpdeskWorkflowId: 'wf_active',
        status: 'waiting_for_input',
        conversationId: 'conv_1',
        currentStepIndex: 2,
        executionContext: {
          variables: { name: 'Ann' },
          stepOutputs: { step_0: { ok: true } },
          waitingForInput: { conversationId: 'conv_1', messageId: 'msg_1', stepId: 'step_1', stepType: 'send_choices' },
          waitingStepId: 'step_1',
        },
        createdAt: at(2),
        updatedAt: at(2),
      },
      {
        id: 'ex_bare',
        helpdeskWorkflowId: 'wf_active',
        status: 'waiting_for_input',
        currentStepIndex: null,
        createdAt: at(3),
        updatedAt: at(3),
      },
    ]);
  }, 60_000);

  describe('list', () => {
    it('lists newest first, the id breaking a tie, with the deleted rows left out', async () => {
      const body = (await (await app('tickets:read').request(BASE)).json()) as ListBody;
      expect(ids(body.data)).toEqual(['wf_t2', 'wf_t1', 'wf_archived', 'wf_paused', 'wf_draft', 'wf_active']);
      expect(body.pagination).toEqual({ totalCount: 6, hasMore: false, cursor: null });
    });

    it('pages with a cursor, and searches by name (case-sensitive)', async () => {
      const { request } = app('tickets:read');
      const page = (await (await request(`${BASE}?limit=2&cursor=wf_t2`)).json()) as ListBody;
      expect(ids(page.data)).toEqual(['wf_t1', 'wf_archived']);
      expect(page.pagination).toEqual({ totalCount: 6, hasMore: true, cursor: 'wf_archived' });
      const search = (await (await request(`${BASE}?search=flow`)).json()) as ListBody;
      expect(ids(search.data)).toEqual(['wf_archived', 'wf_paused', 'wf_draft']);
      expect(((await (await request(`${BASE}?search=FLOW`)).json()) as ListBody).data).toEqual([]);
      // An unknown cursor: no cursor condition, and the count drops the search instead.
      const lost = (await (await request(`${BASE}?search=flow&cursor=wf_missing`)).json()) as ListBody;
      expect(ids(lost.data)).toEqual(['wf_archived', 'wf_paused', 'wf_draft']);
      expect(lost.pagination.totalCount).toBe(6);
      const zero = (await (await request(`${BASE}?limit=0`)).json()) as ListBody;
      expect(zero).toEqual({ data: [], pagination: { totalCount: 6, hasMore: true, cursor: null } });
    });

    it('the detail is the whole row', async () => {
      const res = await app('tickets:read').request(`${BASE}/wf_active`);
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: Row };
      expect(data).toMatchObject({ id: 'wf_active', version: 3, executionCount: 12, tags: ['team'] });
      expect((await app('tickets:read').request(`${BASE}/wf_gone`)).status).toBe(404);
    });
  });

  describe('stats and chaining', () => {
    it('GET /stats counts live workflows by status; execution counters are 0', async () => {
      const res = await app('tickets:read').request(`${BASE}/stats`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: {
          totalWorkflows: 6,
          activeWorkflows: 2,
          draftWorkflows: 2,
          pausedWorkflows: 1,
          totalExecutions: 0,
          successfulExecutions: 0,
          failedExecutions: 0,
          pendingExecutions: 0,
        },
      });
      expect((await app().request(`${BASE}/stats`)).status).toBe(403);
    });

    it('GET /for-chaining lists live, unarchived workflows, minus ?exclude', async () => {
      const { request } = app('tickets:read');
      const sorted = (rows: Row[]) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const all = (await (await request(`${BASE}/for-chaining`)).json()) as { data: Row[] };
      expect(sorted(all.data)).toEqual([
        { id: 'wf_active', name: 'Greeter', status: 'active' },
        { id: 'wf_draft', name: 'Draft flow', status: 'draft' },
        { id: 'wf_paused', name: 'Paused flow', status: 'paused' },
        { id: 'wf_t1', name: 'Tie one', status: 'active' },
        { id: 'wf_t2', name: 'Tie two', status: 'draft' },
      ]);
      const excluded = (await (await request(`${BASE}/for-chaining?exclude=wf_active`)).json()) as { data: Row[] };
      expect(ids(sorted(excluded.data))).toEqual(['wf_draft', 'wf_paused', 'wf_t1', 'wf_t2']);
      expect((await app().request(`${BASE}/for-chaining`)).status).toBe(403);
    });
  });

  describe('status and duplicate', () => {
    it('PATCH /:id/status sets the status', async () => {
      const res = await app('tickets:update').request(`${BASE}/wf_draft/status`, json({ status: 'active' }, 'PATCH'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { id: 'wf_draft', status: 'active' } });
      expect((await workflow('wf_draft'))?.status).toBe('active');
    });

    it('PATCH /:id/status refusals', async () => {
      const { request } = app('tickets:update');
      for (const body of [{}, { status: 'deleted' }, { status: 1 }]) {
        expect((await request(`${BASE}/wf_draft/status`, json(body, 'PATCH'))).status).toBe(400);
      }
      const missing = await request(`${BASE}/wf_missing/status`, json({ status: 'paused' }, 'PATCH'));
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({
        error: { code: 'NOT_FOUND', message: "Workflow with ID 'wf_missing' not found" },
      });
      expect((await request(`${BASE}/wf_gone/status`, json({ status: 'paused' }, 'PATCH'))).status).toBe(404);
      expect((await app('tickets:read').request(`${BASE}/wf_draft/status`, json({ status: 'paused' }, 'PATCH'))).status).toBe(403);
    });

    it('POST /:id/duplicate copies the workflow as a draft by the caller', async () => {
      const res = await app('tickets:create').request(`${BASE}/wf_active/duplicate`, json({ name: 'Greeter v2' }));
      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: Row & { id: string } };
      expect(data.id).not.toBe('wf_active');
      expect(data).toMatchObject({
        name: 'Greeter v2',
        description: 'Says hello',
        status: 'draft',
        tags: ['team'],
        folderId: 'fold_1',
        settings: { logLevel: 'info' },
        createdBy: USER,
        // Not copied: the column defaults.
        version: 1,
        executionCount: 0,
        templateId: null,
      });
      expect(data.steps).toEqual([{ id: 'step_1', type: 'send_message', name: 'Hi', order: 1, config: {} }]);
    });

    it('POST /:id/duplicate names the copy "(Copy)" without a name, or with an empty one', async () => {
      const { request } = app('tickets:create');
      for (const body of [{}, { name: '' }]) {
        const res = await request(`${BASE}/wf_paused/duplicate`, json(body));
        expect(res.status).toBe(201);
        expect(((await res.json()) as { data: Row }).data.name).toBe('Paused flow (Copy)');
      }
    });

    it('POST /:id/duplicate refusals', async () => {
      const { request } = app('tickets:create');
      expect((await request(`${BASE}/wf_active/duplicate`, json({ name: 5 }))).status).toBe(400);
      expect((await request(`${BASE}/wf_missing/duplicate`, json({}))).status).toBe(404);
      expect((await request(`${BASE}/wf_gone/duplicate`, json({}))).status).toBe(404);
      expect((await app('tickets:update').request(`${BASE}/wf_active/duplicate`, json({}))).status).toBe(403);
    });

    it('PATCH /:id with only keys that are no columns still answers 200', async () => {
      const res = await app('tickets:update').request(`${BASE}/wf_t1`, json({ isActive: false, priority: 2 }, 'PATCH'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { id: 'wf_t1' } });
    });
  });

  describe('default workflows', () => {
    it('POST /seed-defaults adds the missing defaults (a deleted one counts as present)', async () => {
      const res = await app('tickets:create').request(`${BASE}/seed-defaults`, { method: 'POST' });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        data: { seeded: 3, templateIds: ['hwf_tpl_collect_info', 'hwf_tpl_auto_assign', 'hwf_tpl_csat_resolved'] },
      });
      const rows = await db
        .select()
        .from(schema.helpdeskWorkflows)
        .where(inArray(schema.helpdeskWorkflows.templateId, TEMPLATE_IDS));
      const byTemplate = Object.fromEntries(rows.filter((r) => !r.deletedAt).map((r) => [r.templateId, r]));
      expect(byTemplate.hwf_tpl_collect_info).toMatchObject({
        name: 'Collect Customer Info',
        status: 'active',
        sortOrder: 5,
        createdBy: 'system',
        tags: ['system-default'],
      });
      expect(byTemplate.hwf_tpl_csat_resolved).toMatchObject({ name: 'CSAT After Resolution', status: 'draft', sortOrder: 30 });
      expect(byTemplate.hwf_tpl_welcome).toBeUndefined();
    });

    it('POST /seed-defaults a second time seeds nothing', async () => {
      const res = await app('tickets:create').request(`${BASE}/seed-defaults`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { seeded: 0, message: 'All default workflows already exist' } });
    });

    it('POST /reset-defaults hard-deletes every template row, deleted ones included, and re-creates the four', async () => {
      const res = await app('tickets:update').request(`${BASE}/reset-defaults`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { deleted: 4, created: 4, templateIds: TEMPLATE_IDS } });
      expect(await workflow('wf_tpl_old')).toBeUndefined();
      const rows = await db
        .select()
        .from(schema.helpdeskWorkflows)
        .where(inArray(schema.helpdeskWorkflows.templateId, TEMPLATE_IDS));
      expect(rows.map((r) => r.name).sort()).toEqual(
        ['Auto-Assign Round Robin', 'CSAT After Resolution', 'Collect Customer Info', 'Welcome Message'],
      );
      const welcome = rows.find((r) => r.templateId === 'hwf_tpl_welcome');
      expect(welcome?.triggers).toEqual([
        {
          id: 'trg_welcome',
          type: 'entity_event',
          name: 'New conversation created',
          isEnabled: true,
          config: { type: 'entity_event', entityType: 'helpdesk_conversation', eventType: 'created', channels: ['chat'] },
        },
      ]);
    });

    it('POST /reset-defaults again deletes and re-creates the same four', async () => {
      const res = await app('tickets:update').request(`${BASE}/reset-defaults`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { deleted: 4, created: 4, templateIds: TEMPLATE_IDS } });
    });

    it('seed needs tickets:create, reset needs tickets:update', async () => {
      expect((await app('tickets:update').request(`${BASE}/seed-defaults`, { method: 'POST' })).status).toBe(403);
      expect((await app('tickets:create').request(`${BASE}/reset-defaults`, { method: 'POST' })).status).toBe(403);
    });
  });

  describe('resume an execution', () => {
    const resume = (executionId: string, body: unknown, ...keys: string[]) =>
      app(...(keys.length ? keys : ['tickets:update'])).request(`${BASE}/executions/${executionId}/resume`, json(body));

    it('answers 404 for an execution that does not exist', async () => {
      const res = await resume('ex_missing', { stepId: 'step_1', response: {} });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: 'NOT_FOUND', message: "Execution with ID 'ex_missing' not found" },
      });
    });

    it('answers 400 for an execution that is not waiting for input', async () => {
      const res = await resume('ex_running', { stepId: 'step_1', response: {} });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'BAD_REQUEST', message: 'Execution is not waiting for input (status: running)' },
      });
    });

    it('without the workflow worker, records the response and flips the execution to running', async () => {
      const res = await resume('ex_waiting', { stepId: 'step_1', response: { selectedValue: 'yes', selectedLabel: 'Yes' } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { resumed: true, executionId: 'ex_waiting', forwarded: false } });
      const row = await execution('ex_waiting');
      expect(row.status).toBe('running');
      expect(row.currentStepIndex).toBe(3);
      expect(row.executionContext).toEqual({
        variables: { name: 'Ann' },
        stepOutputs: { step_0: { ok: true }, step_1: { selectedValue: 'yes', selectedLabel: 'Yes' } },
        waitingStepId: 'step_1',
      });
    });

    it('an execution without context or step index starts both', async () => {
      const res = await resume('ex_bare', { stepId: 'step_9', response: {} });
      expect(res.status).toBe(200);
      const row = await execution('ex_bare');
      expect(row.currentStepIndex).toBe(1);
      expect(row.executionContext).toEqual({ variables: {}, stepOutputs: { step_9: {} } });
    });

    it('a resumed execution is no longer waiting', async () => {
      const res = await resume('ex_waiting', { stepId: 'step_1', response: {} });
      expect(res.status).toBe(400);
    });

    it('refuses an invalid body, and needs tickets:update', async () => {
      for (const body of [{}, { stepId: 'step_1' }, { stepId: 1, response: {} }, { stepId: 'step_1', response: 'yes' }]) {
        expect((await resume('ex_running', body)).status).toBe(400);
      }
      expect((await resume('ex_running', { stepId: 's', response: {} }, 'tickets:read')).status).toBe(403);
    });
  });
});
