/**
 * DB-backed tests for /api/custom-fields create/update guards (TASK-1049,
 * TASK-1003): a select field must keep at least one option, and a duplicate
 * slug answers 409.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { customFieldsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function app() {
  return createTestApp('/api/custom-fields', customFieldsRoutes, {
    context: { permissions: permissions('settings:manage', 'settings:read'), tenantDb: db },
  });
}

function send(method: string, path: string, body: unknown) {
  return app().request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/custom-fields · select options', () => {
  it.each(['single_select', 'multi_select'])('POST refuses a %s field without options', async (fieldType) => {
    const res = await send('POST', '/api/custom-fields', {
      entityType: 'company',
      name: 'Tier',
      slug: `tier_${fieldType}`,
      fieldType,
    });
    expect(res.status).toBe(400);
  });

  it('POST refuses a select field whose only option is blank', async () => {
    const res = await send('POST', '/api/custom-fields', {
      entityType: 'company',
      name: 'Tier',
      slug: 'tier_blank',
      fieldType: 'single_select',
      options: [{ label: ' ', value: ' ' }],
    });
    expect(res.status).toBe(400);
  });

  it('POST accepts a select field with an option, and a text field without', async () => {
    const select = await send('POST', '/api/custom-fields', {
      entityType: 'company',
      name: 'Tier',
      slug: 'tier_ok',
      fieldType: 'single_select',
      options: [{ label: 'Gold', value: 'gold' }],
    });
    expect(select.status).toBe(201);

    const text = await send('POST', '/api/custom-fields', {
      entityType: 'company',
      name: 'Notes',
      slug: 'notes_ok',
      fieldType: 'text',
    });
    expect(text.status).toBe(201);
  });

  it('PUT refuses emptying the options of a select field, or turning a field into one without options', async () => {
    const created = await send('POST', '/api/custom-fields', {
      entityType: 'company',
      name: 'Region',
      slug: 'region_put',
      fieldType: 'single_select',
      options: [{ label: 'EU', value: 'eu' }],
    });
    const { data } = (await created.json()) as { data: { id: string } };

    const emptied = await send('PUT', `/api/custom-fields/${data.id}`, { options: [] });
    expect(emptied.status).toBe(400);

    const text = await send('POST', '/api/custom-fields', {
      entityType: 'company',
      name: 'Plain',
      slug: 'plain_put',
      fieldType: 'text',
    });
    const { data: textField } = (await text.json()) as { data: { id: string } };
    const toSelect = await send('PUT', `/api/custom-fields/${textField.id}`, { fieldType: 'multi_select' });
    expect(toSelect.status).toBe(400);

    const renamed = await send('PUT', `/api/custom-fields/${data.id}`, { name: 'Sales region' });
    expect(renamed.status).toBe(200);
  });
});

describe('/api/custom-fields · slug uniqueness', () => {
  it('POST answers 409 for a slug already used on the same entity type', async () => {
    const body = { entityType: 'person', name: 'Size', slug: 'size_dup', fieldType: 'text' };
    expect((await send('POST', '/api/custom-fields', body)).status).toBe(201);
    const dup = await send('POST', '/api/custom-fields', body);
    expect(dup.status).toBe(409);
  });
});
