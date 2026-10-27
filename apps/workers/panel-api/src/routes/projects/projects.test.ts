/**
 * DB-backed tests for /api/panel/projects (phase 1), on a real tenant schema
 * and a real master schema (pglite) with a fake KV namespace.
 *
 * What must not regress:
 *   1. Every change keeps the collector's copy in step: the master registry row
 *      (keyed by `workspaces.id`, never the Clerk org id) and the KV record the
 *      collector reads. A rotated token stops working at once; a deleted
 *      project's token does too.
 *   2. `panel_projects:manage` is what pauses a project, changes privacy
 *      settings and rotates the token; `:update` only renames and sets domains.
 *   3. An id from another workspace is a 404 that touches nothing of theirs.
 *   4. A project the collector could not be told about is not left behind.
 *   5. Events on the entity bus carry id, name, kind and status, never the
 *      token or the settings.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { EntityEventMessage } from '@weldsuite/entity-events/types';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { masterSchema, schema, type AnyMasterDatabase, type Database } from '@weldsuite/worker-kit/db';
import type { PanelProjectSettings } from '@weldsuite/db/schema';
import { parseProjectRecord, projectKvKey, seenKvKey } from '@weldsuite/panel-domain/registry';
import { DEFAULT_PANEL_SETTINGS } from '@weldsuite/panel-domain/settings';
import { installSnippet } from '@weldsuite/panel-sdk/install';
import type { PanelInstallInfo, PanelProjectDto } from '@weldsuite/app-api-client/schemas/weldpanel';

const state = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (orig) => {
  const actual = await orig<typeof import('@weldsuite/worker-kit/db')>();
  return { ...actual, getMasterDb: () => state.master };
});

import projectsRoutes from './index';

const { panelProjects } = schema;
const { panelProjectRegistry } = masterSchema;

const BASE = '/api/panel/projects';
const COLLECTOR = 'https://pnl-test.weldsuite.org';
const TOKEN_PATTERN = /^wpk_[0-9a-f]{32}$/;

const ALPHA = { clerkOrgId: 'org_alpha', workspaceId: 'ws_alpha' };
const BETA = { clerkOrgId: 'org_beta', workspaceId: 'ws_beta' };

const ADMIN = [
  'panel_projects:read',
  'panel_projects:create',
  'panel_projects:update',
  'panel_projects:delete',
  'panel_projects:manage',
];
/** Everything but `manage`: can create, rename and delete, cannot pause, change privacy settings or rotate. */
const MEMBER = ['panel_projects:read', 'panel_projects:create', 'panel_projects:update', 'panel_projects:delete'];
const READER = ['panel_projects:read'];

let db: Database;
let master: AnyMasterDatabase;
let events: EntityEventMessage[] = [];
const store = new Map<string, string>();

const kv = {
  get: async (key: string) => store.get(key) ?? null,
  put: async (key: string, value: string) => {
    store.set(key, value);
  },
  delete: async (key: string) => {
    store.delete(key);
  },
} as unknown as KVNamespace;

const queue = {
  send: async (message: EntityEventMessage) => {
    events.push(message);
  },
} as unknown as Queue<EntityEventMessage>;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  state.master = master;
}, 120_000);

beforeEach(async () => {
  await db.delete(panelProjects);
  await master.delete(panelProjectRegistry);
  store.clear();
  events = [];
});

interface AppOptions {
  workspace?: { clerkOrgId: string; workspaceId: string | undefined };
  kv?: KVNamespace;
  collectorUrl?: string;
}

function app(grants: string[] = ADMIN, options: AppOptions = {}) {
  const workspace = options.workspace ?? ALPHA;
  return createTestApp(BASE, projectsRoutes, {
    context: {
      permissions: permissions(...grants),
      tenantDb: db,
      userId: 'user_alice',
      orgId: workspace.clerkOrgId,
      workspaceId: workspace.clerkOrgId,
      clerkOrgId: workspace.clerkOrgId,
      internalWorkspaceId: workspace.workspaceId,
    },
    env: {
      WORKSPACE_CACHE: options.kv ?? kv,
      ENTITY_EVENTS: queue,
      PANEL_COLLECTOR_URL: options.collectorUrl ?? COLLECTOR,
    },
  });
}

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

