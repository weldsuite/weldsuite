/**
 * Tests for /api/panel/group-types and /api/panel/groups, on a real tenant
 * schema (pglite) with a fake Basin and a fake PanelProject object.
 *
 * What must not regress:
 *   1. A project collects at most five group types: a sixth row, or a type the
 *      object has no slot for, is a 409 `GROUP_TYPE_LIMIT` that writes nothing.
 *   2. Group types are per project: another project's rows never show, and the
 *      list merges the rows with the types the object collects without one.
 *   3. Group-type changes go on the entity bus with id, project, type and
 *      names only; group profiles (visitor data, EVT-005) never do.
 *   4. Every statement sent to Basin carries the workspace and project of the
 *      request and the `$group_<type>` filter; the profile comes from the
 *      project's object.
 *   5. The WeldCRM company is matched in the tenant DB, never a deleted one,
 *      and only for callers who can read companies.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import type { PanelGroupDto, PanelGroupProfileDto, PanelGroupTypeDto } from '@weldsuite/app-api-client/schemas/weldpanel-groups';
import { BASIN_ENV, FakeBasin, PROJECT, RUNS, WORKSPACE, entityQueue, eventRow, memoryKv, minted } from '../test-support/fakes';
import { FakeGroupState, group } from '../test-support/groups-fakes';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.master as never };
});

import groupsRoutes from './groups';
import groupTypesRoutes from './group-types';
import { defaultGroupTypeNames, domainOf } from '../services/groups';

const { companies, panelGroupTypes, panelProjects } = schema;

const TYPES = '/api/panel/group-types';
const GROUPS = '/api/panel/groups';

const REPORTS_ALL = ['panel_reports:read', 'panel_reports:create', 'panel_reports:update', 'panel_reports:delete'];
const PEOPLE_READ = ['panel_people:read'];
const CRM = ['companies:read', 'companies:scope:all'];

let db: Database;
let master: AnyMasterDatabase;
let events: EntityEventMessage[] = [];
const basin = new FakeBasin();
const object = new FakeGroupState();

function context(grants: string[]) {
  return { permissions: permissions(...grants), tenantDb: db, userId: 'user_alice', orgId: 'org_alpha', workspaceId: WORKSPACE, clerkOrgId: 'org_alpha' };
}

function env(overrides: Record<string, unknown>) {
  return {
    WORKSPACE_CACHE: memoryKv(),
    ENTITY_EVENTS: entityQueue(events),
    PANEL_PROJECT: object.namespace(),
    ...BASIN_ENV,
    ...overrides,
  } as never;
}

function typesApp(grants: string[] = REPORTS_ALL, overrides: Record<string, unknown> = {}) {
  return createTestApp(TYPES, groupTypesRoutes, { context: context(grants), env: env(overrides), moduleApiErrors: true });
}

function groupsApp(grants: string[] = PEOPLE_READ, overrides: Record<string, unknown> = {}) {
  return createTestApp(GROUPS, groupsRoutes, { context: context(grants), env: env(overrides), moduleApiErrors: true });
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

let rowSeq = 0;
async function insertType(projectId: string, groupType: string, extra: Partial<typeof panelGroupTypes.$inferInsert> = {}) {
  rowSeq += 1;
  const [row] = await db
    .insert(panelGroupTypes)
    .values({
      id: `pngt_${groupType}_${rowSeq}`,
      projectId,
      groupType,
      ...defaultGroupTypeNames(groupType),
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, rowSeq)),
      ...extra,
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  state.master = master;
}, 120_000);

beforeEach(async () => {
  for (const table of [panelGroupTypes, companies, panelProjects]) await db.delete(table);
  await db.insert(panelProjects).values([
    { id: PROJECT, name: 'Shop', token: 'wpk_a', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' },
    { id: 'pnp_b', name: 'Docs', token: 'wpk_b', settings: DEFAULT_PANEL_SETTINGS, createdByUserId: 'user_alice' },
  ]);
  events = [];
  basin.reset();
  basin.install();
  object.reset();
});

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// Group types
// ---------------------------------------------------------------------------

describe('GET /api/panel/group-types', () => {
  it('needs panel_reports:read and a project of this workspace', async () => {
    expect((await typesApp([]).request(`${TYPES}?projectId=${PROJECT}`)).status).toBe(403);
    expect((await typesApp().request(`${TYPES}?projectId=pnp_zzz`)).status).toBe(404);
    expect((await typesApp().request(TYPES)).status).toBe(400);
  });

  it('merges the rows with the types the object collects, and never shows another project’s', async () => {
    await insertType(PROJECT, 'company', { nameSingular: 'Customer', namePlural: 'Customers', crmMatchProperty: 'domain' });
    await insertType(PROJECT, 'workspace');
    await insertType('pnp_b', 'invisible');
    object.types = ['company', 'team_account'];

    const res = await typesApp(['panel_reports:read']).request(`${TYPES}?projectId=${PROJECT}`);
    expect(res.status).toBe(200);
    const types = await data<PanelGroupTypeDto[]>(res);
    expect(types.map((t) => [t.groupType, t.configured, t.collecting])).toEqual([
      ['company', true, true],
      ['workspace', true, false],
      ['team_account', false, true],
    ]);
    expect(types[0]).toMatchObject({ nameSingular: 'Customer', namePlural: 'Customers', crmMatchProperty: 'domain', projectId: PROJECT });
    expect(types[2]).toEqual({
      id: null,
      projectId: PROJECT,
      groupType: 'team_account',
      nameSingular: 'Team account',
      namePlural: 'Team accounts',
      crmMatchProperty: null,
      configured: false,
      collecting: true,
      createdAt: null,
      updatedAt: null,
    });
    // Once per backend in conformance mode (a read runs on both).
    expect(object.objects).toEqual(Array.from({ length: RUNS }, () => PROJECT));
  });

  it('still lists the rows without the object binding, none collecting', async () => {
    await insertType(PROJECT, 'company');
    const res = await typesApp(REPORTS_ALL, { PANEL_PROJECT: undefined }).request(`${TYPES}?projectId=${PROJECT}`);
    expect(res.status).toBe(200);
    expect((await data<PanelGroupTypeDto[]>(res)).map((t) => [t.groupType, t.collecting])).toEqual([['company', false]]);
  });
});

describe('POST /api/panel/group-types', () => {
  const body = { projectId: PROJECT, groupType: 'company', nameSingular: 'Company', namePlural: 'Companies', crmMatchProperty: 'domain' };

  it('needs panel_reports:create', async () => {
    expect((await typesApp(['panel_reports:read']).request(TYPES, json('POST', body))).status).toBe(403);
    expect(object.ensureCalls).toEqual([]);
  });

  it('takes a slot, writes the row and publishes created with the names only', async () => {
    const res = await typesApp().request(TYPES, json('POST', body));
    expect(res.status).toBe(201);
    const created = await data<PanelGroupTypeDto>(res);
    expect(created).toMatchObject({ projectId: PROJECT, groupType: 'company', crmMatchProperty: 'domain', configured: true, collecting: true });
    expect(created.id).toMatch(/^pngt_/);
    expect(object.ensureCalls).toEqual([['company']]);
    expect(object.types).toEqual(['company']);

    const [row] = await db.select().from(panelGroupTypes).where(eq(panelGroupTypes.id, created.id ?? ''));
    expect(row?.projectId).toBe(PROJECT);
    expect(events.map((e) => e.eventType)).toEqual(['panel_group_type:created']);
    expect(events[0]!.entityId).toEqual(minted(created.id ?? ''));
    expect(events[0]!.data).toEqual({ id: minted(created.id ?? ''), projectId: PROJECT, groupType: 'company', nameSingular: 'Company', namePlural: 'Companies' });
  });

  it('refuses a duplicate, a bad type or property, and a project of another workspace', async () => {
    await insertType(PROJECT, 'company');
    const dup = await typesApp().request(TYPES, json('POST', body));
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe('CONFLICT');
    // The same type in another project is fine.
    expect((await typesApp().request(TYPES, json('POST', { ...body, projectId: 'pnp_b' }))).status).toBe(201);

    expect((await typesApp().request(TYPES, json('POST', { ...body, groupType: 'Company' }))).status).toBe(400);
    expect((await typesApp().request(TYPES, json('POST', { ...body, groupType: '1st' }))).status).toBe(400);
    expect((await typesApp().request(TYPES, json('POST', { ...body, groupType: 'team', crmMatchProperty: 'do-main' }))).status).toBe(400);
    expect((await typesApp().request(TYPES, json('POST', { ...body, projectId: 'pnp_zzz' }))).status).toBe(404);
  });

  it('refuses a sixth configured type with GROUP_TYPE_LIMIT', async () => {
    for (const type of ['a1', 'a2', 'a3', 'a4', 'a5']) await insertType(PROJECT, type);
    const res = await typesApp().request(TYPES, json('POST', body));
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('GROUP_TYPE_LIMIT');
    expect(object.ensureCalls).toEqual([]);
    expect(events).toEqual([]);
  });

  it('refuses a type the object has no slot for (data took five), and writes nothing', async () => {
    object.types = ['t1', 't2', 't3', 't4', 't5'];
    const res = await typesApp().request(TYPES, json('POST', body));
    expect(res.status).toBe(409);
    const payload = (await res.json()) as { error: { code: string; details: { types: string[] } } };
    expect(payload.error.code).toBe('GROUP_TYPE_LIMIT');
    expect(payload.error.details.types).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(await db.select().from(panelGroupTypes)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('configures a type the object already collects', async () => {
    object.types = ['company'];
    expect((await typesApp().request(TYPES, json('POST', body))).status).toBe(201);
    expect(object.types).toEqual(['company']);
  });

  it('answers 503 without the object binding and writes nothing', async () => {
    const res = await typesApp(REPORTS_ALL, { PANEL_PROJECT: undefined }).request(TYPES, json('POST', body));
    expect(res.status).toBe(503);
    expect(await db.select().from(panelGroupTypes)).toEqual([]);
  });
});

describe('PATCH /api/panel/group-types/:id', () => {
  it('changes the names and the CRM property, never the type, and publishes updated', async () => {
    const row = await insertType(PROJECT, 'company');
    object.types = ['company'];
    expect((await typesApp(['panel_reports:read']).request(`${TYPES}/${row.id}`, json('PATCH', { nameSingular: 'Account' }))).status).toBe(403);

    const res = await typesApp().request(
      `${TYPES}/${row.id}`,
      json('PATCH', { nameSingular: 'Account', namePlural: 'Accounts', crmMatchProperty: 'name', groupType: 'other' }),
    );
    expect(res.status).toBe(200);
    expect(await data<PanelGroupTypeDto>(res)).toMatchObject({
      id: row.id,
      groupType: 'company',
      nameSingular: 'Account',
      namePlural: 'Accounts',
      crmMatchProperty: 'name',
      collecting: true,
    });
    expect(events.map((e) => e.eventType)).toEqual(['panel_group_type:updated']);
    expect(events[0]!.data).toEqual({ id: row.id, projectId: PROJECT, groupType: 'company', nameSingular: 'Account', namePlural: 'Accounts' });

    const cleared = await data<PanelGroupTypeDto>(await typesApp().request(`${TYPES}/${row.id}`, json('PATCH', { crmMatchProperty: null })));
    expect(cleared.crmMatchProperty).toBeNull();
  });

  it('is a 400 with nothing to change and a 404 for an unknown id', async () => {
    const row = await insertType(PROJECT, 'company');
    expect((await typesApp().request(`${TYPES}/${row.id}`, json('PATCH', {}))).status).toBe(400);
    expect((await typesApp().request(`${TYPES}/pngt_missing`, json('PATCH', { nameSingular: 'X' }))).status).toBe(404);
    expect(events).toEqual([]);
  });
});

describe('DELETE /api/panel/group-types/:id', () => {
  it('needs panel_reports:delete', async () => {
    const row = await insertType(PROJECT, 'company');
    expect((await typesApp(['panel_reports:read']).request(`${TYPES}/${row.id}`, { method: 'DELETE' })).status).toBe(403);
    expect(object.released).toEqual([]);
  });

  it('deletes the row, frees the slot and publishes deleted', async () => {
    const row = await insertType(PROJECT, 'company');
    object.types = ['company', 'workspace'];
    const res = await typesApp().request(`${TYPES}/${row.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await db.select().from(panelGroupTypes)).toEqual([]);
    expect(object.released).toEqual(['company']);
    expect(object.types).toEqual(['workspace']);
    expect(events.map((e) => e.eventType)).toEqual(['panel_group_type:deleted']);
    expect(events[0]!.data).toEqual({ id: row.id, projectId: PROJECT, groupType: 'company', nameSingular: 'Company', namePlural: 'Companies' });
    expect((await typesApp().request(`${TYPES}/${row.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('still deletes the row without the object binding', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = await insertType(PROJECT, 'company');
    const res = await typesApp(REPORTS_ALL, { PANEL_PROJECT: undefined }).request(`${TYPES}/${row.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await db.select().from(panelGroupTypes)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

describe('GET /api/panel/groups', () => {
  beforeEach(() => {
    object.groups = [
      group('company', 'acme', { properties: { $name: 'Acme Inc.' }, lastSeen: '2026-11-14T10:00:00.000Z' }),
      group('company', 'globex', { properties: { name: 'Globex' }, lastSeen: '2026-11-13T10:00:00.000Z' }),
      group('company', 'initech', { lastSeen: '2026-11-12T10:00:00.000Z' }),
      group('workspace', 'ws_1'),
    ];
  });

  it('needs panel_people:read, a type and a project of this workspace', async () => {
    expect((await groupsApp([]).request(`${GROUPS}?projectId=${PROJECT}&type=company`)).status).toBe(403);
    expect((await groupsApp(REPORTS_ALL).request(`${GROUPS}?projectId=${PROJECT}&type=company`)).status).toBe(403);
    expect((await groupsApp().request(`${GROUPS}?projectId=pnp_zzz&type=company`)).status).toBe(404);
    expect((await groupsApp().request(`${GROUPS}?projectId=${PROJECT}`)).status).toBe(400);
    expect((await groupsApp().request(`${GROUPS}?projectId=${PROJECT}&type=Bad-Type`)).status).toBe(400);
  });

  it('lists one type’s groups from the object, with a cursor, a search and the display name', async () => {
    const first = await groupsApp().request(`${GROUPS}?projectId=${PROJECT}&type=company&limit=2`);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { data: PanelGroupDto[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    expect(body.data.map((g) => [g.groupKey, g.name])).toEqual([
      ['acme', 'Acme Inc.'],
      ['globex', 'Globex'],
    ]);
    expect(body.pagination).toEqual({ totalCount: 3, hasMore: true, cursor: '2' });

    const next = (await (await groupsApp().request(`${GROUPS}?projectId=${PROJECT}&type=company&limit=2&cursor=2`)).json()) as typeof body;
    expect(next.data.map((g) => [g.groupKey, g.name])).toEqual([['initech', null]]);
    expect(next.pagination.hasMore).toBe(false);

    const found = (await (await groupsApp().request(`${GROUPS}?projectId=${PROJECT}&type=company&search=glob`)).json()) as typeof body;
    expect(found.data.map((g) => g.groupKey)).toEqual(['globex']);
    expect(basin.sent).toHaveLength(0);
    expect(new Set(object.objects)).toEqual(new Set([PROJECT]));
  });

  it('answers 503 without the project object', async () => {
    expect((await groupsApp(PEOPLE_READ, { PANEL_PROJECT: undefined }).request(`${GROUPS}?projectId=${PROJECT}&type=company`)).status).toBe(503);
  });
});

describe('GET /api/panel/groups/:type/:key', () => {
  const url = (key = 'acme', query = '') => `${GROUPS}/company/${encodeURIComponent(key)}?projectId=${PROJECT}${query}`;

  beforeEach(() => {
    object.groups = [group('company', 'acme', { properties: { $name: 'Acme Inc.', domain: 'acme.com', plan: 'pro' } })];
    basin.on(/SELECT e\.event_id AS event_id/, [
      eventRow('Signed up', '2026-11-14 09:00:00'),
      eventRow('$pageview', '2026-11-14 08:59:00', { path: '/signup' }),
    ]);
    basin.on(/COUNT\(DISTINCT/, [{ n: 42, members: 3, first_seen: '2026-10-01 08:00:00', last_seen: '2026-11-14 09:00:00' }]);
    basin.on(/AS person, MAX\(e\.ts\) AS last_seen/, [
      { person: 'user_1', last_seen: '2026-11-14 09:00:00', n: 30 },
      { person: 'anon_2', last_seen: '2026-11-13 09:00:00', n: 12 },
    ]);
  });

  it('answers the profile, recent events, counts and members, scoped to the workspace, project and group', async () => {
    const res = await groupsApp().request(url());
    expect(res.status).toBe(200);
    const profile = await data<PanelGroupProfileDto>(res);
    expect(profile).toMatchObject({ projectId: PROJECT, hasProfile: true, days: 90, eventCount: 42, memberCount: 3, crmCompany: null });
    expect(profile.group).toMatchObject({ groupType: 'company', groupKey: 'acme', name: 'Acme Inc.', properties: { plan: 'pro' } });
    expect(profile.recentEvents.map((e) => e.name)).toEqual(['Signed up', '$pageview']);
    expect(profile.members).toEqual([
      { distinctId: 'user_1', lastSeen: '2026-11-14T09:00:00.000Z', eventCount: 30 },
      { distinctId: 'anon_2', lastSeen: '2026-11-13T09:00:00.000Z', eventCount: 12 },
    ]);

    expect(basin.sent).toHaveLength(3 * RUNS);
    for (const sql of basin.sent) {
      expect(sql).toContain(`workspace_id = '${WORKSPACE}'`);
      expect(sql).toContain(`project_id = '${PROJECT}'`);
      expect(sql).toContain("json_get_str(e.properties, '$group_company') = 'acme'");
    }
    const feed = basin.sent.find((sql) => sql.includes('SELECT e.event_id')) ?? '';
    expect(feed).toContain("e.name NOT IN ('$pageleave', '$identify')");
    expect(feed).toContain('LIMIT 25');
    expect(basin.sent.find((sql) => sql.includes('AS person')) ?? '').toContain('LIMIT 50');
  });

  it('escapes the key and takes the window from days', async () => {
    const res = await groupsApp().request(url("o'brien/1", '&days=7'));
    expect(res.status).toBe(200);
    expect((await data<PanelGroupProfileDto>(res)).days).toBe(7);
    expect(basin.sent[0]).toContain("json_get_str(e.properties, '$group_company') = 'o''brien/1'");
    expect((await groupsApp().request(url('acme', '&days=5'))).status).toBe(400);
    expect((await groupsApp().request(url('acme', '&days=400'))).status).toBe(400);
  });

  it('builds the group from its events when the object has no profile, and is a 404 when neither knows it', async () => {
    const res = await groupsApp().request(url('ghost'));
    expect(res.status).toBe(200);
    const profile = await data<PanelGroupProfileDto>(res);
    expect(profile.hasProfile).toBe(false);
    expect(profile.group).toEqual({
      groupType: 'company',
      groupKey: 'ghost',
      name: null,
      properties: {},
      firstSeen: '2026-10-01T08:00:00.000Z',
      lastSeen: '2026-11-14T09:00:00.000Z',
    });

    basin.reset();
    basin.install();
    expect((await groupsApp().request(url('ghost'))).status).toBe(404);
  });

  it('is a 403 without panel_people:read, a 404 for another workspace’s project, a 400 for a bad type', async () => {
    expect((await groupsApp([]).request(url())).status).toBe(403);
    expect((await groupsApp().request(`${GROUPS}/company/acme?projectId=pnp_zzz`)).status).toBe(404);
    expect((await groupsApp().request(`${GROUPS}/Bad-Type/acme?projectId=${PROJECT}`)).status).toBe(400);
    expect((await groupsApp().request(`${GROUPS}/company/acme`)).status).toBe(400);
    expect(basin.sent).toHaveLength(0);
  });

  it('answers 502 when Basin fails and 503 without the object', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    basin.status = 500;
    expect((await groupsApp().request(url())).status).toBe(502);
    error.mockRestore();
    expect((await groupsApp(PEOPLE_READ, { PANEL_PROJECT: undefined }).request(url())).status).toBe(503);
  });

  describe('the WeldCRM company', () => {
    beforeEach(async () => {
      await db.insert(companies).values([
        { id: 'company_deleted', name: 'Acme (old)', displayName: 'Acme (old)', website: 'acme.com', deletedAt: new Date('2026-01-01') },
        { id: 'company_acme', name: 'Acme Incorporated', displayName: 'Acme Inc.', website: 'https://www.acme.com/about', ownerId: 'user_bob' },
        { id: 'company_other', name: 'Acme Copy', displayName: 'Acme Copy', website: 'https://notacme.com' },
      ]);
    });

    it('matches the domain property on the website host, never a deleted company', async () => {
      await insertType(PROJECT, 'company', { crmMatchProperty: 'domain' });
      const profile = await data<PanelGroupProfileDto>(await groupsApp([...PEOPLE_READ, ...CRM]).request(url()));
      expect(profile.crmCompany).toEqual({ id: 'company_acme', name: 'Acme Inc.', domain: 'acme.com' });
    });

    it('matches the name property on the company name', async () => {
      await insertType(PROJECT, 'company', { crmMatchProperty: '$name' });
      const profile = await data<PanelGroupProfileDto>(await groupsApp([...PEOPLE_READ, ...CRM]).request(url()));
      expect(profile.crmCompany?.id).toBe('company_acme');
    });

    it('is null without companies:read, for someone else’s company without scope:all, or without a match property', async () => {
      await insertType(PROJECT, 'company', { crmMatchProperty: 'domain' });
      expect((await data<PanelGroupProfileDto>(await groupsApp().request(url()))).crmCompany).toBeNull();
      expect((await data<PanelGroupProfileDto>(await groupsApp([...PEOPLE_READ, 'companies:read']).request(url()))).crmCompany).toBeNull();
      await db.update(companies).set({ ownerId: 'user_alice' }).where(eq(companies.id, 'company_acme'));
      expect((await data<PanelGroupProfileDto>(await groupsApp([...PEOPLE_READ, 'companies:read']).request(url()))).crmCompany?.id).toBe(
        'company_acme',
      );

      await db.update(panelGroupTypes).set({ crmMatchProperty: null });
      expect((await data<PanelGroupProfileDto>(await groupsApp([...PEOPLE_READ, ...CRM]).request(url()))).crmCompany).toBeNull();
    });

    it('ignores another project’s configuration of the same type', async () => {
      await insertType('pnp_b', 'company', { crmMatchProperty: 'domain' });
      expect((await data<PanelGroupProfileDto>(await groupsApp([...PEOPLE_READ, ...CRM]).request(url()))).crmCompany).toBeNull();
    });
  });
});

describe('DELETE /api/panel/groups/:type/:key', () => {
  const url = `${GROUPS}/company/acme?projectId=${PROJECT}`;

  beforeEach(() => {
    object.groups = [group('company', 'acme'), group('company', 'globex')];
  });

  it('needs panel_people:delete', async () => {
    expect((await groupsApp(PEOPLE_READ).request(url, { method: 'DELETE' })).status).toBe(403);
    expect(object.deleteCalls).toEqual([]);
  });

  it('deletes the profile in the project’s object and puts nothing on the entity bus', async () => {
    const res = await groupsApp([...PEOPLE_READ, 'panel_people:delete']).request(url, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(object.deleteCalls).toEqual([{ workspaceId: WORKSPACE, projectId: PROJECT, groupType: 'company', groupKey: 'acme' }]);
    expect(object.groups.map((g) => g.groupKey)).toEqual(['globex']);
    expect(events).toEqual([]);

    expect((await groupsApp(['panel_people:delete']).request(url, { method: 'DELETE' })).status).toBe(404);
  });

  it('is a 404 for another workspace’s project and touches nothing', async () => {
    const res = await groupsApp(['panel_people:delete']).request(`${GROUPS}/company/acme?projectId=pnp_zzz`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(object.deleteCalls).toEqual([]);
  });
});

describe('domainOf', () => {
  it('reads a domain from a host, a URL or an email address, and nothing else', () => {
    expect(domainOf('acme.com')).toBe('acme.com');
    expect(domainOf('https://www.Acme.com/about')).toBe('acme.com');
    expect(domainOf('ceo@acme.co.uk')).toBe('acme.co.uk');
    expect(domainOf('Acme Inc.')).toBeNull();
    expect(domainOf('acme')).toBeNull();
    expect(domainOf('')).toBeNull();
    expect(domainOf(null)).toBeNull();
  });
});
