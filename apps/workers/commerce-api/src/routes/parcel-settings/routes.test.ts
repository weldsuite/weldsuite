/**
 * Every /api/parcel-settings route on pglite: the parcel settings singleton
 * (`workspace_settings.custom_settings.parcel`, the row keyed by the Clerk org
 * id), the carrier list with its credential status, and writing a carrier's
 * API credentials. Runs against Rust in conformance mode.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { publishEntityEvent } from '@weldsuite/entity-events';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { parcelSettingsRoutes } from './index';

vi.mock('@weldsuite/entity-events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/entity-events')>();
  return { ...actual, publishEntityEvent: vi.fn(actual.publishEntityEvent) };
});

const BASE = '/api/parcel-settings';
const ORG = 'org_test_default';
const { workspaceSettings, carriers } = schema;
const events = vi.mocked(publishEntityEvent);

let db: Database;

const app = (keys: string[], clerkOrgId = ORG) =>
  createTestApp(BASE, parcelSettingsRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, clerkOrgId },
  });
const put = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const published = () =>
  events.mock.calls.map(([p]) => ({ entityType: p.entityType, action: p.action, entityId: p.entityId, data: p.data }));
const settingsRow = async (id: string) =>
  (await db.select().from(workspaceSettings).where(eq(workspaceSettings.id, id)).limit(1))[0];

const DEFAULTS = {
  autoGenerateLabels: false,
  autoSendNotifications: true,
  labelFormat: 'pdf',
  labelSize: 'A6',
  defaultWeight: { value: 1, unit: 'kg' },
  defaultDimensions: { length: 20, width: 15, height: 10, unit: 'cm' },
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = new Date(Date.UTC(2026, 0, 1, 12));
  // A row under the workspace id: the routes read the Clerk org id's row only.
  await db.insert(workspaceSettings).values({
    id: 'ws_test_default',
    customSettings: { parcel: { labelSize: 'Letter' } },
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(carriers).values([
    { id: 'crr_a', name: 'DHL', code: 'DHL', apiCredentials: { carrier: 1, apiKey: 'key', useSandbox: true }, createdAt: at, updatedAt: at },
    { id: 'crr_b', name: 'PostNL', code: 'POSTNL', isActive: false, integrationType: 'sendcloud', createdAt: at, updatedAt: new Date(Date.UTC(2026, 0, 2)) },
    { id: 'crr_gone', name: 'Gone', code: 'GONE', deletedAt: at, createdAt: at, updatedAt: at },
  ]);
}, 60_000);

beforeEach(() => {
  events.mockClear();
});

describe('GET / and PUT /api/parcel-settings', () => {
  it('GET / answers the defaults before anything is saved', async () => {
    const res = await app(['carriers:read']).request(BASE);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    // Unset defaultCarrier / defaultServiceType are left out.
    expect(data).toEqual(DEFAULTS);
    // The keys, not their order: the Rust backend writes them sorted.
    expect(Object.keys(data).sort()).toEqual(
      ['autoGenerateLabels', 'autoSendNotifications', 'labelFormat', 'labelSize', 'defaultWeight', 'defaultDimensions'].sort(),
    );
  });

  it('PUT / creates the org row, keeps only known keys and publishes updated', async () => {
    const res = await app(['carriers:update']).request(
      BASE,
      put({ defaultCarrier: 'crr_a', labelFormat: 'zpl', defaultWeight: { value: 2.5, unit: 'kg' }, unknownKey: true }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { message: 'Settings updated successfully' } });
    const stored = { defaultCarrier: 'crr_a', labelFormat: 'zpl', defaultWeight: { value: 2.5, unit: 'kg' } };
    expect((await settingsRow(ORG))?.customSettings).toEqual({ parcel: stored });
    expect(published()).toEqual([{ entityType: 'parcel_settings', action: 'updated', entityId: ORG, data: stored }]);
  });

  it('GET / answers what was saved over the defaults', async () => {
    const res = await app(['carriers:read']).request(BASE);
    expect(((await res.json()) as { data: unknown }).data).toEqual({
      ...DEFAULTS,
      defaultCarrier: 'crr_a',
      labelFormat: 'zpl',
      defaultWeight: { value: 2.5, unit: 'kg' },
    });
  });

  it('PUT / merges into the parcel settings and keeps the other custom settings', async () => {
    await db
      .update(workspaceSettings)
      .set({ customSettings: { parcel: { defaultCarrier: 'crr_a', labelFormat: 'zpl' }, printnode: { apiKey: 'pn' } } })
      .where(eq(workspaceSettings.id, ORG));
    const body = {
      defaultServiceType: 'express',
      autoGenerateLabels: true,
      autoSendNotifications: false,
      labelSize: '4x6',
      defaultDimensions: { length: 30, width: 20, height: 10, unit: 'cm' },
    };
    const res = await app(['carriers:update']).request(BASE, put(body));
    expect(res.status).toBe(200);
    expect((await settingsRow(ORG))?.customSettings).toEqual({
      parcel: { defaultCarrier: 'crr_a', labelFormat: 'zpl', ...body },
      printnode: { apiKey: 'pn' },
    });
    expect(published()).toEqual([{ entityType: 'parcel_settings', action: 'updated', entityId: ORG, data: body }]);
    const read = (await (await app(['carriers:read']).request(BASE)).json()) as { data: unknown };
    expect(read.data).toEqual({ ...DEFAULTS, defaultCarrier: 'crr_a', labelFormat: 'zpl', ...body });
  });

  it("reads and writes the row of the caller's Clerk org", async () => {
    const other = await app(['carriers:read'], 'org_other').request(BASE);
    expect(((await other.json()) as { data: unknown }).data).toEqual(DEFAULTS);
    expect((await app(['carriers:update'], 'org_other').request(BASE, put({}))).status).toBe(200);
    expect((await settingsRow('org_other'))?.customSettings).toEqual({ parcel: {} });
    expect(published()).toEqual([{ entityType: 'parcel_settings', action: 'updated', entityId: 'org_other', data: {} }]);
  });

  it('refuses an invalid body (400) and callers without the permission (403)', async () => {
    const { request } = app(['carriers:update']);
    for (const body of [
      { labelFormat: 'gif' },
      { autoGenerateLabels: 'yes' },
      { defaultWeight: { value: '1', unit: 'kg' } },
      { defaultDimensions: { length: 1, width: 1, height: 1 } },
      { defaultCarrier: 7 },
    ]) {
      expect((await request(BASE, put(body))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await app(['carriers:read']).request(BASE, put({ labelSize: 'A4' }))).status).toBe(403);
    expect((await app(['carriers:update']).request(BASE)).status).toBe(403);
    expect(published()).toEqual([]);
  });
});

describe('/api/parcel-settings/carriers', () => {
  it('GET /carriers lists the live carriers with their credential status', async () => {
    const res = await app(['carriers:read']).request(`${BASE}/carriers`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string }> };
    expect([...data].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      {
        id: 'crr_a',
        name: 'DHL',
        code: 'DHL',
        isActive: true,
        integrationType: 'manual',
        hasApiCredentials: true,
        createdAt: '2026-01-01T12:00:00.000Z',
        updatedAt: '2026-01-01T12:00:00.000Z',
      },
      {
        id: 'crr_b',
        name: 'PostNL',
        code: 'POSTNL',
        isActive: false,
        integrationType: 'sendcloud',
        hasApiCredentials: false,
        createdAt: '2026-01-01T12:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    expect((await app([]).request(`${BASE}/carriers`)).status).toBe(403);
  });

  it('PUT /carriers/:id/credentials stores the body (extra keys too) and publishes updated', async () => {
    const body = { apiKey: 'pk_new', apiSecret: 'sk_new', accountNumber: '12345', customerCode: 'CC' };
    const res = await app(['carriers:update']).request(`${BASE}/carriers/crr_b/credentials`, put(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { message: 'Carrier credentials updated successfully' } });
    const [row] = await db.select().from(carriers).where(eq(carriers.id, 'crr_b'));
    expect(row?.apiCredentials).toEqual(body);
    expect(published()).toEqual([
      { entityType: 'parcel_settings', action: 'updated', entityId: 'crr_b', data: { carrierId: 'crr_b', credentialsUpdated: true } },
    ]);
  });

  it('an empty body stores {}, which still counts as credentials', async () => {
    const res = await app(['carriers:update']).request(`${BASE}/carriers/crr_a/credentials`, put({}));
    expect(res.status).toBe(200);
    const [row] = await db.select().from(carriers).where(eq(carriers.id, 'crr_a'));
    expect(row?.apiCredentials).toEqual({});
    const list = (await (await app(['carriers:read']).request(`${BASE}/carriers`)).json()) as {
      data: Array<{ id: string; hasApiCredentials: boolean }>;
    };
    expect(list.data.find((c) => c.id === 'crr_a')?.hasApiCredentials).toBe(true);
  });

  it('404 for a missing or deleted carrier; 400 for a bad body; 403 without carriers:update', async () => {
    const { request } = app(['carriers:update']);
    const missing = await request(`${BASE}/carriers/crr_missing/credentials`, put({ apiKey: 'k' }));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'NOT_FOUND', message: "Carrier with ID 'crr_missing' not found" } });
    expect((await request(`${BASE}/carriers/crr_gone/credentials`, put({ apiKey: 'k' }))).status).toBe(404);
    expect((await request(`${BASE}/carriers/crr_a/credentials`, put({ apiKey: 5 }))).status).toBe(400);
    expect((await request(`${BASE}/carriers/crr_a/credentials`, put(['k']))).status).toBe(400);
    expect((await app(['carriers:read']).request(`${BASE}/carriers/crr_a/credentials`, put({ apiKey: 'k' }))).status).toBe(403);
    expect(published()).toEqual([]);
  });
});
