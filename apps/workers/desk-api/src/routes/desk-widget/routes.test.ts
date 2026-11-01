/**
 * Every /api/desk/widget route on pglite, refusals included: list, create
 * (defaults, and the master `widget_registry` entry the public widget API
 * resolves), read, the partial PATCH (office hours and timezone validation,
 * away message trimming, registry rename and activation) and delete.
 *
 * Nothing is mocked but `getMasterDb`, which hands out the test's master
 * database through `conformanceMasterDb`, so the conformance suite runs these
 * against the Rust backend too.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  const { conformanceMasterDb } = await import('@weldsuite/worker-kit/testing/conformance');
  return { ...actual, getMasterDb: () => conformanceMasterDb(state.master) };
});

import { deskWidgetRoutes } from './index';

const BASE = '/api/desk/widget';
const WORKSPACE = 'ws_test_default';
const { widgetRegistry, workspaces } = masterSchema;
const widgets = schema.deskWidgetSettings;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let db: Database;

const at = (second: number) => new Date(Date.UTC(2026, 2, 1, 8, 0, second));

function app(...keys: string[]) {
  return createTestApp(BASE, deskWidgetRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, masterDb: master },
  });
}

const READ = () => app('settings:read');
const UPDATE = () => app('settings:update', 'settings:read');

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function registryOf(widgetId: string) {
  const [row] = await master.select().from(widgetRegistry).where(eq(widgetRegistry.widgetId, widgetId));
  return row as typeof widgetRegistry.$inferSelect | undefined;
}

async function rowOf(widgetId: string) {
  const [row] = await db.select().from(widgets).where(eq(widgets.widgetId, widgetId));
  return row;
}

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  db = (await createPgliteDb()).db;
  await master.insert(workspaces).values({ id: WORKSPACE, clerkOrgId: 'org_test_default', name: 'Desk', slug: 'desk-widget-ws' });
}, 60_000);

describe('GET /api/desk/widget', () => {
  it('needs settings:read', async () => {
    expect((await app('settings:update').request(BASE)).status).toBe(403);
  });

  it('lists nothing before a widget exists', async () => {
    const res = await READ().request(BASE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });
});

describe('POST /api/desk/widget', () => {
  it('needs settings:update', async () => {
    expect((await READ().request(BASE, send('POST', {}))).status).toBe(403);
  });

  it('validates the name, greeting, branding and allowed domains', async () => {
    for (const body of [
      { widgetName: 'x'.repeat(256) },
      { greeting: 'x'.repeat(501) },
      { branding: { position: 'top' } },
      { branding: { primaryColor: '#'.repeat(31) } },
      { allowedDomains: [5] },
      { allowedDomains: ['x'.repeat(256)] },
      { allowedDomains: 'acme.test' },
    ]) {
      const res = await UPDATE().request(BASE, send('POST', body));
      expect(res.status).toBe(400);
    }
  });

  it('creates a widget with the defaults and registers it in the master database', async () => {
    const res = await UPDATE().request(BASE, send('POST', {}));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> & { id: string; widgetId: string } };
    expect(data).toMatchObject({
      widgetName: 'Chat widget',
      enabled: true,
      greeting: 'Hi — how can we help?',
      branding: { primaryColor: '#2563eb', position: 'right' },
      allowedDomains: [],
      officeHours: null,
      timezone: null,
      awayMessage: null,
      expectedReplyTime: null,
    });
    expect(data.id).toMatch(/^dwgt_/);
    expect(data.widgetId).toMatch(/^widget_/);
    expect(await registryOf(data.widgetId)).toMatchObject({ workspaceId: WORKSPACE, widgetName: 'Chat widget', isActive: true });
  });

  it('creates a widget with its own name, greeting, branding and domains', async () => {
    const res = await UPDATE().request(
      BASE,
      send('POST', {
        widgetName: 'Sales chat',
        greeting: 'Talk to sales',
        branding: { primaryColor: '#000000', backgroundColor: '#ffffff', position: 'left' },
        allowedDomains: ['acme.test', 'shop.acme.test'],
      }),
    );
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { widgetId: string } };
    expect(data).toMatchObject({
      widgetName: 'Sales chat',
      greeting: 'Talk to sales',
      branding: { primaryColor: '#000000', backgroundColor: '#ffffff', position: 'left' },
      allowedDomains: ['acme.test', 'shop.acme.test'],
    });
    expect(await registryOf(data.widgetId)).toMatchObject({ widgetName: 'Sales chat' });
  });
});

describe('/api/desk/widget/:widgetId', () => {
  beforeAll(async () => {
    await db.insert(widgets).values({
      id: 'dwgt_seed',
      widgetId: 'widget_seed',
      widgetName: 'Support',
      enabled: true,
      greeting: 'Hello',
      branding: { primaryColor: '#123456', position: 'right' },
      allowedDomains: ['support.test'],
      createdAt: at(1),
      updatedAt: at(1),
    });
    await master.insert(widgetRegistry).values({
      id: 'wr_seed',
      widgetId: 'widget_seed',
      workspaceId: WORKSPACE,
      widgetName: 'Support',
      isActive: true,
      createdAt: at(1),
      updatedAt: at(1),
    });
  });

  it('lists every widget', async () => {
    const res = await READ().request(BASE);
    const { data } = (await res.json()) as { data: Array<{ widgetName: string }> };
    expect(data.map((w) => w.widgetName).sort()).toEqual(['Chat widget', 'Sales chat', 'Support']);
  });

  it('reads one by its widget id (settings:read)', async () => {
    expect((await app('settings:update').request(`${BASE}/widget_seed`)).status).toBe(403);
    const res = await READ().request(`${BASE}/widget_seed`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        id: 'dwgt_seed',
        createdAt: at(1).toISOString(),
        updatedAt: at(1).toISOString(),
        widgetId: 'widget_seed',
        widgetName: 'Support',
        enabled: true,
        greeting: 'Hello',
        branding: { primaryColor: '#123456', position: 'right' },
        allowedDomains: ['support.test'],
        officeHours: null,
        timezone: null,
        awayMessage: null,
        expectedReplyTime: null,
        identityRequired: false,
      },
    });
  });

  it('is a 404 for an unknown widget id', async () => {
    const res = await READ().request(`${BASE}/widget_missing`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Widget with ID 'widget_missing' not found" } });
  });

  it('PATCH needs settings:update and an existing widget', async () => {
    expect((await READ().request(`${BASE}/widget_seed`, send('PATCH', { greeting: 'x' }))).status).toBe(403);
    const res = await UPDATE().request(`${BASE}/widget_missing`, send('PATCH', { greeting: 'x' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Widget with ID 'widget_missing' not found" } });
  });

  it('PATCH validates office hours, timezone and the other fields', async () => {
    const cases: Array<[unknown, string | null]> = [
      [{ officeHours: { enabled: true, days: { mon: { start: '9:00', end: '17:00' } } } }, 'Use HH:MM'],
      [{ officeHours: { enabled: true, days: { tue: { start: '09:00', end: '24:30' } } } }, null],
      [{ officeHours: { enabled: true, days: { wed: { start: '17:00', end: '09:00' } } } }, 'End time must be after start time'],
      [{ officeHours: { enabled: true, days: { thu: { start: '10:00', end: '10:00' } } } }, 'End time must be after start time'],
      [{ officeHours: { enabled: true, days: { funday: null } } }, null],
      [{ officeHours: { days: {} } }, null],
      [{ timezone: 'Mars/Olympus_Mons' }, 'Unknown timezone'],
      [{ timezone: `Europe/${'x'.repeat(60)}` }, null],
      [{ awayMessage: 'x'.repeat(1001) }, null],
      [{ expectedReplyTime: 'week' }, null],
      [{ enabled: 'yes' }, null],
      [{ branding: { position: 'center' } }, null],
      [{ greeting: 'x'.repeat(501) }, null],
    ];
    for (const [body, message] of cases) {
      const res = await UPDATE().request(`${BASE}/widget_seed`, send('PATCH', body));
      expect(res.status).toBe(400);
      if (message) expect(JSON.stringify(await res.json())).toContain(message);
    }
  });

  it('PATCH sets office hours, timezone, a trimmed away message and the reply time', async () => {
    const officeHours = {
      enabled: true,
      days: { mon: { start: '09:00', end: '17:30' }, sat: { start: '10:00', end: '24:00' }, sun: null },
    };
    const res = await UPDATE().request(
      `${BASE}/widget_seed`,
      send('PATCH', { officeHours, timezone: 'Europe/Amsterdam', awayMessage: '  Back at nine  ', expectedReplyTime: 'few_hours' }),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      id: 'dwgt_seed',
      widgetName: 'Support',
      greeting: 'Hello',
      officeHours,
      timezone: 'Europe/Amsterdam',
      awayMessage: 'Back at nine',
      expectedReplyTime: 'few_hours',
      createdAt: at(1).toISOString(),
    });
    expect(data.updatedAt).not.toBe(at(1).toISOString());
    // Neither the name nor enabled changed: the registry stays as it was.
    expect(await registryOf('widget_seed')).toMatchObject({ widgetName: 'Support', isActive: true, updatedAt: at(1) });
  });

  it('PATCH clears with null, and an away message of only spaces clears it too', async () => {
    const res = await UPDATE().request(
      `${BASE}/widget_seed`,
      send('PATCH', { greeting: null, officeHours: null, timezone: null, expectedReplyTime: null, awayMessage: '   ' }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      greeting: null,
      officeHours: null,
      timezone: null,
      expectedReplyTime: null,
      awayMessage: null,
      branding: { primaryColor: '#123456', position: 'right' },
    });
  });

  it('PATCH renames and disables the widget in the registry too', async () => {
    const res = await UPDATE().request(
      `${BASE}/widget_seed`,
      send('PATCH', { widgetName: 'Help desk', enabled: false, allowedDomains: [], branding: { position: 'left' } }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({
      widgetName: 'Help desk',
      enabled: false,
      allowedDomains: [],
      branding: { position: 'left' },
    });
    expect(await registryOf('widget_seed')).toMatchObject({ widgetName: 'Help desk', isActive: false });
  });

  it('PATCH with an empty name renames the widget but not the registry entry', async () => {
    const res = await UPDATE().request(`${BASE}/widget_seed`, send('PATCH', { widgetName: '' }));
    expect(res.status).toBe(200);
    expect((await rowOf('widget_seed'))?.widgetName).toBe('');
    expect(await registryOf('widget_seed')).toMatchObject({ widgetName: 'Help desk', isActive: false });
  });

  it('PATCH with only enabled re-activates the registry entry, keeping its name', async () => {
    const res = await UPDATE().request(`${BASE}/widget_seed`, send('PATCH', { enabled: true }));
    expect(res.status).toBe(200);
    expect(await registryOf('widget_seed')).toMatchObject({ widgetName: 'Help desk', isActive: true });
  });

  it('PATCH with an empty body only touches updatedAt', async () => {
    const before = await rowOf('widget_seed');
    const res = await UPDATE().request(`${BASE}/widget_seed`, send('PATCH', {}));
    expect(res.status).toBe(200);
    const after = await rowOf('widget_seed');
    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
  });

  it('identity verification needs settings:manage and an existing widget', async () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect((await UPDATE().request(`${BASE}/widget_seed/identity`, send(method))).status).toBe(403);
      expect((await app('settings:manage').request(`${BASE}/widget_missing/identity`, send(method))).status).toBe(404);
    }
  });

  it('identity verification is off until a secret is set up, and cannot be required before', async () => {
    const res = await app('settings:manage').request(`${BASE}/widget_seed/identity`);
    expect(await res.json()).toEqual({ data: { secret: null, required: false } });
    const require = await UPDATE().request(`${BASE}/widget_seed`, send('PATCH', { identityRequired: true }));
    expect(require.status).toBe(400);
    expect((await rowOf('widget_seed'))?.identityRequired).toBe(false);
  });

  it('sets up a secret that no settings response shows, then requires it', async () => {
    const created = await app('settings:manage').request(`${BASE}/widget_seed/identity`, send('POST'));
    expect(created.status).toBe(200);
    const { data } = (await created.json()) as { data: { secret: string; required: boolean } };
    expect(data.secret).toMatch(/^[\w-]{43}$/);
    expect(data.required).toBe(false);
    expect((await rowOf('widget_seed'))?.identitySecret).toBe(data.secret);

    const read = await app('settings:manage').request(`${BASE}/widget_seed/identity`);
    expect(await read.json()).toEqual({ data: { secret: data.secret, required: false } });

    const patched = await UPDATE().request(`${BASE}/widget_seed`, send('PATCH', { identityRequired: true }));
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { data: Record<string, unknown> };
    expect(patchedBody.data.identityRequired).toBe(true);
    for (const res of [patchedBody, await (await READ().request(`${BASE}/widget_seed`)).json()]) {
      expect(JSON.stringify(res)).not.toContain(data.secret);
    }
    const listed = await (await READ().request(BASE)).json();
    expect(JSON.stringify(listed)).not.toContain(data.secret);
  });

  it('rotating replaces the secret; removing turns verification off', async () => {
    const before = (await rowOf('widget_seed'))?.identitySecret;
    await app('settings:manage').request(`${BASE}/widget_seed/identity`, send('POST'));
    expect((await rowOf('widget_seed'))?.identitySecret).not.toBe(before);

    const removed = await app('settings:manage').request(`${BASE}/widget_seed/identity`, send('DELETE'));
    expect(await removed.json()).toEqual({ data: { secret: null, required: false } });
    expect(await rowOf('widget_seed')).toMatchObject({ identitySecret: null, identityRequired: false });
  });

  it('DELETE needs settings:manage and an existing widget', async () => {
    expect((await UPDATE().request(`${BASE}/widget_seed`, send('DELETE'))).status).toBe(403);
    expect((await app('settings:delete').request(`${BASE}/widget_seed`, send('DELETE'))).status).toBe(403);
    const res = await app('settings:manage').request(`${BASE}/widget_missing`, send('DELETE'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Widget with ID 'widget_missing' not found" } });
  });

  it('DELETE removes the widget and its registry entry', async () => {
    const res = await app('settings:manage').request(`${BASE}/widget_seed`, send('DELETE'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'dwgt_seed', widgetId: 'widget_seed' } });
    expect(await rowOf('widget_seed')).toBeUndefined();
    expect(await registryOf('widget_seed')).toBeUndefined();
    expect((await READ().request(`${BASE}/widget_seed`)).status).toBe(404);
  });
});
