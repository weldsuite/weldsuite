/**
 * Every /api/helpdesk-email route on pglite, refusals included: the connected
 * addresses (master `mail_account_registry` entries first, then WeldMail
 * accounts flagged for the helpdesk, one per address), the mail accounts and
 * verified domains to pick from, connecting an address (each branch) and
 * disconnecting one.
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

import { helpdeskEmailRoutes } from './index';

const BASE = '/api/helpdesk-email';
const WORKSPACE = 'ws_test_default';
const { mailAccountRegistry, workspaces } = masterSchema;
const { mailAccounts, mailDomains } = schema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pglite drizzle stands in for neon-http
let master: any;
let db: Database;

const at = (second: number) => new Date(Date.UTC(2026, 3, 1, 7, 0, second));

function app(...keys: string[]) {
  return createTestApp(BASE, helpdeskEmailRoutes, {
    context: { permissions: permissions(...keys), tenantDb: db, masterDb: master },
  });
}

const READ = () => app('settings:read');
const CREATE = () => app('settings:create');
const DELETE = () => app('settings:delete');

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function registryOf(email: string) {
  const [row] = await master.select().from(mailAccountRegistry).where(eq(mailAccountRegistry.email, email));
  return row as typeof mailAccountRegistry.$inferSelect | undefined;
}

async function accountOf(id: string) {
  const [row] = await db.select().from(mailAccounts).where(eq(mailAccounts.id, id));
  return row;
}

beforeAll(async () => {
  master = (await createMasterPgliteDb()).db;
  state.master = master;
  db = (await createPgliteDb()).db;
  await master.insert(workspaces).values([
    { id: WORKSPACE, clerkOrgId: 'org_test_default', name: 'Acme', slug: 'acme-mail' },
    { id: 'ws_other', clerkOrgId: 'org_other', name: 'Other', slug: 'other-mail' },
  ]);
  await master.insert(mailAccountRegistry).values([
    { id: 'mreg_support', email: 'support@acme.test', workspaceId: WORKSPACE, accountId: 'helpdesk_hd_1', isActive: true, createdAt: at(1), updatedAt: at(1) },
    { id: 'mreg_old', email: 'old@acme.test', workspaceId: WORKSPACE, accountId: 'helpdesk_hd_2', isActive: false, createdAt: at(2), updatedAt: at(2) },
    { id: 'mreg_shared', email: 'shared@acme.test', workspaceId: WORKSPACE, accountId: 'helpdesk_hd_4', isActive: true, createdAt: at(3), updatedAt: at(3) },
    // A WeldMail account's own registry entry: not a helpdesk address.
    { id: 'mreg_ceo', email: 'ceo@acme.test', workspaceId: WORKSPACE, accountId: 'mac_ceo', isActive: true, createdAt: at(4), updatedAt: at(4) },
    // Another workspace's helpdesk address.
    { id: 'mreg_other', email: 'help@other.test', workspaceId: 'ws_other', accountId: 'helpdesk_hd_3', isActive: true, createdAt: at(5), updatedAt: at(5) },
  ]);
  await db.insert(mailAccounts).values([
    { id: 'mac_sales', name: 'Sales', email: 'sales@acme.test', displayName: 'Acme Sales', provider: 'cloudflare', metadata: { helpdeskEnabled: true, signature: 'Cheers' }, createdAt: at(10), updatedAt: at(10) },
    { id: 'mac_shared', name: 'Shared', email: 'shared@acme.test', metadata: { helpdeskEnabled: true }, createdAt: at(11), updatedAt: at(11) },
    { id: 'mac_info', name: 'Info', email: 'info@acme.test', createdAt: at(12), updatedAt: at(12) },
    // The flag stored as text: listed as an address, but not "linked" on /mail-accounts.
    { id: 'mac_text', name: 'Text flag', email: 'text@acme.test', metadata: { helpdeskEnabled: 'true' }, createdAt: at(13), updatedAt: at(13) },
    { id: 'mac_ceo', name: 'CEO', email: 'ceo@acme.test', metadata: {}, createdAt: at(14), updatedAt: at(14) },
    { id: 'mac_off', name: 'Off', email: 'off@acme.test', status: 'inactive', metadata: { helpdeskEnabled: true }, createdAt: at(15), updatedAt: at(15) },
    { id: 'mac_gone', name: 'Gone', email: 'gone@acme.test', metadata: { helpdeskEnabled: true }, deletedAt: at(16), createdAt: at(16), updatedAt: at(16) },
  ]);
  await db.insert(mailDomains).values([
    { id: 'md_acme', domainName: 'acme.test', isActive: true, dnsStatus: 'verified', createdAt: at(20), updatedAt: at(20) },
    { id: 'md_pending', domainName: 'pending.test', isActive: true, dnsStatus: 'pending', createdAt: at(21), updatedAt: at(21) },
    { id: 'md_off', domainName: 'off.test', isActive: false, dnsStatus: 'verified', createdAt: at(22), updatedAt: at(22) },
    { id: 'md_gone', domainName: 'gone.test', isActive: true, dnsStatus: 'verified', deletedAt: at(23), createdAt: at(23), updatedAt: at(23) },
  ]);
}, 60_000);

describe('GET /api/helpdesk-email/addresses', () => {
  it('needs settings:read', async () => {
    expect((await app('settings:create').request(`${BASE}/addresses`)).status).toBe(403);
  });

  it("lists this workspace's helpdesk registry entries, then flagged mail accounts not already listed", async () => {
    const res = await READ().request(`${BASE}/addresses`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ email: string; source: string }> };
    const bySource = (source: string) => data.filter((a) => a.source === source).map((a) => a.email).sort();
    expect(bySource('registry')).toEqual(['old@acme.test', 'shared@acme.test', 'support@acme.test']);
    expect(bySource('mail_account')).toEqual(['sales@acme.test', 'text@acme.test']);
    expect(data.findIndex((a) => a.source === 'mail_account')).toBe(3);
    expect(data.find((a) => a.email === 'old@acme.test')).toEqual({
      id: 'mreg_old',
      email: 'old@acme.test',
      accountId: 'helpdesk_hd_2',
      isActive: false,
      createdAt: at(2).toISOString(),
      source: 'registry',
    });
    expect(data.find((a) => a.email === 'sales@acme.test')).toEqual({
      id: 'mac_sales',
      email: 'sales@acme.test',
      accountId: 'helpdesk_mail_mac_sales',
      isActive: true,
      createdAt: at(10).toISOString(),
      source: 'mail_account',
    });
  });
});

describe('GET /api/helpdesk-email/mail-accounts', () => {
  it('needs settings:read', async () => {
    expect((await app('settings:create').request(`${BASE}/mail-accounts`)).status).toBe(403);
  });

  it('lists the active mail accounts, marking those the helpdesk uses', async () => {
    const res = await READ().request(`${BASE}/mail-accounts`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ id: string; isLinkedToHelpdesk: boolean }> };
    expect(Object.fromEntries(data.map((a) => [a.id, a.isLinkedToHelpdesk]))).toEqual({
      mac_sales: true,
      mac_shared: true,
      mac_info: false,
      mac_text: false,
      mac_ceo: false,
    });
    expect(data.find((a) => a.id === 'mac_sales')).toEqual({
      id: 'mac_sales',
      name: 'Sales',
      email: 'sales@acme.test',
      displayName: 'Acme Sales',
      provider: 'cloudflare',
      status: 'active',
      metadata: { helpdeskEnabled: true, signature: 'Cheers' },
      isLinkedToHelpdesk: true,
    });
    expect(data.find((a) => a.id === 'mac_info')).toMatchObject({ displayName: null, provider: 'imap', metadata: null });
  });
});

describe('GET /api/helpdesk-email/domains', () => {
  it('needs settings:read', async () => {
    expect((await app('settings:create').request(`${BASE}/domains`)).status).toBe(403);
  });

  it('lists only active, verified, live domains', async () => {
    const res = await READ().request(`${BASE}/domains`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: 'md_acme', domainName: 'acme.test', dnsStatus: 'verified', isActive: true }] });
  });
});

describe('POST /api/helpdesk-email/addresses', () => {
  it('needs settings:create', async () => {
    expect((await READ().request(`${BASE}/addresses`, send('POST', { email: 'new@acme.test' }))).status).toBe(403);
  });

  it('needs a valid email', async () => {
    for (const body of [{}, { email: 'not-an-email' }, { email: 42 }]) {
      const res = await CREATE().request(`${BASE}/addresses`, send('POST', body));
      expect(res.status).toBe(400);
    }
  });

  it('flags an existing mail account (matched lower-cased) and registers it', async () => {
    const res = await CREATE().request(`${BASE}/addresses`, send('POST', { email: 'INFO@Acme.test' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      data: { id: 'mac_info', email: 'info@acme.test', accountId: 'helpdesk_mail_mac_info', isActive: true, source: 'mail_account' },
    });
    expect((await accountOf('mac_info'))?.metadata).toEqual({ helpdeskEnabled: true });
    const reg = await registryOf('info@acme.test');
    expect(reg).toMatchObject({ workspaceId: WORKSPACE, isActive: true, tenantKind: 'workspace' });
    expect(reg?.accountId).toMatch(/^helpdesk_hd_/);
  });

  it('keeps the registry entry a mail account already has', async () => {
    const res = await CREATE().request(`${BASE}/addresses`, send('POST', { email: 'ceo@acme.test' }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { id: string } }).data.id).toBe('mac_ceo');
    expect((await accountOf('mac_ceo'))?.metadata).toEqual({ helpdeskEnabled: true });
    expect(await registryOf('ceo@acme.test')).toMatchObject({ id: 'mreg_ceo', accountId: 'mac_ceo' });
  });

  it('refuses a mail account the helpdesk already uses', async () => {
    const res = await CREATE().request(`${BASE}/addresses`, send('POST', { email: 'sales@acme.test' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'CONFLICT', message: 'Email "sales@acme.test" is already connected to helpdesk.' } });
  });

  it('refuses an address that is already an active helpdesk registry entry', async () => {
    const res = await CREATE().request(`${BASE}/addresses`, send('POST', { email: 'Support@acme.test' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: 'CONFLICT', message: 'Email "support@acme.test" is already connected to helpdesk.' } });
  });

  it('refuses an address on a domain that is not verified, or not active', async () => {
    for (const [email, domain] of [
      ['hello@pending.test', 'pending.test'],
      ['hello@off.test', 'off.test'],
      ['hello@gone.test', 'gone.test'],
    ]) {
      const res = await CREATE().request(`${BASE}/addresses`, send('POST', { email }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: { code: 'BAD_REQUEST', message: `Domain "${domain}" is not verified. Please verify it in Mail settings first.` },
      });
    }
  });

  it('registers a new address on a verified domain', async () => {
    const res = await CREATE().request(`${BASE}/addresses`, send('POST', { email: 'new@acme.test' }));
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string; email: string; accountId: string; isActive: boolean } };
    expect(Object.keys(data).sort()).toEqual(['accountId', 'email', 'id', 'isActive']);
    expect(data).toMatchObject({ email: 'new@acme.test', isActive: true });
    expect(data.id).toMatch(/^mreg_/);
    expect(data.accountId).toMatch(/^helpdesk_hd_/);
    expect(await registryOf('new@acme.test')).toMatchObject({ id: data.id, accountId: data.accountId, workspaceId: WORKSPACE });
  });

  it('fails on an address whose inactive registry entry still holds the email', async () => {
    // The insert hits the registry's unique email; the route logs it and answers a 500.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await CREATE().request(`${BASE}/addresses`, send('POST', { email: 'old@acme.test' }));
    quiet.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to connect email address' } });
    expect(await registryOf('old@acme.test')).toMatchObject({ id: 'mreg_old', isActive: false });
  });
});

describe('DELETE /api/helpdesk-email/addresses/:id', () => {
  it('needs settings:delete', async () => {
    expect((await CREATE().request(`${BASE}/addresses/mreg_support`, send('DELETE'))).status).toBe(403);
  });

  it("deactivates this workspace's registry entry", async () => {
    const res = await DELETE().request(`${BASE}/addresses/mreg_support`, send('DELETE'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'mreg_support', isActive: false } });
    expect(await registryOf('support@acme.test')).toMatchObject({ id: 'mreg_support', isActive: false });
  });

  it("removes the helpdesk flag from a mail account, keeping the rest of its metadata", async () => {
    const res = await DELETE().request(`${BASE}/addresses/mac_sales`, send('DELETE'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'mac_sales', isActive: false } });
    expect((await accountOf('mac_sales'))?.metadata).toEqual({ signature: 'Cheers' });
  });

  it("is a 404 for another workspace's entry, a non-helpdesk entry, a deleted account and an unknown id", async () => {
    for (const id of ['mreg_other', 'mreg_ceo', 'mac_gone', 'nothing_here']) {
      const res = await DELETE().request(`${BASE}/addresses/${id}`, send('DELETE'));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: `Email address with ID '${id}' not found` } });
    }
    expect(await registryOf('help@other.test')).toMatchObject({ isActive: true });
  });

  it('no longer lists what was disconnected', async () => {
    const res = await READ().request(`${BASE}/addresses`);
    const { data } = (await res.json()) as { data: Array<{ email: string; isActive: boolean; source: string }> };
    // The registry entry stays listed, inactive; the mail account drops out.
    expect(data.find((a) => a.email === 'support@acme.test')).toMatchObject({ isActive: false, source: 'registry' });
    expect(data.some((a) => a.email === 'sales@acme.test')).toBe(false);
  });
});
