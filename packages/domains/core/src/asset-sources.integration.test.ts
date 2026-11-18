/**
 * A full Intune import against a real tenant schema (pglite) and a stubbed
 * Microsoft: create, update, unchanged skip, adopt by serial number, the owner
 * link, fields people own, fields added once, resuming in bounded steps,
 * throttling and a failed sign-in. The stub answers by URL and method, and
 * pages are distinct `@odata.nextLink` URLs. Ids and times are deterministic.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { encryptField } from '@weldsuite/db/lib/crypto';
import { getValuesForEntity, setValues } from '@weldsuite/db/lib/custom-field-values';
import {
  ASSET_IMPORT_FIELDS,
  ASSET_IMPORT_STEP_LEASE_MS,
  INTUNE_DEVICES_URL,
  INTUNE_DEVICE_ENTITY_TYPE,
  deviceChecksum,
  deviceChecksumWithCheckIn,
  mapIntuneDevice,
  runAssetImportStep,
  startAssetImport,
  ensureAssetImportFields,
  type AssetImportContext,
  type FetchLike,
} from './asset-sources';

const KEY = 'ab'.repeat(32);
const KEYRING = { v1: KEY };
const TENANT = '11111111-2222-3333-4444-555555555555';
const NOW = new Date('2026-11-10T08:00:00.000Z');
const ENTITY = 'co_asset';
const PAGE_2 = `${INTUNE_DEVICES_URL}?$skiptoken=page2`;
const PAGE_3 = `${INTUNE_DEVICES_URL}?$skiptoken=page3`;

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
  close = handle.close;
}, 120_000);

afterAll(async () => {
  await close?.();
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

interface Graph {
  /** Page by URL: the devices and the next link. */
  pages: Record<string, { value: unknown[]; next?: string }>;
  secret: string;
  throttle: boolean;
  calls: string[];
}

function graph(pages: Graph['pages']): Graph {
  return { pages, secret: 's3cret', throttle: false, calls: [] };
}

