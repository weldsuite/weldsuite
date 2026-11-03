/**
 * Every /api/printnode route on pglite: the PrintNode config kept under
 * `customSettings.printnode` of the workspace's live `workspace_settings` row
 * (whichever that is: unlike parcel-settings, not the Clerk org id's). Runs
 * against Rust in conformance mode.
 *
 * The tests run in order on one database.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { eq, isNull } from 'drizzle-orm';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { printNodeRoutes } from './index';

const BASE = '/api/printnode';
const { workspaceSettings } = schema;

let db: Database;

const app = (...keys: string[]) =>
  createTestApp(BASE, printNodeRoutes, { context: { permissions: permissions(...keys), tenantDb: db } });
const put = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const read = async () => {
  const res = await app('general:read').request(BASE);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: unknown }).data;
};
const liveRows = () => db.select().from(workspaceSettings).where(isNull(workspaceSettings.deletedAt));

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = new Date(Date.UTC(2026, 0, 1));
  // A deleted settings row is no settings row.
  await db.insert(workspaceSettings).values({
    id: 'ws_deleted',
    customSettings: { printnode: { apiKey: 'old' } },
    createdAt: at,
    updatedAt: at,
    deletedAt: at,
  });
}, 60_000);

describe('/api/printnode', () => {
  it('GET / answers null before anything is saved', async () => {
    expect(await read()).toBeNull();
  });

  it('PUT / creates the settings row (201) and stores the body as sent', async () => {
    const body = { apiKey: 'pn_key', defaultPrinterId: 42, options: { copies: 2 } };
    const res = await app('general:update').request(BASE, put(body));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: body });
    const rows = await liveRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toMatch(/^ws_[0-9a-z]+$/);
    expect(rows[0]?.customSettings).toEqual({ printnode: body });
    expect(await read()).toEqual(body);
  });

  it('PUT / then updates (200): the config is replaced, the other custom settings kept', async () => {
    const [row] = await liveRows();
    await db
      .update(workspaceSettings)
      .set({ customSettings: { printnode: { apiKey: 'pn_key', defaultPrinterId: 42 }, parcel: { labelSize: 'A6' } } })
      .where(eq(workspaceSettings.id, row!.id));
    const res = await app('general:update').request(BASE, put({ apiKey: 'pn_other' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { apiKey: 'pn_other' } });
    expect((await liveRows())[0]?.customSettings).toEqual({ printnode: { apiKey: 'pn_other' }, parcel: { labelSize: 'A6' } });
  });

  it("disconnects with an empty key; a row without custom settings reads as null", async () => {
    const disconnect = await app('general:update').request(BASE, put({ apiKey: '' }));
    expect(disconnect.status).toBe(200);
    expect(await read()).toEqual({ apiKey: '' });
    const [row] = await liveRows();
    await db.update(workspaceSettings).set({ customSettings: null }).where(eq(workspaceSettings.id, row!.id));
    expect(await read()).toBeNull();
    const res = await app('general:update').request(BASE, put({ apiKey: 'pn_again' }));
    expect(res.status).toBe(200);
    expect((await liveRows())[0]?.customSettings).toEqual({ printnode: { apiKey: 'pn_again' } });
  });

  it('PUT / refuses a body without a string apiKey (400)', async () => {
    const { request } = app('general:update');
    for (const body of [{}, { apiKey: 5 }, { apiKey: null }, ['pn_key']]) {
      expect((await request(BASE, put(body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(await read()).toEqual({ apiKey: 'pn_again' });
  });

  it('GET / needs general:read; PUT / needs general:update (403)', async () => {
    expect((await app('general:update').request(BASE)).status).toBe(403);
    expect((await app('general:read').request(BASE, put({ apiKey: 'x' }))).status).toBe(403);
  });
});
