/**
 * Project custom fields (TASK-1003 follow-up): values are written to and read
 * from `custom_field_values` only — `projects` has no blob column.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { projectsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.customFieldDefinitions).values([
    { id: 'cfd_prj_budget_code', entityType: 'project', name: 'Budget code', slug: 'budget_code', fieldType: 'text' },
    { id: 'cfd_prj_headcount', entityType: 'project', name: 'Headcount', slug: 'headcount', fieldType: 'number' },
    {
      id: 'cfd_prj_phase',
      entityType: 'project',
      name: 'Phase',
      slug: 'phase',
      fieldType: 'single_select',
      options: [{ label: 'Discovery', value: 'discovery' }, { label: 'Build', value: 'build' }],
    },
    // Same slug on another entity type: must not leak into projects.
    { id: 'cfd_task_phase', entityType: 'task', name: 'Phase', slug: 'phase', fieldType: 'text' },
  ]);
}, 60_000);

function app() {
  return createTestApp('/api/projects', projectsRoutes, {
    context: {
      permissions: permissions('projects:read', 'projects:create', 'projects:update', 'projects:scope:all'),
      tenantDb: db,
    },
  });
}

function send(method: string, path: string, body: unknown) {
  return app().request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getProject(id: string) {
  const res = await app().request(`/api/projects/${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { id: string; customFields?: Record<string, unknown> } }).data;
}

async function storedValues(projectId: string) {
  return db
    .select()
    .from(schema.customFieldValues)
    .where(and(eq(schema.customFieldValues.entityType, 'project'), eq(schema.customFieldValues.entityId, projectId)));
}

async function createProject(body: Record<string, unknown>) {
  const res = await send('POST', '/api/projects', { name: 'Custom field project', ...body });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

describe('/api/projects · custom fields', () => {
  it('POST stores the values in custom_field_values and GET hydrates them', async () => {
    const id = await createProject({ customFields: { budget_code: 'BC-42', headcount: '7', phase: 'build' } });

    const rows = await storedValues(id);
    expect(rows).toHaveLength(3);
    // Coerced to the field's typed column.
    expect(rows.find((r) => r.fieldId === 'cfd_prj_headcount')?.valueNumber).toBe(7);

    const project = await getProject(id);
    expect(project.customFields).toEqual({ budget_code: 'BC-42', headcount: 7, phase: 'build' });
  });

  it('PATCH replaces the full set: a field left out is cleared', async () => {
    const id = await createProject({ customFields: { budget_code: 'BC-1', headcount: 3 } });

    const res = await send('PATCH', `/api/projects/${id}`, { customFields: { budget_code: 'BC-2' } });
    expect(res.status).toBe(200);

    expect((await getProject(id)).customFields).toEqual({ budget_code: 'BC-2' });
    expect(await storedValues(id)).toHaveLength(1);
  });

  it('PATCH without customFields leaves the stored values alone', async () => {
    const id = await createProject({ customFields: { budget_code: 'KEEP' } });
    const res = await send('PATCH', `/api/projects/${id}`, { name: 'Renamed' });
    expect(res.status).toBe(200);
    expect((await getProject(id)).customFields).toEqual({ budget_code: 'KEEP' });
  });

  it('PATCH with null clears every value', async () => {
    const id = await createProject({ customFields: { budget_code: 'GONE', phase: 'discovery' } });
    const res = await send('PATCH', `/api/projects/${id}`, { customFields: null });
    expect(res.status).toBe(200);
    expect(await storedValues(id)).toHaveLength(0);
    expect((await getProject(id)).customFields).toBeUndefined();
  });

  it('refuses an invalid value with 400 and writes nothing', async () => {
    const id = await createProject({ name: 'Before', customFields: { phase: 'build' } });

    const bad = await send('PATCH', `/api/projects/${id}`, { name: 'After', customFields: { phase: 'not-an-option' } });
    expect(bad.status).toBe(400);

    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).limit(1);
    expect(row?.name).toBe('Before');
    expect((await getProject(id)).customFields).toEqual({ phase: 'build' });

    const badCreate = await send('POST', '/api/projects', { name: 'Bad', customFields: { headcount: 'many' } });
    expect(badCreate.status).toBe(400);
  });

  it('ignores slugs without a project definition', async () => {
    const id = await createProject({ customFields: { budget_code: 'BC-9', unknown_slug: 'x' } });
    expect((await getProject(id)).customFields).toEqual({ budget_code: 'BC-9' });
  });

  it('GET / hydrates each project in the page', async () => {
    const id = await createProject({ name: 'Listed', customFields: { headcount: 12 } });
    const res = await app().request('/api/projects?limit=100');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; customFields?: Record<string, unknown> }> };
    expect(body.data.find((p) => p.id === id)?.customFields).toEqual({ headcount: 12 });
  });
});