function fetcherFor(g: Graph): FetchLike {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    g.calls.push(`${method} ${url}`);
    if (method === 'POST' && url === `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('client_secret') !== g.secret) return json({ error: 'invalid_client', error_codes: [7000215] }, 401);
      return json({ token_type: 'Bearer', expires_in: 3599, access_token: 'tok' });
    }
    if (method === 'GET' && g.pages[url]) {
      if (g.throttle) return json({ error: { code: 'TooManyRequests' } }, 429, { 'Retry-After': '120' });
      const page = g.pages[url]!;
      return json({ value: page.value, ...(page.next ? { '@odata.nextLink': page.next } : {}) });
    }
    return json({ error: 'not stubbed' }, 404);
  }) as FetchLike;
}

let counter = 0;
const generateId = (prefix = '') => `${prefix}_t${String(++counter).padStart(6, '0')}`;

type Source = typeof schema.assetSources.$inferSelect;

const events: { action: string; id: string; data: Record<string, unknown> }[] = [];
const fieldEvents: string[] = [];

function context(g: Graph, overrides: Partial<AssetImportContext> = {}): AssetImportContext {
  return {
    db,
    keyring: KEYRING,
    fetch: fetcherFor(g),
    now: NOW,
    generateId,
    events: {
      record: ({ action, recordId, data }) => void events.push({ action, id: recordId, data }),
      field: (definition) => void fieldEvents.push(definition.slug),
    },
    ...overrides,
  };
}

async function installAssetObject(options: { enableEvents?: boolean } = {}) {
  const at = new Date('2026-06-01T09:00:00Z');
  const field = (id: string, slug: string, name: string, fieldType: string, sortOrder: number, extra: Record<string, unknown> = {}) => ({
    id,
    entityType: ENTITY,
    name,
    slug,
    fieldType,
    sortOrder,
    createdAt: at,
    updatedAt: at,
    ...extra,
  });
  await db.insert(schema.customObjects).values({
    id: 'cobj_asset',
    slug: 'asset',
    entityKey: ENTITY,
    labelSingular: 'Asset',
    labelPlural: 'Assets',
    titleFieldId: 'cfld_name',
    status: 'active',
    enableEvents: options.enableEvents ?? true,
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(schema.customFieldDefinitions).values([
    field('cfld_name', 'name', 'Name', 'text', 0, { required: true }),
    field('cfld_type', 'asset_type', 'Asset type', 'single_select', 1, {
      options: ['laptop', 'desktop', 'phone', 'tablet', 'server', 'other'].map((v) => ({ value: v, label: v })),
    }),
    field('cfld_serial', 'serial_number', 'Serial number', 'text', 2),
    field('cfld_status', 'status', 'Status', 'single_select', 3, {
      options: ['in_use', 'in_stock', 'retired'].map((v) => ({ value: v, label: v })),
    }),
  ]);
  await db.insert(schema.customObjectLinks).values({
    id: 'colk_owner',
    slug: 'owner',
    sourceEntityKey: ENTITY,
    targetEntityKey: 'person',
    cardinality: 'many_to_one',
    sourceLabel: 'Assets',
    targetLabel: 'Owner',
    onDelete: 'set_null',
    createdAt: at,
    updatedAt: at,
  });
}

async function addPerson(id: string, email: string) {
  await db.insert(schema.people).values({ id, displayName: id, email });
}

async function addSource(overrides: Partial<typeof schema.assetSources.$inferInsert> = {}): Promise<Source> {
  const [row] = await db
    .insert(schema.assetSources)
    .values({
      id: 'asrc_1',
      type: 'intune',
      name: 'Contoso Intune',
      objectSlug: 'asset',
      config: { tenantId: TENANT, clientId: 'cccccccc-2222-3333-4444-555555555555' },
      secretEncrypted: await encryptField('s3cret', KEYRING),
      enabled: true,
      intervalHours: 24,
      nextSyncAt: NOW,
      createdById: 'user_admin',
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    })
    .returning();
  return row!;
}

const reload = async (id = 'asrc_1') => (await db.select().from(schema.assetSources).where(eq(schema.assetSources.id, id)))[0]!;

/** Start a run and step it until it ends; returns the number of steps. */
async function runToEnd(g: Graph, source: Source, overrides: Partial<AssetImportContext> = {}) {
  const started = await startAssetImport(db, source, { now: NOW, startedById: 'user_admin' });
  expect(started).not.toBeNull();
  let current = started!;
  for (let steps = 1; steps < 50; steps++) {
    const result = await runAssetImportStep(context(g, overrides), current);
    current = result.source;
    if (result.done) return { steps, source: await reload(source.id), retryAfterSeconds: result.retryAfterSeconds };
    if (result.retryAfterSeconds) return { steps, source: await reload(source.id), retryAfterSeconds: result.retryAfterSeconds };
  }
  throw new Error('the run did not end');
}

const device = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `dev-${n}`,
  deviceName: `DEVICE-${n}`,
  serialNumber: `SN-${n}`,
  manufacturer: 'Dell',
  model: 'Latitude 7440',
  operatingSystem: 'Windows',
  osVersion: '10.0.22631',
  complianceState: 'compliant',
  lastSyncDateTime: '2026-11-09T10:00:00Z',
  userPrincipalName: `user${n}@example.com`,
  ...extra,
});

async function records() {
  return db.select().from(schema.customObjectRecords).where(and(eq(schema.customObjectRecords.entityKey, ENTITY), isNull(schema.customObjectRecords.deletedAt)));
}

async function fieldsOfDevice(externalId: string) {
  const [mapping] = await db.select().from(schema.integrationEntityMappings).where(eq(schema.integrationEntityMappings.externalEntityId, externalId));
  if (!mapping) return null;
  return { mapping, fields: await getValuesForEntity(db, ENTITY, mapping.internalEntityId) };
}

beforeEach(async () => {
  counter = 0;
  events.length = 0;
  fieldEvents.length = 0;
  for (const table of [
    schema.customObjectRelations,
    schema.customFieldValues,
    schema.customObjectRecords,
    schema.integrationEntityMappings,
    schema.assetSources,
    schema.customObjectLinks,
    schema.customFieldDefinitions,
    schema.customObjects,
    schema.people,
  ]) {
    await db.delete(table);
  }
  await installAssetObject();
});

describe('a full import', () => {
  it('creates a record per device across pages, with the created-only fields, an owner and a mapping', async () => {
    await addPerson('per_user1', 'USER1@example.com');
    const g = graph({
      [INTUNE_DEVICES_URL]: { value: [device(1), device(2, { operatingSystem: 'iOS/iPadOS', model: 'iPad Air', serialNumber: 'SN-2' })], next: PAGE_2 },
      [PAGE_2]: { value: [], next: PAGE_3 },
      [PAGE_3]: { value: [device(3, { operatingSystem: 'macOS', model: 'iMac21,1' })] },
    });
    const source = await addSource();

    const { steps, source: after } = await runToEnd(g, source);

    expect(steps).toBe(3);
    expect(after.syncState).toBeNull();
    expect(after.lastStatus).toBe('ok');
    expect(after.lastError).toBeNull();
    expect(after.lastStats).toEqual({ total: 3, created: 3, updated: 0, unchanged: 0, failed: 0 });
    expect(after.lastSyncAt?.toISOString()).toBe(NOW.toISOString());
    expect(after.nextSyncAt?.toISOString()).toBe('2026-11-11T08:00:00.000Z');

    expect(await records()).toHaveLength(3);
    const first = await fieldsOfDevice('dev-1');
    expect(first!.fields).toMatchObject({
      name: 'DEVICE-1',
      serial_number: 'SN-1',
      manufacturer: 'Dell',
      model: 'Latitude 7440',
      operating_system: 'Windows',
      os_version: '10.0.22631',
      compliance: 'compliant',
      last_check_in: '2026-11-09T10:00:00.000Z',
      primary_user: 'user1@example.com',
      intune_device_id: 'dev-1',
      asset_type: 'laptop',
      status: 'in_use',
    });
    expect((await fieldsOfDevice('dev-2'))!.fields.asset_type).toBe('tablet');
    expect((await fieldsOfDevice('dev-3'))!.fields.asset_type).toBe('desktop');

    expect(first!.mapping).toMatchObject({
      connectionId: 'asrc_1',
      externalEntityType: INTUNE_DEVICE_ENTITY_TYPE,
      internalEntityType: ENTITY,
    });
    expect(first!.mapping.syncChecksum).toMatch(/^[0-9a-f]{64}$/);

    // Titled by the name field; owner linked only where one person has the email (case-insensitive).
    const [record] = await db.select().from(schema.customObjectRecords).where(eq(schema.customObjectRecords.id, first!.mapping.internalEntityId));
    expect(record!.title).toBe('DEVICE-1');
    const relations = await db.select().from(schema.customObjectRelations);
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({ linkId: 'colk_owner', sourceId: record!.id, targetId: 'per_user1', targetEntityKey: 'person' });

    expect(events.filter((e) => e.action === 'created')).toHaveLength(3);
    expect(g.calls.filter((c) => c.startsWith('POST'))).toHaveLength(3);
  });

  it('adds the import fields once, with their events, and leaves existing fields alone', async () => {
    await db.insert(schema.customFieldDefinitions).values({
      id: 'cfld_mfr',
      entityType: ENTITY,
      name: 'Maker',
      slug: 'manufacturer',
      fieldType: 'text',
      sortOrder: 9,
    });
    const g = graph({ [INTUNE_DEVICES_URL]: { value: [device(1)] } });
    await runToEnd(g, await addSource());

    const defs = await db.select().from(schema.customFieldDefinitions).where(eq(schema.customFieldDefinitions.entityType, ENTITY));
    const wanted = ASSET_IMPORT_FIELDS.map((f) => f.slug);
    for (const slug of wanted) expect(defs.filter((d) => d.slug === slug), slug).toHaveLength(1);
    expect(defs.find((d) => d.slug === 'manufacturer')!.name).toBe('Maker');
    expect(defs.find((d) => d.slug === 'compliance')).toMatchObject({ fieldType: 'single_select' });
    expect(defs.find((d) => d.slug === 'last_check_in')).toMatchObject({ fieldType: 'date' });
    expect(fieldEvents.sort()).toEqual(wanted.filter((slug) => slug !== 'manufacturer').sort());

    // A second ensure creates nothing.
    expect(await ensureAssetImportFields(db, ENTITY, { generateId, now: NOW })).toEqual([]);
  });

  it('does not emit record events when the object has them off', async () => {
    await db.delete(schema.customObjects);
    await db.delete(schema.customFieldDefinitions);
    await db.delete(schema.customObjectLinks);
    await installAssetObject({ enableEvents: false });
    await runToEnd(graph({ [INTUNE_DEVICES_URL]: { value: [device(1)] } }), await addSource());
    expect(events).toEqual([]);
  });
});

describe('a later import', () => {
  it('skips unchanged devices, updates changed ones and never overwrites asset type, status or owner', async () => {
    await addPerson('per_user1', 'user1@example.com');
    await addPerson('per_other', 'other@example.com');
    const pages = { [INTUNE_DEVICES_URL]: { value: [device(1), device(2)] } };
    const source = await addSource();
    await runToEnd(graph(pages), source);

    // People correct the record: another type and status, another owner.
    const first = await fieldsOfDevice('dev-1');
    await setValues(db, ENTITY, first!.mapping.internalEntityId, { asset_type: 'server', status: 'retired' }, { generateId });
    await db.update(schema.customObjectRelations).set({ targetId: 'per_other' });
    const untouched = await fieldsOfDevice('dev-2');
    const [before] = await db.select().from(schema.customObjectRecords).where(eq(schema.customObjectRecords.id, untouched!.mapping.internalEntityId));
    events.length = 0;

    const changed = graph({ [INTUNE_DEVICES_URL]: { value: [device(1, { osVersion: '10.0.26100', complianceState: 'noncompliant', operatingSystem: 'iOS', model: 'iPad' }), device(2)] } });
    const { source: after } = await runToEnd(changed, await reload());

    expect(after.lastStats).toEqual({ total: 2, created: 0, updated: 1, unchanged: 1, failed: 0 });
    const updated = await fieldsOfDevice('dev-1');
    expect(updated!.fields).toMatchObject({ os_version: '10.0.26100', compliance: 'noncompliant', asset_type: 'server', status: 'retired' });
    const [relation] = await db.select().from(schema.customObjectRelations);
    expect(relation!.targetId).toBe('per_other');
    expect(await records()).toHaveLength(2);

    const [again] = await db.select().from(schema.customObjectRecords).where(eq(schema.customObjectRecords.id, untouched!.mapping.internalEntityId));
    expect(again!.updatedAt.toISOString()).toBe(before!.updatedAt.toISOString());
    expect(events.map((e) => e.action)).toEqual(['updated']);
  });

  it('does not write a fact the device stopped reporting', async () => {
    const source = await addSource();
    await runToEnd(graph({ [INTUNE_DEVICES_URL]: { value: [device(1)] } }), source);
    await runToEnd(graph({ [INTUNE_DEVICES_URL]: { value: [device(1, { manufacturer: null, osVersion: '11' })] } }), await reload());
    expect((await fieldsOfDevice('dev-1'))!.fields).toMatchObject({ manufacturer: 'Dell', os_version: '11' });
  });

  it('leaves a record people deleted deleted, and a device gone from Intune alone', async () => {
    const source = await addSource();
    await runToEnd(graph({ [INTUNE_DEVICES_URL]: { value: [device(1), device(2)] } }), source);
    const first = await fieldsOfDevice('dev-1');
    await db.update(schema.customObjectRecords).set({ deletedAt: NOW }).where(eq(schema.customObjectRecords.id, first!.mapping.internalEntityId));

    const { source: after } = await runToEnd(graph({ [INTUNE_DEVICES_URL]: { value: [device(1, { osVersion: '12' })] } }), await reload());
    expect(after.lastStats).toEqual({ total: 1, created: 0, updated: 0, unchanged: 1, failed: 0 });
    expect(await records()).toHaveLength(1);
    expect(await db.select().from(schema.integrationEntityMappings)).toHaveLength(2);
  });
});

describe('the last check-in', () => {
  const LATER = new Date('2026-11-10T20:00:00.000Z');
  const recordOf = async (externalId: string) => {
    const found = await fieldsOfDevice(externalId);
    const [record] = await db.select().from(schema.customObjectRecords).where(eq(schema.customObjectRecords.id, found!.mapping.internalEntityId));
    return { ...found!, record: record! };
  };

  it('leaves a device that only checked in again unwritten, and still keeps its check-in current', async () => {
    await runToEnd(graph({ [INTUNE_DEVICES_URL]: { value: [device(1), device(2), device(3)] } }), await addSource());
    const before = await recordOf('dev-1');
    expect(before.fields.last_check_in).toBe('2026-11-09T10:00:00.000Z');
    events.length = 0;

    // Two devices checked in again; nothing else about them changed. One write per step would be the cap.
    const checkedIn = graph({
      [INTUNE_DEVICES_URL]: {
        value: [device(1, { lastSyncDateTime: '2026-11-10T07:45:00Z' }), device(2, { lastSyncDateTime: '2026-11-10T19:59:59.5Z' }), device(3)],
      },
    });
    const { steps, source: after } = await runToEnd(checkedIn, await reload(), { now: LATER, maxWrites: 1 });

    // Unchanged, in one step: the refresh is not a write against the cap.
    expect(steps).toBe(1);
    expect(after.lastStats).toEqual({ total: 3, created: 0, updated: 0, unchanged: 3, failed: 0 });
    // No record write: no event, the record and its mapping as they were.
    expect(events).toEqual([]);
    const again = await recordOf('dev-1');
    expect(again.record.updatedAt.toISOString()).toBe(before.record.updatedAt.toISOString());
    expect(again.record.updatedBy).toBe(before.record.updatedBy);
    expect(again.mapping.syncChecksum).toBe(before.mapping.syncChecksum);
    expect(again.mapping.lastSyncedAt?.toISOString()).toBe(before.mapping.lastSyncedAt?.toISOString());
    // The check-in itself is current.
    expect(again.fields.last_check_in).toBe('2026-11-10T07:45:00.000Z');
    expect((await recordOf('dev-2')).fields.last_check_in).toBe('2026-11-10T19:59:59.500Z');
    expect((await recordOf('dev-3')).fields.last_check_in).toBe('2026-11-09T10:00:00.000Z');
    expect(again.fields).toMatchObject({ name: 'DEVICE-1', os_version: '10.0.22631', asset_type: 'laptop' });

    // Only the value that differs is touched: the row of the device that did not check in keeps its time.
    const values = await db.select().from(schema.customFieldValues);
    const checkIns = values.filter((value) => value.valueDate !== null);
    expect(checkIns).toHaveLength(3);
    expect(checkIns.filter((value) => value.updatedAt.toISOString() === LATER.toISOString())).toHaveLength(2);
  });

  it('writes a device that really changed, with its newer check-in', async () => {
    await runToEnd(graph({ [INTUNE_DEVICES_URL]: { value: [device(1), device(2)] } }), await addSource());
    const before = await recordOf('dev-1');
    events.length = 0;

    const changed = graph({
      [INTUNE_DEVICES_URL]: {
        value: [device(1, { osVersion: '10.0.26100', lastSyncDateTime: '2026-11-10T07:45:00Z' }), device(2, { lastSyncDateTime: '2026-11-10T07:50:00Z' })],
      },
    });
    const { source: after } = await runToEnd(changed, await reload(), { now: LATER });

    expect(after.lastStats).toEqual({ total: 2, created: 0, updated: 1, unchanged: 1, failed: 0 });
    const again = await recordOf('dev-1');
    expect(again.fields).toMatchObject({ os_version: '10.0.26100', last_check_in: '2026-11-10T07:45:00.000Z' });
    expect(again.mapping.syncChecksum).not.toBe(before.mapping.syncChecksum);
    expect(again.mapping.lastSyncedAt?.toISOString()).toBe(LATER.toISOString());
    expect(events.map((e) => [e.action, e.id])).toEqual([['updated', again.record.id]]);
    expect((events[0]!.data.fields as Record<string, unknown>).last_check_in).toBe('2026-11-10T07:45:00.000Z');
    expect((await recordOf('dev-2')).fields.last_check_in).toBe('2026-11-10T07:50:00.000Z');
  });

  it('leaves a record without a check-in value, or one a person deleted, alone', async () => {
    await runToEnd(graph({ [INTUNE_DEVICES_URL]: { value: [device(1, { lastSyncDateTime: null }), device(2)] } }), await addSource());
    const gone = await recordOf('dev-2');
    await db.update(schema.customObjectRecords).set({ deletedAt: NOW }).where(eq(schema.customObjectRecords.id, gone.record.id));
    events.length = 0;

    const checkedIn = graph({
      [INTUNE_DEVICES_URL]: { value: [device(1, { lastSyncDateTime: '2026-11-10T07:45:00Z' }), device(2, { lastSyncDateTime: '2026-11-10T07:50:00Z' })] },
    });
    const { source: after } = await runToEnd(checkedIn, await reload(), { now: LATER });

    expect(after.lastStats).toEqual({ total: 2, created: 0, updated: 0, unchanged: 2, failed: 0 });
    expect(events).toEqual([]);
    // No value row to refresh: the next real write brings the check-in.
    expect((await recordOf('dev-1')).fields.last_check_in).toBeUndefined();
    expect((await recordOf('dev-2')).fields.last_check_in).toBe('2026-11-09T10:00:00.000Z');
  });

  it('refreshes a check-in field a person made as text, in its own value column', async () => {
    await db.insert(schema.customFieldDefinitions).values({
      id: 'cfld_seen',
      entityType: ENTITY,
      name: 'Last seen',
      slug: 'last_check_in',
      fieldType: 'text',
      sortOrder: 9,
    });
    await runToEnd(graph({ [INTUNE_DEVICES_URL]: { value: [device(1)] } }), await addSource());
    events.length = 0;

    const checkedIn = graph({ [INTUNE_DEVICES_URL]: { value: [device(1, { lastSyncDateTime: '2026-11-10T07:45:00Z' })] } });
    const { source: after } = await runToEnd(checkedIn, await reload(), { now: LATER });

    expect(after.lastStats).toMatchObject({ updated: 0, unchanged: 1 });
    expect(events).toEqual([]);
    const [value] = await db.select().from(schema.customFieldValues).where(eq(schema.customFieldValues.fieldId, 'cfld_seen'));
    expect(value).toMatchObject({ valueText: '2026-11-10T07:45:00.000Z', valueDate: null });
  });

  it('takes a checksum of the old kind, with the check-in in it, as unchanged and replaces it', async () => {
    await runToEnd(graph({ [INTUNE_DEVICES_URL]: { value: [device(1), device(2), device(3, { lastSyncDateTime: null })] } }), await addSource());
    // The mappings as an import wrote them while the check-in was part of the checksum.
    const oldKind = async (n: number, extra: Record<string, unknown> = {}) => {
      const values = mapIntuneDevice(device(n, extra)).values;
      const checksum = await deviceChecksumWithCheckIn(values, values.last_check_in ?? null);
      await db.update(schema.integrationEntityMappings).set({ syncChecksum: checksum }).where(eq(schema.integrationEntityMappings.externalEntityId, `dev-${n}`));
      return checksum;
    };
    const old1 = await oldKind(1);
    await oldKind(2);
    await oldKind(3, { lastSyncDateTime: null });
    const before = await recordOf('dev-1');
    expect(before.mapping.syncChecksum).toBe(old1);
    events.length = 0;

    // Device 1 only checked in again, device 2 also runs a newer system, device 3 reports its first check-in.
    const next = graph({
      [INTUNE_DEVICES_URL]: {
        value: [
          device(1, { lastSyncDateTime: '2026-11-10T07:45:00Z' }),
          device(2, { lastSyncDateTime: '2026-11-10T07:50:00Z', osVersion: '10.0.26100' }),
          device(3, { lastSyncDateTime: '2026-11-10T07:55:00Z' }),
        ],
      },
    });
    const { source: after } = await runToEnd(next, await reload(), { now: LATER });

    // Not every device rewritten once: only the one whose facts changed.
    expect(after.lastStats).toEqual({ total: 3, created: 0, updated: 1, unchanged: 2, failed: 0 });
    expect(events.map((e) => e.action)).toEqual(['updated']);
    const again = await recordOf('dev-1');
    expect(again.record.updatedAt.toISOString()).toBe(before.record.updatedAt.toISOString());
    expect(again.fields.last_check_in).toBe('2026-11-10T07:45:00.000Z');
    // The checksums are now the kind without the check-in, whichever way they got there.
    for (const [n, extra] of [[1, {}], [2, { osVersion: '10.0.26100' }], [3, {}]] as const) {
      const found = await recordOf(`dev-${n}`);
      expect(found.mapping.syncChecksum, `dev-${n}`).toBe(await deviceChecksum(mapIntuneDevice(device(n, extra)).values));
    }
    // A replaced checksum is not a sync of the record.
    expect(again.mapping.lastSyncedAt?.toISOString()).toBe(before.mapping.lastSyncedAt?.toISOString());

    // The run after that finds nothing of the old kind left.
    events.length = 0;
    const { source: third } = await runToEnd(next, await reload(), { now: LATER });
    expect(third.lastStats).toEqual({ total: 3, created: 0, updated: 0, unchanged: 3, failed: 0 });
    expect(events).toEqual([]);
  });
});

describe('one step at a time', () => {
  const mappingCount = async () => (await db.select().from(schema.integrationEntityMappings)).length;

  it('lets one of two overlapping steps work; the other does nothing', async () => {
    const g = graph({ [INTUNE_DEVICES_URL]: { value: [1, 2, 3].map((n) => device(n)) } });
    const started = await startAssetImport(db, await addSource(), { now: NOW });

    // Microsoft's page is held back until both steps ask for it, or one of them
    // has ended: a slow step and the next tick's, at work at the same time.
    let asked = 0;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const held = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        asked += 1;
        if (asked === 2) open();
        await gate;
      }
      return fetcherFor(g)(input, init);
    }) as FetchLike;

    const steps = [1, 2].map(() => runAssetImportStep(context(g, { fetch: held }), started!).finally(open));
    const results = await Promise.all(steps);

    const busy = results.filter((result) => result.busy);
    const worked = results.filter((result) => !result.busy);
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({ done: false, busy: true });
    expect(worked).toHaveLength(1);
    expect(worked[0]!.done).toBe(true);
    // The step that was refused the run never called Microsoft.
    expect(g.calls.filter((call) => call.startsWith('GET'))).toHaveLength(1);

    // No duplicate record, no mapping that lost the unique index.
    expect(await records()).toHaveLength(3);
    expect(await mappingCount()).toBe(3);
    const after = await reload();
    expect(after.syncState).toBeNull();
    expect(after.lastStats).toEqual({ total: 3, created: 3, updated: 0, unchanged: 0, failed: 0 });
    expect(events.filter((e) => e.action === 'created')).toHaveLength(3);
  });

  it('gives the lease up with the state it saves, and takes it again for the next step', async () => {
    const g = graph({ [INTUNE_DEVICES_URL]: { value: [1, 2, 3].map((n) => device(n)) } });
    const started = await startAssetImport(db, await addSource(), { now: NOW });

    const first = await runAssetImportStep(context(g, { maxWrites: 2 }), started!);
    expect(first).toMatchObject({ done: false });
    expect(first.busy).toBeUndefined();
    expect((await reload()).syncState).toEqual({ ...started!.syncState, offset: 2, stats: { total: 2, created: 2, updated: 0, unchanged: 0, failed: 0 } });
    expect(first.source.syncState).not.toHaveProperty('leaseUntil');

    // The same instant, and even a caller that still holds the row from before the first step.
    const second = await runAssetImportStep(context(g, { maxWrites: 2 }), started!);
    expect(second.done).toBe(true);
    expect((await reload()).lastStats).toEqual({ total: 3, created: 3, updated: 0, unchanged: 0, failed: 0 });
    expect(await records()).toHaveLength(3);
  });

  it('waits for the lease of a step that died to run out, then carries on', async () => {
    const g = graph({ [INTUNE_DEVICES_URL]: { value: [device(1)] } });
    const started = await startAssetImport(db, await addSource(), { now: NOW });
    // A step took the run at NOW and never came back.
    const leaseUntil = new Date(NOW.getTime() + ASSET_IMPORT_STEP_LEASE_MS).toISOString();
    await db.update(schema.assetSources).set({ syncState: { ...started!.syncState!, leaseUntil } });

    const during = await runAssetImportStep(context(g, { now: new Date(NOW.getTime() + 60_000) }), await reload());
    expect(during).toMatchObject({ done: false, busy: true });
    expect(g.calls).toEqual([]);
    expect(await records()).toHaveLength(0);
    expect((await reload()).syncState).toMatchObject({ leaseUntil, stats: { total: 0 } });

    const afterwards = await runAssetImportStep(context(g, { now: new Date(NOW.getTime() + ASSET_IMPORT_STEP_LEASE_MS) }), await reload());
    expect(afterwards.done).toBe(true);
    expect(await records()).toHaveLength(1);
    expect((await reload()).lastStatus).toBe('ok');
  });

  it('gives the lease up when Microsoft throttles, and ends a run that is too old once it holds the lease', async () => {
    const g = graph({ [INTUNE_DEVICES_URL]: { value: [device(1)] } });
    g.throttle = true;
    const started = await startAssetImport(db, await addSource(), { now: NOW });
    const waiting = await runAssetImportStep(context(g), started!);
    expect(waiting).toMatchObject({ done: false, retryAfterSeconds: 120 });
    expect((await reload()).syncState).toEqual(started!.syncState);
    expect(waiting.source.syncState).toEqual(started!.syncState);

    // More than a day on: the next step takes the run and stops it.
    const stopped = await runAssetImportStep(context(g, { now: new Date(NOW.getTime() + 25 * 3600_000) }), await reload());
    expect(stopped.done).toBe(true);
    expect((await reload()).lastError).toMatch(/^throttled: The import did not finish within 24 hours/);
  });

  it('does nothing when the run it was handed is over', async () => {
    const g = graph({ [INTUNE_DEVICES_URL]: { value: [device(1)] } });
    const started = await startAssetImport(db, await addSource(), { now: NOW });
    expect((await runAssetImportStep(context(g), started!)).done).toBe(true);
    const calls = g.calls.length;

    // A caller that read the row before the run ended.
    expect(await runAssetImportStep(context(g), started!)).toMatchObject({ done: false, busy: true });
    expect(g.calls).toHaveLength(calls);
    expect((await reload()).lastStats).toEqual({ total: 1, created: 1, updated: 0, unchanged: 0, failed: 0 });
  });
});

describe('the schedule at the end of a run', () => {
  /** A fetch that changes the source row while the step is at Microsoft: after the step read it, before it ends. */
  const changingMeanwhile = (g: Graph, change: Partial<typeof schema.assetSources.$inferInsert>): FetchLike =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      await db.update(schema.assetSources).set(change).where(eq(schema.assetSources.id, 'asrc_1'));
      return fetcherFor(g)(input, init);
    }) as FetchLike;

  it('schedules the next import when the schedule was switched on while the last step ran', async () => {
    const g = graph({ [INTUNE_DEVICES_URL]: { value: [device(1)] } });
    const started = await startAssetImport(db, await addSource({ enabled: false, nextSyncAt: null }), { now: NOW, startedById: 'user_admin' });

    const fetch = changingMeanwhile(g, { enabled: true, intervalHours: 6, nextSyncAt: NOW });
    const result = await runAssetImportStep(context(g, { fetch }), started!);

    expect(result.done).toBe(true);
    const after = await reload();
    expect(after).toMatchObject({ enabled: true, intervalHours: 6, lastStatus: 'ok', syncState: null });
    expect(after.nextSyncAt?.toISOString()).toBe('2026-11-10T14:00:00.000Z');
    expect(result.source.nextSyncAt?.toISOString()).toBe('2026-11-10T14:00:00.000Z');
  });

  it('follows an interval that changed, and a schedule that was switched off, also for a run that fails', async () => {
    const g = graph({ [INTUNE_DEVICES_URL]: { value: [device(1)] } });
    const shorter = await startAssetImport(db, await addSource(), { now: NOW });
    await runAssetImportStep(context(g, { fetch: changingMeanwhile(g, { intervalHours: 1 }) }), shorter!);
    expect((await reload()).nextSyncAt?.toISOString()).toBe('2026-11-10T09:00:00.000Z');

    const off = await startAssetImport(db, await reload(), { now: NOW });
    await runAssetImportStep(context(g, { fetch: changingMeanwhile(g, { enabled: false, nextSyncAt: null }) }), off!);
    expect((await reload()).nextSyncAt).toBeNull();

    // Switched back on while Microsoft refuses the sign-in: the failed run still leaves a next import.
    g.secret = 'another';
    const failing = await startAssetImport(db, await reload(), { now: NOW });
    const failed = await runAssetImportStep(context(g, { fetch: changingMeanwhile(g, { enabled: true, intervalHours: 12 }) }), failing!);
    expect(failed.done).toBe(true);
    const after = await reload();
    expect(after.lastStatus).toBe('failed');
    expect(after.nextSyncAt?.toISOString()).toBe('2026-11-10T20:00:00.000Z');
  });
});

describe('matching', () => {
  it('adopts a record with the same serial number and keeps its type, status and other fields', async () => {
    const [mine] = await db
      .insert(schema.customObjectRecords)
      .values({ id: 'cor_hand', objectId: 'cobj_asset', entityKey: ENTITY, title: 'Sanne laptop', ownerId: 'user_admin', createdBy: 'user_admin', updatedBy: 'user_admin', createdAt: NOW, updatedAt: NOW })
      .returning();
    await setValues(db, ENTITY, mine!.id, { name: 'Sanne laptop', serial_number: 'SN-1', asset_type: 'server', status: 'in_stock' }, { generateId });

    const g = graph({ [INTUNE_DEVICES_URL]: { value: [device(1), device(2)] } });
    const { source: after } = await runToEnd(g, await addSource());

    expect(after.lastStats).toEqual({ total: 2, created: 1, updated: 1, unchanged: 0, failed: 0 });
    expect(await records()).toHaveLength(2);
    const adopted = await getValuesForEntity(db, ENTITY, 'cor_hand');
    expect(adopted).toMatchObject({ name: 'DEVICE-1', serial_number: 'SN-1', asset_type: 'server', status: 'in_stock', intune_device_id: 'dev-1', manufacturer: 'Dell' });
    const [mapping] = await db.select().from(schema.integrationEntityMappings).where(eq(schema.integrationEntityMappings.externalEntityId, 'dev-1'));
    expect(mapping!.internalEntityId).toBe('cor_hand');
    // No owner link for an adopted record.
    expect(await db.select().from(schema.customObjectRelations)).toHaveLength(0);
  });

  it('does not adopt a record another device of this source is mapped to: a duplicate serial creates a second record', async () => {
    const g = graph({ [INTUNE_DEVICES_URL]: { value: [device(1), device(2, { serialNumber: 'SN-1' })] } });
    const { source: after } = await runToEnd(g, await addSource());
    expect(after.lastStats).toMatchObject({ created: 2, updated: 0 });
    expect(await records()).toHaveLength(2);
  });

  it('sets an owner only when exactly one person has the email', async () => {
    await addPerson('per_a', 'twin@example.com');
    await addPerson('per_b', 'TWIN@example.com');
    await addPerson('per_c', 'solo@example.com');
    await db.insert(schema.people).values({ id: 'per_gone', displayName: 'gone', email: 'gone@example.com', deletedAt: NOW });
    const g = graph({
      [INTUNE_DEVICES_URL]: {
        value: [
          device(1, { userPrincipalName: 'twin@example.com' }),
          device(2, { userPrincipalName: 'solo@example.com' }),
          device(3, { userPrincipalName: 'nobody@example.com' }),
          device(4, { userPrincipalName: 'gone@example.com' }),
        ],
      },
    });
    await runToEnd(g, await addSource());
    const relations = await db.select().from(schema.customObjectRelations);
    expect(relations.map((r) => r.targetId)).toEqual(['per_c']);
  });
});

describe('bounded steps', () => {
  it('stops after the write cap, saves where it stopped and resumes inside the page', async () => {
    const devices = [1, 2, 3, 4, 5].map((n) => device(n));
    const g = graph({ [INTUNE_DEVICES_URL]: { value: devices } });
    const source = await addSource();
    const started = await startAssetImport(db, source, { now: NOW, startedById: 'user_admin' });

    const first = await runAssetImportStep(context(g, { maxWrites: 2 }), started!);
    expect(first.done).toBe(false);
    expect((await reload()).syncState).toMatchObject({ nextLink: null, offset: 2, stats: { total: 2, created: 2 } });
    expect((await reload()).lastStatus).toBe('running');
    expect(await records()).toHaveLength(2);

    const second = await runAssetImportStep(context(g, { maxWrites: 2 }), first.source);
    expect(second.done).toBe(false);
    expect((await reload()).syncState).toMatchObject({ offset: 4, stats: { total: 4, created: 4 } });

    const third = await runAssetImportStep(context(g, { maxWrites: 2 }), second.source);
    expect(third.done).toBe(true);
    const after = await reload();
    expect(after.syncState).toBeNull();
    expect(after.lastStats).toEqual({ total: 5, created: 5, updated: 0, unchanged: 0, failed: 0 });
    expect(await records()).toHaveLength(5);
    // Every step asked for a token and for the same page, by URL.
    expect(g.calls.filter((c) => c === `GET ${INTUNE_DEVICES_URL}`)).toHaveLength(3);
  });

  it('is safe to resume after a crash: a repeated device is unchanged, not created twice', async () => {
    const devices = [1, 2, 3].map((n) => device(n));
    const g = graph({ [INTUNE_DEVICES_URL]: { value: devices } });
    const source = await addSource();
    const started = await startAssetImport(db, source, { now: NOW });
    await runAssetImportStep(context(g, { maxWrites: 2 }), started!);
    // The step crashed before it saved: the stored state is the start again.
    await db.update(schema.assetSources).set({ syncState: started!.syncState });

    const result = await runAssetImportStep(context(g), await reload());
    expect(result.done).toBe(true);
    expect(await records()).toHaveLength(3);
    expect((await reload()).lastStats).toEqual({ total: 3, created: 1, updated: 0, unchanged: 2, failed: 0 });
  });

  it('counts a device that cannot be written as failed and goes on', async () => {
    const g = graph({ [INTUNE_DEVICES_URL]: { value: [device(1), { deviceName: 'no id' }, device(3)] } });
    const { source: after } = await runToEnd(g, await addSource());
    expect(after.lastStatus).toBe('ok');
    expect(after.lastStats).toEqual({ total: 3, created: 2, updated: 0, unchanged: 0, failed: 1 });
  });

  it('refuses to start a second run while one is under way', async () => {
    const source = await addSource();
    expect(await startAssetImport(db, source, { now: NOW })).not.toBeNull();
    expect(await startAssetImport(db, source, { now: NOW })).toBeNull();
  });
});

describe('Microsoft problems', () => {
  it('waits when throttled, keeping the progress and reporting Retry-After', async () => {
    const g = graph({ [INTUNE_DEVICES_URL]: { value: [device(1)] } });
    g.throttle = true;
    const { steps, source: after, retryAfterSeconds } = await runToEnd(g, await addSource());
    expect(steps).toBe(1);
    expect(retryAfterSeconds).toBe(120);
    expect(after.lastStatus).toBe('running');
    expect(after.syncState).not.toBeNull();
    expect(await records()).toHaveLength(0);

    g.throttle = false;
    const result = await runAssetImportStep(context(g), after);
    expect(result.done).toBe(true);
    expect((await reload()).lastStats).toMatchObject({ created: 1 });
  });

  it('ends the run as failed on a refused sign-in and keeps the schedule', async () => {
    const g = graph({ [INTUNE_DEVICES_URL]: { value: [device(1)] } });
    g.secret = 'another';
    const { source: after } = await runToEnd(g, await addSource());
    expect(after.syncState).toBeNull();
    expect(after.lastStatus).toBe('failed');
    expect(after.lastError).toMatch(/^invalid_secret: /);
    expect(after.lastError).not.toContain('s3cret');
    expect(after.nextSyncAt?.toISOString()).toBe('2026-11-11T08:00:00.000Z');
    expect(await records()).toHaveLength(0);
  });

  it('fails with permission_missing when Graph refuses the devices', async () => {
    const g = graph({});
    const { source: after } = await runToEnd(g, await addSource());
    // Not stubbed: Graph answers 404, which is "unreachable".
    expect(after.lastError).toMatch(/^unreachable: /);

    const refusing: AssetImportContext = { ...context(g), fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('graph.microsoft.com') ? json({}, 403) : fetcherFor(g)(input, init)) as FetchLike };
    const started = await startAssetImport(db, await reload(), { now: NOW });
    await runAssetImportStep(refusing, started!);
    expect((await reload()).lastError).toMatch(/^permission_missing: /);
  });

  it('fails when the asset register is gone and stops a run older than a day', async () => {
    const g = graph({ [INTUNE_DEVICES_URL]: { value: [device(1)] } });
    const source = await addSource({ enabled: false });
    const started = await startAssetImport(db, source, { now: new Date(NOW.getTime() - 25 * 3600_000) });
    const old = await runAssetImportStep(context(g), started!);
    expect(old.done).toBe(true);
    expect((await reload()).lastStatus).toBe('failed');
    // A schedule that is off stays off.
    expect((await reload()).nextSyncAt).toBeNull();

    await db.update(schema.customObjects).set({ deletedAt: NOW });
    await runToEnd(g, await reload());
    expect((await reload()).lastError).toMatch(/^asset_register_missing: /);
  });
});