async function newProject(body: Record<string, unknown> = { name: 'Marketing site' }) {
  const res = await app().request(BASE, json(body));
  expect(res.status).toBe(201);
  return data<PanelProjectDto>(res);
}

async function registryRow(projectId: string) {
  const [row] = await master.select().from(panelProjectRegistry).where(eq(panelProjectRegistry.projectId, projectId));
  return row;
}

function kvRecord(token: string) {
  return parseProjectRecord(store.get(projectKvKey(token)) ?? null);
}

function projectKeys() {
  return [...store.keys()].filter((key) => key.startsWith('panel:project:'));
}

describe('create and read', () => {
  it('creates a project with a token and defaults, and registers it with the collector', async () => {
    const res = await app().request(BASE, json({ name: ' Marketing site ', allowedDomains: ['Example.com'] }));
    expect(res.status).toBe(201);
    const project = await data<PanelProjectDto>(res);

    expect(project).toMatchObject({
      name: 'Marketing site',
      kind: 'website',
      status: 'active',
      allowedDomains: ['example.com'],
      settings: DEFAULT_PANEL_SETTINGS,
      createdByUserId: 'user_alice',
    });
    expect(project.id).toMatch(/^pnp_/);
    expect(project.token).toMatch(TOKEN_PATTERN);

    // The registry is keyed by workspaces.id, not the Clerk org id (ADR SEC-011).
    expect(await registryRow(project.id)).toMatchObject({
      projectId: project.id,
      token: project.token,
      workspaceId: 'ws_alpha',
      status: 'active',
      allowedDomains: ['example.com'],
      settings: DEFAULT_PANEL_SETTINGS,
      deletedAt: null,
    });
    expect(kvRecord(project.token)).toEqual({
      v: 1,
      projectId: project.id,
      workspaceId: 'ws_alpha',
      status: 'active',
      allowedDomains: ['example.com'],
      settings: DEFAULT_PANEL_SETTINGS,
    });
  });

  it('publishes panel_project:created with id, name, kind and status only', async () => {
    const project = await newProject({ name: 'Docs', kind: 'app' });
    expect(events.map((e) => e.eventType)).toEqual(['panel_project:created']);
    expect(events[0]!.entityId).toBe(project.id);
    expect(events[0]!.data).toEqual({ id: project.id, name: 'Docs', kind: 'app', status: 'active' });
    expect(JSON.stringify(events)).not.toContain(project.token);
  });

  it('lists and reads projects that are not deleted, oldest first', async () => {
    const first = await newProject({ name: 'First' });
    const second = await newProject({ name: 'Second' });
    const gone = await newProject({ name: 'Gone' });
    expect((await app().request(`${BASE}/${gone.id}`, { method: 'DELETE' })).status).toBe(204);

    const listed = await app().request(BASE);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { data: PanelProjectDto[]; pagination: unknown };
    expect(body.data.map((p) => p.id)).toEqual([first.id, second.id]);
    expect(body.pagination).toEqual({ totalCount: 2, hasMore: false, cursor: null });

    expect(await data<PanelProjectDto>(await app().request(`${BASE}/${first.id}`))).toMatchObject({ id: first.id, name: 'First' });
    for (const id of [gone.id, 'pnp_unknown']) {
      const res = await app().request(`${BASE}/${id}`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    }
  });

  it('fills in settings stored before a field existed', async () => {
    await db.insert(panelProjects).values({
      id: 'pnp_legacy',
      name: 'Legacy',
      token: 'wpk_' + 'a'.repeat(32),
      settings: { autocapture: false } as unknown as PanelProjectSettings,
      createdByUserId: 'user_alice',
    });
    const project = await data<PanelProjectDto>(await app().request(`${BASE}/pnp_legacy`));
    expect(project.settings).toEqual({ ...DEFAULT_PANEL_SETTINGS, autocapture: false });
  });
});

describe('validation', () => {
  it('refuses bad input and changes nothing', async () => {
    const project = await newProject({ name: 'Keep me', allowedDomains: ['keep.example.com'] });
    events = [];

    const bad: Array<[string, string, unknown, string]> = [
      ['POST', BASE, {}, 'a name is required'],
      ['POST', BASE, { name: '   ' }, 'a blank name'],
      ['POST', BASE, { name: 'Site', kind: 'mobile' }, 'an unknown kind'],
      ['POST', BASE, { name: 'Site', allowedDomains: ['https://example.com'] }, 'a domain with a scheme'],
      ['PATCH', `${BASE}/${project.id}`, {}, 'nothing to update'],
      ['PATCH', `${BASE}/${project.id}`, { allowedDomains: ['not a host'] }, 'a malformed domain'],
      ['PATCH', `${BASE}/${project.id}/settings`, {}, 'nothing to update (settings)'],
      ['PATCH', `${BASE}/${project.id}/settings`, { status: 'deleted' }, 'an unknown status'],
      ['PATCH', `${BASE}/${project.id}/settings`, { settings: { recordingSampleRate: 2 } }, 'a sample rate above 1'],
      ['PATCH', `${BASE}/${project.id}/settings`, { settings: { maskingLevel: 'none' } }, 'an unknown masking level'],
      ['PATCH', `${BASE}/${project.id}/settings`, { settings: { excludedUrls: ['admin'] } }, 'a URL pattern without a leading slash'],
    ];
    for (const [method, path, body, why] of bad) {
      const res = await app().request(path, json(body, method));
      expect(res.status, why).toBe(400);
    }

    expect(await data<PanelProjectDto>(await app().request(`${BASE}/${project.id}`))).toEqual(project);
    expect(((await (await app().request(BASE)).json()) as { data: unknown[] }).data).toHaveLength(1);
    expect(await registryRow(project.id)).toMatchObject({ allowedDomains: ['keep.example.com'], status: 'active' });
    expect(events).toEqual([]);
  });

  it('refuses to write without a workspace id, and writes nothing', async () => {
    const orgless = { clerkOrgId: 'org_alpha', workspaceId: undefined };
    const res = await app(ADMIN, { workspace: orgless }).request(BASE, json({ name: 'Site' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ORG_REQUIRED');
    expect(await db.select().from(panelProjects)).toEqual([]);
    expect(await master.select().from(panelProjectRegistry)).toEqual([]);
    expect(store.size).toBe(0);
  });
});

describe('update', () => {
  it('renames, changes the kind and replaces the allowed domains, and the collector sees it', async () => {
    const project = await newProject({ name: 'Old', allowedDomains: ['a.example.com'] });
    events = [];

    const res = await app().request(
      `${BASE}/${project.id}`,
      json({ name: 'New name', kind: 'app', allowedDomains: ['b.example.com', 'b.example.com', 'c.example.com'] }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    const updated = await data<PanelProjectDto>(res);
    expect(updated).toMatchObject({
      name: 'New name',
      kind: 'app',
      allowedDomains: ['b.example.com', 'c.example.com'],
      token: project.token,
      settings: project.settings,
    });

    expect(await registryRow(project.id)).toMatchObject({ allowedDomains: ['b.example.com', 'c.example.com'] });
    expect(kvRecord(project.token)?.allowedDomains).toEqual(['b.example.com', 'c.example.com']);
    expect(events.map((e) => e.eventType)).toEqual(['panel_project:updated']);
    expect(events[0]!.data).toEqual({ id: project.id, name: 'New name', kind: 'app', status: 'active' });
  });

  it('changes only what was sent', async () => {
    const project = await newProject({ name: 'Old', kind: 'app', allowedDomains: ['a.example.com'] });
    const updated = await data<PanelProjectDto>(
      await app().request(`${BASE}/${project.id}`, json({ name: 'Renamed' }, 'PATCH')),
    );
    expect(updated).toMatchObject({ name: 'Renamed', kind: 'app', allowedDomains: ['a.example.com'] });
  });

  it('answers 404 for an unknown project and publishes nothing', async () => {
    const res = await app().request(`${BASE}/pnp_unknown`, json({ name: 'x' }, 'PATCH'));
    expect(res.status).toBe(404);
    expect(events).toEqual([]);
  });
});

describe('settings and pausing', () => {
  it('merges partial settings, keeping the ones not sent', async () => {
    const project = await newProject();
    const path = `${BASE}/${project.id}/settings`;

    const first = await data<PanelProjectDto>(
      await app().request(
        path,
        json({ settings: { maskingLevel: 'strict', recordingSampleRate: 0.25, excludedUrls: ['/admin/*'] } }, 'PATCH'),
      ),
    );
    expect(first.settings).toEqual({
      ...DEFAULT_PANEL_SETTINGS,
      maskingLevel: 'strict',
      recordingSampleRate: 0.25,
      excludedUrls: ['/admin/*'],
    });
    expect(first.status).toBe('active');

    const second = await data<PanelProjectDto>(await app().request(path, json({ settings: { autocapture: false } }, 'PATCH')));
    expect(second.settings).toEqual({ ...first.settings, autocapture: false });

    expect(await registryRow(project.id)).toMatchObject({ settings: second.settings });
    expect(kvRecord(project.token)?.settings).toEqual(second.settings);
  });

  it('pauses and resumes: the collector is told both times', async () => {
    const project = await newProject();
    events = [];
    const path = `${BASE}/${project.id}/settings`;

    const paused = await data<PanelProjectDto>(await app().request(path, json({ status: 'paused' }, 'PATCH')));
    expect(paused).toMatchObject({ status: 'paused', settings: project.settings });
    expect(await registryRow(project.id)).toMatchObject({ status: 'paused' });
    expect(kvRecord(project.token)?.status).toBe('paused');

    const resumed = await data<PanelProjectDto>(await app().request(path, json({ status: 'active' }, 'PATCH')));
    expect(resumed.status).toBe('active');
    expect(kvRecord(project.token)?.status).toBe('active');

    expect(events.map((e) => e.eventType)).toEqual(['panel_project:updated', 'panel_project:updated']);
    expect(events.map((e) => (e.data as { status: string }).status)).toEqual(['paused', 'active']);
    expect(JSON.stringify(events)).not.toContain('maskingLevel');
  });

  it('answers 404 for an unknown project', async () => {
    const res = await app().request(`${BASE}/pnp_unknown/settings`, json({ status: 'paused' }, 'PATCH'));
    expect(res.status).toBe(404);
  });
});

describe('token rotation', () => {
  it('issues a new token and the old one stops working at once', async () => {
    const project = await newProject();
    const oldToken = project.token;
    expect(store.has(projectKvKey(oldToken))).toBe(true);
    events = [];

    const res = await app().request(`${BASE}/${project.id}/rotate-token`, json({}));
    expect(res.status).toBe(200);
    const rotated = await data<PanelProjectDto>(res);
    expect(rotated).toMatchObject({ id: project.id, name: project.name, settings: project.settings });
    expect(rotated.token).toMatch(TOKEN_PATTERN);
    expect(rotated.token).not.toBe(oldToken);

    // KV: the old key is gone, the new one routes to the same project.
    expect(store.has(projectKvKey(oldToken))).toBe(false);
    expect(kvRecord(rotated.token)).toMatchObject({ projectId: project.id, workspaceId: 'ws_alpha' });
    // Registry: one row, now under the new token.
    expect(await registryRow(project.id)).toMatchObject({ token: rotated.token });
    expect(await master.select().from(panelProjectRegistry).where(eq(panelProjectRegistry.token, oldToken))).toEqual([]);
    // Tenant row, and the install panel, agree.
    expect((await data<PanelProjectDto>(await app().request(`${BASE}/${project.id}`))).token).toBe(rotated.token);
    const install = await data<PanelInstallInfo>(await app().request(`${BASE}/${project.id}/install`));
    expect(install.token).toBe(rotated.token);
    expect(install.scriptSnippet).toContain(rotated.token);
    expect(install.scriptSnippet).not.toContain(oldToken);

    expect(events.map((e) => e.eventType)).toEqual(['panel_project:updated']);
    expect(JSON.stringify(events)).not.toContain(rotated.token);
    expect(JSON.stringify(events)).not.toContain(oldToken);
  });

  it('removes every earlier token, not just the last', async () => {
    const project = await newProject();
    const first = await data<PanelProjectDto>(await app().request(`${BASE}/${project.id}/rotate-token`, json({})));
    const second = await data<PanelProjectDto>(await app().request(`${BASE}/${project.id}/rotate-token`, json({})));
    expect(new Set([project.token, first.token, second.token]).size).toBe(3);
    expect(projectKeys()).toEqual([projectKvKey(second.token)]);
  });

  it('leaves exactly one live token when two rotations race', async () => {
    const project = await newProject();
    const results = await Promise.all([
      app().request(`${BASE}/${project.id}/rotate-token`, json({})),
      app().request(`${BASE}/${project.id}/rotate-token`, json({})),
    ]);
    for (const res of results) expect([200, 409]).toContain(res.status);
    expect(results.some((res) => res.status === 200)).toBe(true);

    const current = await data<PanelProjectDto>(await app().request(`${BASE}/${project.id}`));
    expect(projectKeys()).toEqual([projectKvKey(current.token)]);
    expect(await registryRow(project.id)).toMatchObject({ token: current.token });
  });

  it('answers 404 for an unknown project', async () => {
    const res = await app().request(`${BASE}/pnp_unknown/rotate-token`, json({}));
    expect(res.status).toBe(404);
    expect(events).toEqual([]);
  });
});

describe('delete', () => {
  it('soft-deletes the project and the collector refuses its token at once', async () => {
    const project = await newProject();
    events = [];

    const res = await app().request(`${BASE}/${project.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    const [row] = await db.select().from(panelProjects).where(eq(panelProjects.id, project.id));
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect((await registryRow(project.id))?.deletedAt).toBeInstanceOf(Date);
    expect(store.has(projectKvKey(project.token))).toBe(false);

    for (const [path, init] of [
      [`${BASE}/${project.id}`, undefined],
      [`${BASE}/${project.id}`, json({ name: 'x' }, 'PATCH')],
      [`${BASE}/${project.id}/settings`, json({ status: 'paused' }, 'PATCH')],
      [`${BASE}/${project.id}/rotate-token`, json({})],
      [`${BASE}/${project.id}/install`, undefined],
      [`${BASE}/${project.id}`, { method: 'DELETE' }],
    ] as const) {
      expect((await app().request(path, init)).status, `${init?.method ?? 'GET'} ${path}`).toBe(404);
    }
    expect(((await (await app().request(BASE)).json()) as { data: unknown[] }).data).toEqual([]);

    // Only the first delete published; the 404s did not.
    expect(events.map((e) => e.eventType)).toEqual(['panel_project:deleted']);
    expect(store.has(projectKvKey(project.token))).toBe(false);
  });
});

describe('install', () => {
  it('gives the snippets and waits until the collector has seen an event', async () => {
    const project = await newProject();
    const info = await data<PanelInstallInfo>(await app().request(`${BASE}/${project.id}/install`));

    expect(info).toMatchObject({
      projectId: project.id,
      token: project.token,
      collectorUrl: COLLECTOR,
      // The SDK's own snippet: the queueing stub, then the async loader.
      scriptSnippet: installSnippet(project.token, COLLECTOR),
      lastEventAt: null,
      status: 'waiting',
    });
    expect(info.scriptSnippet).toContain(`<script async src="${COLLECTOR}/s.js" data-project="${project.token}"></script>`);
    expect(info.npmSnippet).toContain("import { init } from '@weldsuite/panel-sdk'");
    // Not the default collector, so the npm snippet names it.
    expect(info.npmSnippet).toContain(`init({ token: '${project.token}', host: '${COLLECTOR}' });`);
  });

  it('is receiving when an event arrived in the last 24 hours', async () => {
    const project = await newProject();
    const seen = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    store.set(seenKvKey(project.id), seen);

    const info = await data<PanelInstallInfo>(await app().request(`${BASE}/${project.id}/install`));
    expect(info).toMatchObject({ lastEventAt: seen, status: 'receiving' });
  });

  it('is waiting again when the last event is older than 24 hours, and still says when it was', async () => {
    const project = await newProject();
    const seen = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    store.set(seenKvKey(project.id), seen);

    const info = await data<PanelInstallInfo>(await app().request(`${BASE}/${project.id}/install`));
    expect(info).toMatchObject({ lastEventAt: seen, status: 'waiting' });
  });

  it('ignores a last-seen value that is not a date', async () => {
    const project = await newProject();
    store.set(seenKvKey(project.id), 'not a date');

    const info = await data<PanelInstallInfo>(await app().request(`${BASE}/${project.id}/install`));
    expect(info).toMatchObject({ lastEventAt: null, status: 'waiting' });
  });

  it('reads the last event of this project only', async () => {
    const project = await newProject();
    const other = await newProject({ name: 'Other' });
    store.set(seenKvKey(other.id), new Date().toISOString());

    const info = await data<PanelInstallInfo>(await app().request(`${BASE}/${project.id}/install`));
    expect(info).toMatchObject({ lastEventAt: null, status: 'waiting' });
  });

  it('drops a trailing slash from the collector origin', async () => {
    const project = await newProject();
    const res = await app(ADMIN, { collectorUrl: 'https://pnl.weldsuite.org/' }).request(`${BASE}/${project.id}/install`);
    const info = await data<PanelInstallInfo>(res);
    expect(info.collectorUrl).toBe('https://pnl.weldsuite.org');
    expect(info.scriptSnippet).toContain('src="https://pnl.weldsuite.org/s.js"');
  });
});

describe('permissions', () => {
  it('keeps pausing, settings and token rotation behind panel_projects:manage', async () => {
    const project = await newProject();
    events = [];
    const member = app(MEMBER);

    expect((await member.request(`${BASE}/${project.id}/settings`, json({ status: 'paused' }, 'PATCH'))).status).toBe(403);
    expect((await member.request(`${BASE}/${project.id}/settings`, json({ settings: { aiEnabled: false } }, 'PATCH'))).status).toBe(403);
    expect((await member.request(`${BASE}/${project.id}/rotate-token`, json({}))).status).toBe(403);

    // The same member can still do what update, create and delete cover.
    expect((await member.request(`${BASE}/${project.id}`, json({ name: 'Renamed' }, 'PATCH'))).status).toBe(200);

    const current = await data<PanelProjectDto>(await app().request(`${BASE}/${project.id}`));
    expect(current).toMatchObject({ name: 'Renamed', status: 'active', token: project.token, settings: project.settings });
    expect(kvRecord(project.token)).toMatchObject({ status: 'active' });
    // Only the rename published.
    expect(events.map((e) => e.eventType)).toEqual(['panel_project:updated']);
  });

  it('lets manage alone change settings and rotate, but not rename or delete', async () => {
    const project = await newProject();
    const manager = app(['panel_projects:manage', 'panel_projects:read']);

    expect((await manager.request(`${BASE}/${project.id}/settings`, json({ status: 'paused' }, 'PATCH'))).status).toBe(200);
    expect((await manager.request(`${BASE}/${project.id}/rotate-token`, json({}))).status).toBe(200);
    expect((await manager.request(`${BASE}/${project.id}`, json({ name: 'Nope' }, 'PATCH'))).status).toBe(403);
    expect((await manager.request(`${BASE}/${project.id}`, { method: 'DELETE' })).status).toBe(403);
  });

  it('gives a reader the project, its token and the install panel, and nothing that changes it', async () => {
    const project = await newProject();
    events = [];
    const reader = app(READER);

    expect((await reader.request(BASE)).status).toBe(200);
    expect((await data<PanelProjectDto>(await reader.request(`${BASE}/${project.id}`))).token).toBe(project.token);
    expect((await reader.request(`${BASE}/${project.id}/install`)).status).toBe(200);

    expect((await reader.request(BASE, json({ name: 'Nope' }))).status).toBe(403);
    expect((await reader.request(`${BASE}/${project.id}`, json({ name: 'Nope' }, 'PATCH'))).status).toBe(403);
    expect((await reader.request(`${BASE}/${project.id}/settings`, json({ status: 'paused' }, 'PATCH'))).status).toBe(403);
    expect((await reader.request(`${BASE}/${project.id}/rotate-token`, json({}))).status).toBe(403);
    expect((await reader.request(`${BASE}/${project.id}`, { method: 'DELETE' })).status).toBe(403);

    expect(await data<PanelProjectDto>(await app().request(`${BASE}/${project.id}`))).toEqual(project);
    expect(events).toEqual([]);
  });

  it('shows nothing to a member without panel_projects:read', async () => {
    const project = await newProject();
    const nobody = app([]);
    expect((await nobody.request(BASE)).status).toBe(403);
    expect((await nobody.request(`${BASE}/${project.id}`)).status).toBe(403);
    expect((await nobody.request(`${BASE}/${project.id}/install`)).status).toBe(403);
  });
});

describe('workspace isolation', () => {
  it("answers 404 for another workspace's project and touches none of its registry or KV state", async () => {
    // Workspace beta's project is known to the collector (registry and KV),
    // but is not in alpha's tenant database.
    const betaToken = 'wpk_' + 'b'.repeat(32);
    await master.insert(panelProjectRegistry).values({
      projectId: 'pnp_beta',
      token: betaToken,
      workspaceId: BETA.workspaceId,
      status: 'active',
      allowedDomains: ['beta.example.com'],
      settings: DEFAULT_PANEL_SETTINGS,
    });
    store.set(projectKvKey(betaToken), 'beta-record');
    const betaSeen = new Date().toISOString();
    store.set(seenKvKey('pnp_beta'), betaSeen);

    const alpha = app();
    const id = 'pnp_beta';
    const attempts: Array<[string, RequestInit | undefined]> = [
      [`${BASE}/${id}`, undefined],
      [`${BASE}/${id}/install`, undefined],
      [`${BASE}/${id}`, json({ name: 'Hijacked', allowedDomains: ['evil.example.com'] }, 'PATCH')],
      [`${BASE}/${id}/settings`, json({ status: 'paused' }, 'PATCH')],
      [`${BASE}/${id}/rotate-token`, json({})],
      [`${BASE}/${id}`, { method: 'DELETE' }],
    ];
    for (const [path, init] of attempts) {
      expect((await alpha.request(path, init)).status, `${init?.method ?? 'GET'} ${path}`).toBe(404);
    }

    expect(await registryRow('pnp_beta')).toMatchObject({
      token: betaToken,
      workspaceId: 'ws_beta',
      status: 'active',
      allowedDomains: ['beta.example.com'],
      deletedAt: null,
    });
    expect(store.get(projectKvKey(betaToken))).toBe('beta-record');
    expect(store.get(seenKvKey('pnp_beta'))).toBe(betaSeen);
    expect(events).toEqual([]);
    expect(((await (await alpha.request(BASE)).json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("registers each project under its own workspace's id, never the Clerk org id", async () => {
    const a = await data<PanelProjectDto>(await app(ADMIN, { workspace: ALPHA }).request(BASE, json({ name: 'A' })));
    const b = await data<PanelProjectDto>(await app(ADMIN, { workspace: BETA }).request(BASE, json({ name: 'B' })));

    expect((await registryRow(a.id))?.workspaceId).toBe('ws_alpha');
    expect((await registryRow(b.id))?.workspaceId).toBe('ws_beta');
    expect(kvRecord(a.token)?.workspaceId).toBe('ws_alpha');
    expect(kvRecord(b.token)?.workspaceId).toBe('ws_beta');
  });
});

describe('when the collector cannot be told', () => {
  it('leaves no project behind if registering a new one fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = {
      ...kv,
      get: kv.get.bind(kv),
      put: async () => {
        throw new Error('kv unavailable');
      },
      delete: kv.delete.bind(kv),
    } as unknown as KVNamespace;

    const res = await app(ADMIN, { kv: failing }).request(BASE, json({ name: 'Unlucky' }));
    expect(res.status).toBe(500);

    expect(await db.select().from(panelProjects)).toEqual([]);
    // The registry row that did get written is marked deleted, so the token routes nowhere.
    const rows = await master.select().from(panelProjectRegistry);
    expect(rows.every((row) => row.deletedAt !== null)).toBe(true);
    expect(store.size).toBe(0);
    expect(events).toEqual([]);
    consoleError.mockRestore();
  });

  it('repairs the collector on the next change after a failed one', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const project = await newProject();
    const failing = {
      get: kv.get.bind(kv),
      put: async () => {
        throw new Error('kv unavailable');
      },
      delete: kv.delete.bind(kv),
    } as unknown as KVNamespace;

    const failed = await app(ADMIN, { kv: failing }).request(
      `${BASE}/${project.id}/settings`,
      json({ status: 'paused' }, 'PATCH'),
    );
    expect(failed.status).toBe(500);
    // The tenant row (the source of truth) already says paused; KV still says active.
    expect(kvRecord(project.token)?.status).toBe('active');

    const retried = await app().request(`${BASE}/${project.id}/settings`, json({ status: 'paused' }, 'PATCH'));
    expect(retried.status).toBe(200);
    expect(kvRecord(project.token)?.status).toBe('paused');
    expect(await registryRow(project.id)).toMatchObject({ status: 'paused' });
    consoleError.mockRestore();
  });
});
