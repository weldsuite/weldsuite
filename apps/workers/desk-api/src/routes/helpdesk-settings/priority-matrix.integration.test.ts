/**
 * /api/helpdesk-settings/priority-matrix on pglite: the ITIL impact ×
 * urgency grid in `helpdesk_settings.tickets.priorityMatrix`, its default,
 * the save (insert and update branch) and its refusals.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { isNull } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { helpdeskSettingsRoutes } from './index';

const BASE = '/api/helpdesk-settings';
const URL = `${BASE}/priority-matrix`;

let db: Database;

const app = (...keys: string[]) =>
  createTestApp(BASE, helpdeskSettingsRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });

const put = (body: unknown, keys = ['settings:update', 'settings:read']) =>
  app(...keys).request(URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const DEFAULT_GRID = {
  low: { low: 'low', medium: 'low', high: 'medium' },
  medium: { low: 'low', medium: 'medium', high: 'high' },
  high: { low: 'medium', medium: 'high', high: 'urgent' },
};

const CUSTOM_GRID = {
  low: { low: 'low', medium: 'low', high: 'low' },
  medium: { low: 'medium', medium: 'medium', high: 'medium' },
  high: { low: 'high', medium: 'urgent', high: 'urgent' },
};

async function ticketsSection() {
  const [row] = await db
    .select({ tickets: schema.helpdeskSettings.tickets })
    .from(schema.helpdeskSettings)
    .where(isNull(schema.helpdeskSettings.deletedAt))
    .limit(1);
  return (row?.tickets ?? null) as Record<string, unknown> | null;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

describe('/api/helpdesk-settings/priority-matrix', () => {
  it('answers the default ITIL grid, off, before anything is saved', async () => {
    const res = await app('settings:read').request(URL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { enabled: false, matrix: DEFAULT_GRID } });
  });

  it('creates the settings row with the matrix', async () => {
    const res = await put({ enabled: true, matrix: CUSTOM_GRID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { enabled: true, matrix: CUSTOM_GRID } });
    expect((await ticketsSection())?.priorityMatrix).toEqual({ enabled: true, matrix: CUSTOM_GRID });

    const read = await app('settings:read').request(URL);
    expect(await read.json()).toEqual({ data: { enabled: true, matrix: CUSTOM_GRID } });
  });

  it('keeps the other ticket settings when it saves, and they keep it', async () => {
    const tickets = await app('settings:update').request(`${BASE}/tickets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultPriority: 'high' }),
    });
    expect(tickets.status).toBe(200);
    expect(await ticketsSection()).toMatchObject({ defaultPriority: 'high', priorityMatrix: { enabled: true } });

    const res = await put({ enabled: false, matrix: DEFAULT_GRID });
    expect(res.status).toBe(200);
    expect(await ticketsSection()).toMatchObject({
      defaultPriority: 'high',
      priorityMatrix: { enabled: false, matrix: DEFAULT_GRID },
    });
  });

  it('refuses a cell that is not a priority, a missing row and a missing flag', async () => {
    expect((await put({ enabled: true, matrix: { ...DEFAULT_GRID, high: { ...DEFAULT_GRID.high, high: 'critical' } } })).status).toBe(400);
    expect((await put({ enabled: true, matrix: { low: DEFAULT_GRID.low, medium: DEFAULT_GRID.medium } })).status).toBe(400);
    expect((await put({ matrix: DEFAULT_GRID })).status).toBe(400);
  });

  it('needs settings:read to read and settings:update to save', async () => {
    expect((await app('conversations:read').request(URL)).status).toBe(403);
    expect((await put({ enabled: true, matrix: DEFAULT_GRID }, ['settings:read'])).status).toBe(403);
  });
});
