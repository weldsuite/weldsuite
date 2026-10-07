/**
 * Route-level tests for the template gallery: built-in starter templates are
 * listed next to the workspace's own (translated per `locale`), "use template"
 * creates a draft through the normal create path (branch structure intact,
 * webhook triggers provisioned), "save as template" snapshots a workflow, and
 * built-ins can't be edited or deleted. Permissions per route.
 *
 * `getMasterDb` is mocked to a pglite master DB: using the webhook starter
 * template provisions its webhook in the master registry, like any save.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database, type MasterDatabase } from '@weldsuite/worker-kit/db';
import type { WorkflowTemplateItem } from '@weldsuite/app-api-client/schemas/weldconnect-templates';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEvent: vi.fn() };
});

let masterDb: MasterDatabase;
vi.mock('@weldsuite/worker-kit/db', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/worker-kit/db')>('@weldsuite/worker-kit/db');
  return { ...actual, getMasterDb: () => masterDb };
});

// Imported AFTER the mocks above are registered.
const { workflowTemplatesRoutes } = await import('./index');
const { publishEntityEvent } = await import('@weldsuite/entity-events');

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
}, 60_000);

const ALL = [
  'workflow-templates:read',
  'workflow-templates:create',
  'workflow-templates:update',
  'workflow-templates:delete',
  'workflows:read',
  'workflows:create',
];

function app(granted: string[] = ALL) {
  return createTestApp('/api/workflow-templates', workflowTemplatesRoutes, {
    context: { permissions: permissions(...granted), tenantDb: db },
    env: { SCHEDULE_INDEX: undefined } as never,
  }).request;
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function insertWorkflow(values: { tags?: string[] } = {}) {
  const id = `wf_test_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date();
  await db.insert(schema.workflows).values({
    id,
    name: 'Lead welcome',
    description: 'Greets new leads',
    status: 'active',
    triggers: [{ id: 't1', type: 'entity_event', entityType: 'lead', eventType: 'created', isEnabled: true }] as never,
    steps: [{ id: 's1', type: 'send_email', config: { to: '{{trigger.record.email}}', subject: 'Hi', body: 'Hello' } }] as never,
    settings: { notifyOnError: true },
    tags: ['onboarding'],
    createdBy: 'user_test',
    version: 1,
    executionCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
    ...values,
  });
  return id;
}

async function workflowRow(id: string) {
  const [row] = await db.select().from(schema.workflows).where(eq(schema.workflows.id, id));
  return row;
}

describe('GET /api/workflow-templates', () => {
  it('lists the built-in starter templates with what they still need set up', async () => {
    const res = await app()('/api/workflow-templates?source=builtin');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: WorkflowTemplateItem[]; pagination: { totalCount: number } };
    expect(body.data.length).toBeGreaterThanOrEqual(6);
    expect(body.data.every((t) => t.source === 'builtin' && t.id.startsWith('builtin_'))).toBe(true);
    expect(body.pagination.totalCount).toBe(body.data.length);

    const followUp = body.data.find((t) => t.id === 'builtin_lead_follow_up')!;
    expect(followUp.name).toBe('Follow up on new leads');
    expect(followUp.setupIssues).toEqual([
      expect.objectContaining({ code: 'missing_field', stepId: 'step_task', field: 'projectId' }),
    ]);
    const sheet = body.data.find((t) => t.id === 'builtin_company_sheet')!;
    expect(sheet.requiredIntegrations).toEqual(['google_sheets']);
  });

  it('translates built-ins with ?locale and falls back to English for other languages', async () => {
    const nl = (await (await app()('/api/workflow-templates?source=builtin&locale=nl')).json()) as { data: WorkflowTemplateItem[] };
    expect(nl.data.find((t) => t.id === 'builtin_lead_follow_up')!.name).toBe('Nieuwe leads opvolgen');
    const de = (await (await app()('/api/workflow-templates?source=builtin&locale=de-DE')).json()) as { data: WorkflowTemplateItem[] };
    expect(de.data.find((t) => t.id === 'builtin_lead_follow_up')!.name).toBe('Follow up on new leads');
  });

  it('lists workspace templates after the built-ins, filtered by search and category', async () => {
    const request = app();
    const created = await request('/api/workflow-templates', json({ name: 'Invoice chaser', category: 'finance', steps: [] }));
    expect(created.status).toBe(201);

    const all = (await (await request('/api/workflow-templates?limit=100')).json()) as {
      data: WorkflowTemplateItem[];
      pagination: { totalCount: number };
    };
    const sources = all.data.map((t) => t.source);
    expect(sources.indexOf('workspace')).toBeGreaterThan(sources.lastIndexOf('builtin'));
    expect(all.data.some((t) => t.name === 'Invoice chaser' && t.source === 'workspace')).toBe(true);

    const searched = (await (await request('/api/workflow-templates?search=invoice')).json()) as { data: WorkflowTemplateItem[] };
    expect(searched.data.map((t) => t.name)).toEqual(['Invoice chaser']);

    const sales = (await (await request('/api/workflow-templates?category=sales')).json()) as { data: WorkflowTemplateItem[] };
    expect(sales.data.length).toBeGreaterThan(0);
    expect(sales.data.every((t) => t.category === 'sales')).toBe(true);

    const own = (await (await request('/api/workflow-templates?source=workspace')).json()) as { data: WorkflowTemplateItem[] };
    expect(own.data.every((t) => t.source === 'workspace')).toBe(true);
  });

  it('needs workflow-templates:read', async () => {
    expect((await app(['workflows:read'])('/api/workflow-templates')).status).toBe(403);
  });
});

describe('GET /api/workflow-templates/:id', () => {
  it('returns a built-in by id, and 404 for an unknown one', async () => {
    const res = await app()('/api/workflow-templates/builtin_contact_approval?locale=nl');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: WorkflowTemplateItem };
    expect(data.name).toBe('Nieuwe contacten beoordelen');
    expect((await app()('/api/workflow-templates/builtin_nope')).status).toBe(404);
  });
});

describe('POST /api/workflow-templates/:id/use', () => {
  it('creates a draft workflow from a built-in, keeping its branches, and counts it as created', async () => {
    const res = await app()('/api/workflow-templates/builtin_contact_approval/use', json({ locale: 'nl' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; templateId: string; name: string } };
    expect(data).toMatchObject({ templateId: 'builtin_contact_approval', name: 'Nieuwe contacten beoordelen' });

    const row = await workflowRow(data.id);
    expect(row.status).toBe('draft');
    expect(row.templateId).toBe('builtin_contact_approval');
    expect(row.createdBy).toBe('user_test_default');
    const steps = row.steps as Array<{ id: string; name: string; parentBranchId?: string }>;
    expect(steps.map((s) => [s.id, s.parentBranchId ?? null])).toEqual([
      ['step_review', null],
      ['step_check', null],
      ['step_tag', 'step_check_if'],
      ['step_notify', 'step_check_if_not'],
    ]);
    expect(steps[0].name).toBe('Om goedkeuring vragen');
    expect(row.triggers).toEqual([expect.objectContaining({ type: 'entity_event', entityType: 'person', eventType: 'created' })]);
    expect(publishEntityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'workflow', action: 'created', entityId: data.id }),
    );
  });

  it('provisions the webhook of a webhook-triggered starter template right away', async () => {
    const res = await app()('/api/workflow-templates/builtin_webhook_contact/use', json({ name: 'Website form' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; name: string } };
    expect(data.name).toBe('Website form');
    const [webhook] = await db
      .select()
      .from(schema.workflowWebhooks)
      .where(eq(schema.workflowWebhooks.workflowId, data.id));
    expect(webhook?.triggerId).toBe('trigger_main');
  });

  it('copies a workspace template, bumps its usage count and never makes a CRM sequence', async () => {
    const request = app();
    const created = await request(
      '/api/workflow-templates',
      json({
        name: 'Tagged',
        tags: ['__type:sequence', 'keep'],
        triggers: [{ id: 't1', type: 'webhook' }],
        steps: [{ id: 's1', type: 'http_request', config: { url: 'https://example.test' } }],
      }),
    );
    const { data: template } = (await created.json()) as { data: { id: string } };

    const res = await request(`/api/workflow-templates/${template.id}/use`, json({}));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const row = await workflowRow(data.id);
    expect(row.tags).toEqual(['keep']);
    expect(row.status).toBe('draft');

    const [templateRow] = await db.select().from(schema.workflowTemplates).where(eq(schema.workflowTemplates.id, template.id));
    expect(templateRow.usageCount).toBe(1);
  });

  it('404s for an unknown template, and needs workflows:create', async () => {
    expect((await app()('/api/workflow-templates/tmpl_missing/use', json({}))).status).toBe(404);
    const denied = await app(['workflow-templates:read'])('/api/workflow-templates/builtin_lead_follow_up/use', json({}));
    expect(denied.status).toBe(403);
  });
});

describe('POST /api/workflow-templates/from-workflow/:workflowId', () => {
  it('saves a workflow as a workspace template', async () => {
    const workflowId = await insertWorkflow();
    const request = app();
    const res = await request(
      `/api/workflow-templates/from-workflow/${workflowId}`,
      json({ name: 'Lead welcome template', category: 'sales' }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; name: string } };
    expect(data.name).toBe('Lead welcome template');

    const { data: item } = (await (await request(`/api/workflow-templates/${data.id}`)).json()) as { data: WorkflowTemplateItem };
    expect(item).toMatchObject({ source: 'workspace', category: 'sales', description: 'Greets new leads', setupIssues: [] });
    expect(item.steps).toEqual([expect.objectContaining({ id: 's1', type: 'send_email' })]);
  });

  it('refuses CRM sequences and unknown workflows', async () => {
    const sequenceId = await insertWorkflow({ tags: ['__type:sequence'] });
    expect((await app()(`/api/workflow-templates/from-workflow/${sequenceId}`, json({}))).status).toBe(400);
    expect((await app()('/api/workflow-templates/from-workflow/wf_missing', json({}))).status).toBe(404);
  });

  it('needs workflow-templates:create', async () => {
    const workflowId = await insertWorkflow();
    const res = await app(['workflow-templates:read', 'workflows:read'])(
      `/api/workflow-templates/from-workflow/${workflowId}`,
      json({}),
    );
    expect(res.status).toBe(403);
  });
});

describe('editing and deleting templates', () => {
  it('renames and deletes a workspace template', async () => {
    const request = app();
    const created = await request('/api/workflow-templates', json({ name: 'Old name' }));
    const { data } = (await created.json()) as { data: { id: string } };

    const patched = await request(`/api/workflow-templates/${data.id}`, json({ name: 'New name', category: 'support' }, 'PATCH'));
    expect(patched.status).toBe(200);
    const { data: item } = (await (await request(`/api/workflow-templates/${data.id}`)).json()) as { data: WorkflowTemplateItem };
    expect(item).toMatchObject({ name: 'New name', category: 'support' });

    const deleted = await request(`/api/workflow-templates/${data.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect((await request(`/api/workflow-templates/${data.id}`)).status).toBe(404);
  });

  it('keeps built-ins read-only', async () => {
    const request = app();
    expect((await request('/api/workflow-templates/builtin_lead_follow_up', json({ name: 'Mine' }, 'PATCH'))).status).toBe(403);
    expect((await request('/api/workflow-templates/builtin_lead_follow_up', { method: 'DELETE' })).status).toBe(403);
  });

  it('needs workflow-templates:delete to delete', async () => {
    const created = await app()('/api/workflow-templates', json({ name: 'Keep me' }));
    const { data } = (await created.json()) as { data: { id: string } };
    const res = await app(['workflow-templates:read', 'workflow-templates:update'])(`/api/workflow-templates/${data.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(403);
  });
});
