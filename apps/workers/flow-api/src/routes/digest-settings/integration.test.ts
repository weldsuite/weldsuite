/**
 * /api/digest-settings: the defaults before anything is saved, the tenant
 * row written on PUT, and the schedule mirrored into the master database's
 * `digest_schedules` (created, then updated). Runs against the TypeScript
 * worker and, in conformance mode, the Rust backend.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
}));

import { digestSettingsRoutes } from './index';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
  await master.insert(masterSchema.workspaces).values({
    id: 'ws_test_default',
    clerkOrgId: 'org_test_default',
    name: 'Acme',
    slug: 'digest-acme',
  });
  await db.insert(schema.workspaceSettings).values({ id: 'wss_digest', timezone: 'Europe/Amsterdam' } as never);
}, 180_000);

function app(keys: string[], context: Record<string, unknown> = {}) {
  return createTestApp('/api/digest-settings', digestSettingsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, masterDb: master, ...context },
  });
}

const BODY = {
  enabled: true,
  sendHour: 7,
  taskTypes: { projectTasks: true, personalTasks: false },
  sections: { overdue: true, dueToday: true, dueThisWeek: false },
};

function put(body: unknown, keys = ['settings:manage'], context: Record<string, unknown> = {}) {
  return app(keys, context).request('/api/digest-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/digest-settings', () => {
  it('answers the defaults before anything is saved', async () => {
    const res = await app(['settings:read']).request('/api/digest-settings');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string | null; sendHour: number } };
    expect(data.id).toBeNull();
    expect(data.sendHour).toBe(8);
  });

  it('saves the settings and mirrors the schedule into the master database', async () => {
    const res = await put(BODY);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string; sendHour: number } };
    expect(data.sendHour).toBe(7);

    const [schedule] = await master
      .select()
      .from(masterSchema.digestSchedules)
      .where(eq(masterSchema.digestSchedules.workspaceId, 'ws_test_default'));
    expect(schedule?.sendHour).toBe(7);
    expect(schedule?.timezone).toBe('Europe/Amsterdam');

    const again = await put({ ...BODY, enabled: false, sendHour: 18 });
    expect(again.status).toBe(200);
    const [updated] = await master
      .select()
      .from(masterSchema.digestSchedules)
      .where(eq(masterSchema.digestSchedules.workspaceId, 'ws_test_default'));
    expect(updated?.enabled).toBe(false);
    expect(updated?.sendHour).toBe(18);

    const read = await app(['settings:read']).request('/api/digest-settings');
    expect(((await read.json()) as { data: { sendHour: number } }).data.sendHour).toBe(18);
  });

  it('refuses a bad body, a caller without settings:manage and one without an organization', async () => {
    expect((await put({ ...BODY, sendHour: 24 })).status).toBe(400);
    expect((await put({ enabled: true })).status).toBe(400);
    expect((await put(BODY, ['settings:read'])).status).toBe(403);
    expect((await put(BODY, ['settings:manage'], { orgId: null, clerkOrgId: null })).status).toBe(400);
  });
});
