/**
 * /api/workspace-settings against real tenant and master databases (pglite)
 * with Clerk as a fetch stub: the settings record (validation, insert, update,
 * the digest timezone mirror), rename and slug (roles, Clerk sync and its
 * rollback, the help-center subdomain), the deletion status and the deletion.
 * Conformance-ready (rust/conformance/suites.json): entity events and Clerk's
 * calls are compared between the backends.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as masterSchema from '@weldsuite/db/schema/master';
import { conformanceMasterDb, createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { clerkCalls, clerkError, stubClerk } from '../../test/fake-clerk';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown }));

vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
}));
// The SDK's requests, through the stubbed fetch (the SDK binds fetch at load).
vi.mock('@clerk/backend', async () => {
  const { clerkShim } = await import('../../test/fake-clerk');
  return { createClerkClient: () => clerkShim() };
});

import { workspaceSettingsRoutes } from './index';

const { workspaces, userWorkspaces, users, helpcenterDomainRegistry, digestSchedules } = masterSchema;
const ORG = 'org_wss';

let db: Database;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
const kv = { delete: vi.fn(async () => undefined), get: vi.fn(async () => null), put: vi.fn(async () => undefined) };

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  master = (await createMasterPgliteDb()).db;
  holder.master = master;
}, 180_000);

async function seed(): Promise<void> {
  await db.delete(schema.workspaceSettings);
  await db.delete(schema.workspaceMembers);
  await db.delete(schema.helpcenterSettings);
  const now = new Date();
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_wss_owner', userId: 'user_owner', email: 'o@example.com', role: 'OWNER', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'wm_wss_admin', userId: 'user_admin', email: 'a@example.com', role: 'ADMIN', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'wm_wss_member', userId: 'user_member', email: 'm@example.com', role: 'MEMBER', status: 'ACTIVE', createdAt: now, updatedAt: now },
    { id: 'wm_wss_pending', userId: 'invited_p@example.com', email: 'p@example.com', role: 'MEMBER', status: 'PENDING', createdAt: now, updatedAt: now },
  ] as (typeof schema.workspaceMembers.$inferInsert)[]);
  await db.insert(schema.helpcenterSettings).values({ id: 'hcs_wss', defaultSubdomain: 'wss-acme.welddesk.org' } as never);

  await master.delete(digestSchedules);
  await master.delete(helpcenterDomainRegistry);
  await master.delete(userWorkspaces);
  await master.delete(workspaces);
  await master.delete(users);
  await master.insert(users).values({ id: 'user_owner', email: 'o@example.com' });
  await master.insert(workspaces).values([
    { id: 'ws_wss', clerkOrgId: ORG, name: 'Acme', slug: 'wss-acme', stripeSubscriptionId: 'sub_1' },
    { id: 'ws_wss_other', clerkOrgId: 'org_wss_other', name: 'Other', slug: 'wss-taken' },
  ]);
  await master.insert(userWorkspaces).values({ id: 'uw_wss', userId: 'user_owner', workspaceId: 'ws_wss', role: 'org:admin' });
  await master.insert(helpcenterDomainRegistry).values({
    id: 'hdr_wss',
    domain: 'wss-acme.welddesk.org',
    domainType: 'subdomain',
    workspaceId: 'ws_wss',
  });
  await master.insert(digestSchedules).values({ id: 'ds_wss', workspaceId: 'ws_wss', timezone: 'UTC' } as never);
}

beforeEach(async () => {
  await seed();
  kv.delete.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function app(userId = 'user_owner', ...keys: string[]) {
  return createTestApp('/api/workspace-settings', workspaceSettingsRoutes, {
    context: {
      userId,
      orgId: ORG,
      tenantDb: db,
      masterDb: master,
      permissions: permissions(...(keys.length > 0 ? keys : ['*'])),
    },
    env: { WORKSPACE_CACHE: kv as unknown as KVNamespace },
  });
}

function send(t: ReturnType<typeof app>, path: string, method: string, body: unknown) {
  return t.request(`/api/workspace-settings${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const masterWorkspace = async () =>
  (await master.select().from(workspaces).where(eq(workspaces.id, 'ws_wss')))[0] as typeof workspaces.$inferSelect;

describe('settings record', () => {
  it('reads null before the first save, and needs general:read', async () => {
    const res = await app().request('/api/workspace-settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: null });
    const refused = await app('user_member', 'team:read').request('/api/workspace-settings');
    expect(refused.status).toBe(403);
  });

  it('creates (201), then updates (200), mirroring the timezone to the digest', async () => {
    stubClerk(() => undefined);
    const created = await send(app(), '', 'PUT', {
      timezone: 'Europe/Amsterdam',
      legalName: 'Acme B.V.',
      email: '  billing@acme.example ',
      customSettings: { printnode: { enabled: true } },
    });
    expect(created.status).toBe(201);
    const first = (await created.json()) as { data: Record<string, unknown> };
    expect(first.data).toMatchObject({ timezone: 'Europe/Amsterdam', email: 'billing@acme.example', logoUrl: null });
    const [digest] = await master.select().from(digestSchedules).where(eq(digestSchedules.id, 'ds_wss'));
    expect(digest.timezone).toBe('Europe/Amsterdam');

    const updated = await send(app(), '', 'PUT', { logoUrl: 'https://cdn/logo.png', legalName: null, email: '' });
    expect(updated.status).toBe(200);
    const second = (await updated.json()) as { data: Record<string, unknown> };
    expect(second.data).toMatchObject({
      id: first.data.id,
      logoUrl: 'https://cdn/logo.png',
      legalName: null,
      email: '',
      timezone: 'Europe/Amsterdam',
    });

    const read = await app('user_member', 'general:read').request('/api/workspace-settings');
    expect(((await read.json()) as { data: { id: string } }).data.id).toBe(first.data.id);
  });

  it('refuses unknown keys, bad types, a bad email and a bad VAT number', async () => {
    for (const body of [
      { name: 'Acme' },
      { timezone: 5 },
      { email: 'not-an-email' },
      { email: 42 },
      { phone: 'x'.repeat(31) },
      { vatNumber: 'NL123', country: 'NL' },
      { vatNumber: 'NOT A VAT!!', country: 'US' },
      { customSettings: [1] },
      { theme: null },
      [],
    ]) {
      const res = await send(app(), '', 'PUT', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('accepts a VAT number in the country format, and needs general:update', async () => {
    const ok = await send(app(), '', 'PUT', { vatNumber: 'NL 1234.56.789 B01', country: 'NL' });
    expect(ok.status).toBe(201);
    const refused = await send(app('user_member', 'general:read'), '', 'PUT', { theme: 'dark' });
    expect(refused.status).toBe(403);
  });
});

describe('PUT /name', () => {
  it('lets the owner or an admin rename, mirrored to Clerk', async () => {
    const stub = stubClerk((method, path) =>
      method === 'PATCH' && path === `/organizations/${ORG}` ? { status: 200, body: { id: ORG } } : undefined,
    );
    const res = await send(app('user_admin'), '/name', 'PUT', { name: '  Acme Labs  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'ws_wss', name: 'Acme Labs' } });
    expect((await masterWorkspace()).name).toBe('Acme Labs');
    expect(clerkCalls(stub)).toEqual([`PATCH /organizations/${ORG}`]);
    expect(kv.delete).toHaveBeenCalled();
  });

  it('skips Clerk when the name is the same', async () => {
    const stub = stubClerk(() => ({ status: 200, body: {} }));
    const res = await send(app(), '/name', 'PUT', { name: 'Acme' });
    expect(res.status).toBe(200);
    expect(clerkCalls(stub)).toEqual([]);
  });

  it('puts the name back when Clerk refuses (409) or cannot be reached (500)', async () => {
    stubClerk(() => clerkError(422, 'form_param_value_invalid'));
    const refused = await send(app(), '/name', 'PUT', { name: 'Nope' });
    expect(refused.status).toBe(409);
    expect((await masterWorkspace()).name).toBe('Acme');

    stubClerk(() => 'throw');
    const down = await send(app(), '/name', 'PUT', { name: 'Nope' });
    expect(down.status).toBe(500);
    expect((await masterWorkspace()).name).toBe('Acme');
  });

  it('refuses members and bad names', async () => {
    stubClerk(() => ({ status: 200, body: {} }));
    expect((await send(app('user_member'), '/name', 'PUT', { name: 'X' })).status).toBe(403);
    for (const body of [{ name: '   ' }, { name: 'x'.repeat(256) }, {}, { name: 3 }]) {
      expect((await send(app(), '/name', 'PUT', body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('answers 404 for an org without a workspace', async () => {
    stubClerk(() => ({ status: 200, body: {} }));
    await master.update(workspaces).set({ clerkOrgId: 'org_wss_moved' }).where(eq(workspaces.id, 'ws_wss'));
    expect((await send(app(), '/name', 'PUT', { name: 'Elsewhere' })).status).toBe(404);
  });
});

describe('POST /slug', () => {
  it('lets the owner change it, with the help-center subdomain', async () => {
    const stub = stubClerk((method) => (method === 'PATCH' ? { status: 200, body: {} } : undefined));
    const res = await send(app(), '/slug', 'POST', { slug: 'acme-labs' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'ws_wss', slug: 'acme-labs', previousSlug: 'wss-acme' } });
    expect(clerkCalls(stub)).toEqual([`PATCH /organizations/${ORG}`]);
    const [registry] = await master.select().from(helpcenterDomainRegistry).where(eq(helpcenterDomainRegistry.id, 'hdr_wss'));
    expect(registry.domain).toBe('acme-labs.welddesk.org');
    const [hc] = await db.select().from(schema.helpcenterSettings).where(eq(schema.helpcenterSettings.id, 'hcs_wss'));
    expect(hc!.defaultSubdomain).toBe('acme-labs.welddesk.org');
  });

  it('rolls everything back when Clerk refuses the slug', async () => {
    for (const [code, message] of [
      ['form_identifier_exists', 'That slug is already in use. Please try a different value.'],
      ['form_param_format_invalid', 'That slug is not in a valid format. Use lowercase letters, numbers, and hyphens.'],
      ['something_else', 'That slug could not be used. Please try a different value.'],
    ] as const) {
      stubClerk(() => clerkError(422, code));
      const res = await send(app(), '/slug', 'POST', { slug: 'acme-labs' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { message: string } }).error.message).toBe(message);
      expect((await masterWorkspace()).slug).toBe('wss-acme');
    }
    const [registry] = await master.select().from(helpcenterDomainRegistry).where(eq(helpcenterDomainRegistry.id, 'hdr_wss'));
    expect(registry.domain).toBe('wss-acme.welddesk.org');
  });

  it('refuses the same slug, a taken one, admins and bad slugs', async () => {
    stubClerk(() => ({ status: 200, body: {} }));
    expect((await send(app(), '/slug', 'POST', { slug: 'wss-acme' })).status).toBe(400);
    expect((await send(app(), '/slug', 'POST', { slug: 'wss-taken' })).status).toBe(409);
    expect((await send(app('user_admin'), '/slug', 'POST', { slug: 'acme-labs' })).status).toBe(403);
    for (const body of [{ slug: 'ab' }, { slug: 'Acme' }, { slug: 'www' }, { slug: 'x'.repeat(64) }, { slug: 1 }]) {
      expect((await send(app(), '/slug', 'POST', body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('deletion', () => {
  it('shows the owner what deletion removes', async () => {
    const res = await app().request('/api/workspace-settings/deletion-status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { workspaceId: 'ws_wss', name: 'Acme', slug: 'wss-acme', memberCount: 3, hasActiveSubscription: true },
    });
    expect((await app('user_admin').request('/api/workspace-settings/deletion-status')).status).toBe(403);
  });

  it('needs the slug typed, the owner, and Clerk', async () => {
    stubClerk(() => clerkError(500, 'internal'));
    expect((await send(app(), '/delete', 'POST', { confirmation: 'acme' })).status).toBe(400);
    expect((await send(app(), '/delete', 'POST', { confirmation: '' })).status).toBe(400);
    expect((await send(app('user_admin'), '/delete', 'POST', { confirmation: 'wss-acme' })).status).toBe(403);
    const failed = await send(app(), '/delete', 'POST', { confirmation: 'wss-acme' });
    expect(failed.status).toBe(500);
    expect((await masterWorkspace()).isActive).toBe(true);
  });

  it('deletes the org and marks the workspace deleted', async () => {
    const stub = stubClerk((method) => (method === 'DELETE' ? { status: 200, body: { deleted: true } } : undefined));
    const res = await send(app(), '/delete', 'POST', { confirmation: 'wss-acme' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { deleted: true } });
    expect(clerkCalls(stub)).toEqual([`DELETE /organizations/${ORG}`]);
    const workspace = await masterWorkspace();
    expect(workspace.isActive).toBe(false);
    expect(workspace.deletedAt).not.toBeNull();
    expect(await master.select().from(userWorkspaces).where(eq(userWorkspaces.workspaceId, 'ws_wss'))).toEqual([]);
  });
});
