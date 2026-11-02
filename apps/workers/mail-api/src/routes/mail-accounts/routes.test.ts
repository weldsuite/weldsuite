/**
 * /api/mail-accounts against a pglite tenant DB (postgres mode): the list and
 * its filters, detail, labels, stats, create with its guards and system
 * labels, settings, access, sync and delete, as an admin and as a member.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailAccountsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const ALL = ['accounts:read', 'accounts:create', 'accounts:update', 'accounts:delete'];
const ADMIN = 'user_acc_admin';
const MEMBER = 'user_acc_member';
const OTHER = 'user_acc_other';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = new Date('2026-01-01T00:00:00.000Z');
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_acc_admin', userId: ADMIN, email: 'admin@acme.test', role: 'ADMIN', status: 'ACTIVE', createdAt: at, updatedAt: at },
    { id: 'wm_acc_member', userId: MEMBER, email: 'member@acme.test', role: 'MEMBER', status: 'ACTIVE', createdAt: at, updatedAt: at },
    { id: 'wm_acc_other', userId: OTHER, email: 'other@acme.test', role: 'MEMBER', status: 'ACTIVE', createdAt: at, updatedAt: at },
  ] as never);
  await db.insert(schema.mailDomains).values({
    id: 'mdom_acc_1',
    domainName: 'acme.test',
    isActive: true,
    mailProvider: 'manual',
    sendProvider: 'manual',
    receiveProvider: 'manual',
    createdAt: at,
    updatedAt: at,
  } as never);
}, 60_000);

function as(userId: string, keys: string[] = ALL) {
  const { request } = createTestApp('/api/mail-accounts', mailAccountsRoutes, {
    context: { userId, tenantDb: db, permissions: permissions(...keys) },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/mail-accounts${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function created(res: Response): Promise<string> {
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

describe('create', () => {
  it('validates the body', async () => {
    const admin = as(ADMIN);
    expect((await admin('POST', '', { name: '', email: 'nope' })).status).toBe(400);
    expect((await admin('POST', '', { name: 'X', email: 'x@acme.test', dailySendLimit: 5000 })).status).toBe(400);
    expect((await admin('POST', '', { name: 'X', email: 'x@acme.test', provider: 'aol' })).status).toBe(400);
    expect((await admin('POST', '', { name: 'X', email: 'x@acme.test', aiSettings: { defaultTone: 'rude' } })).status).toBe(400);
  });

  it('refuses WeldMail apexes and unknown domains', async () => {
    const admin = as(ADMIN);
    const bare = await admin('POST', '', { name: 'Bare', email: 'hi@weldmail.com' });
    expect(bare.status).toBe(400);
    const unknown = await admin('POST', '', { name: 'Elsewhere', email: 'hi@unknown.test' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: { message: string } }).error.message).toContain('WeldHost');
  });

  it('creates shared and private mailboxes with their system labels', async () => {
    const admin = as(ADMIN);
    const shared = await created(
      await admin('POST', '', {
        name: 'Support',
        email: 'support@acme.test',
        displayName: 'Acme Support',
        provider: 'custom',
        isDefault: true,
        signature: '-- Acme',
        aiSettings: { defaultTone: 'friendly' },
      }),
    );
    const labels = await admin('GET', `/${shared}/labels`);
    expect(labels.status).toBe(200);
    const rows = ((await labels.json()) as { data: Array<{ slug: string }> }).data;
    expect(rows.map((l) => l.slug).sort()).toContain('INBOX');
    expect(rows).toHaveLength(11);

    // A member creating a private mailbox is assigned to it.
    const member = as(MEMBER);
    const mine = await created(await member('POST', '', { name: 'Mine', email: 'mine@acme.test', isShared: false }));
    const detail = await member('GET', `/${mine}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { data: { assignedUserIds: string[] } }).data.assignedUserIds).toEqual([MEMBER]);

    // An admin choosing someone else is not added to it.
    const forOther = await created(
      await admin('POST', '', { name: 'Other', email: 'other@acme.test', isShared: false, assignedUserIds: [OTHER] }),
    );
    expect((await as(OTHER)('GET', `/${forOther}`)).status).toBe(200);
    expect((await member('GET', `/${forOther}`)).status).toBe(404);

    // Duplicates are a conflict.
    expect((await admin('POST', '', { name: 'Again', email: 'support@acme.test' })).status).toBe(409);
  });
});

describe('reads', () => {
  it('lists, filters, pages and counts', async () => {
    const admin = as(ADMIN);
    const all = await admin('GET', '?limit=100');
    expect(all.status).toBe(200);
    const member = as(MEMBER);
    expect((await member('GET', '')).status).toBe(200);
    expect((await member('GET', '?scope=manage')).status).toBe(200);
    expect((await admin('GET', '?scope=manage')).status).toBe(200);
    expect((await admin('GET', '?search=support')).status).toBe(200);
    expect((await admin('GET', '?status=active&provider=custom')).status).toBe(200);
    expect((await admin('GET', '?scope=everything')).status).toBe(400);
    expect((await admin('GET', '?limit=0')).status).toBe(400);

    const first = await admin('GET', '?limit=1&scope=manage');
    const page = (await first.json()) as { pagination: { cursor: string | null } };
    expect(page.pagination.cursor).not.toBeNull();
    expect((await admin('GET', `?limit=1&scope=manage&cursor=${page.pagination.cursor}`)).status).toBe(200);

    expect((await admin('GET', '/stats')).status).toBe(200);
    expect((await admin('GET', '/setup/labels')).status).toBe(200);
    expect((await admin('GET', '/mail_missing')).status).toBe(404);
    expect((await admin('GET', '/mail_missing/labels')).status).toBe(404);
  });
});

describe('writes', () => {
  it('updates settings, access and sync, then deletes', async () => {
    const admin = as(ADMIN);
    const member = as(MEMBER);
    const id = await created(await admin('POST', '', { name: 'Sales', email: 'sales@acme.test' }));

    const patched = await admin('PATCH', `/${id}`, { displayName: 'Acme Sales', dailySendLimit: 200, isDefault: true });
    expect(patched.status).toBe(200);
    expect((await admin('PUT', `/${id}`, { name: 'Sales team', aiSettings: { defaultLength: 'short' } })).status).toBe(200);
    expect((await admin('PATCH', `/${id}`, { email: 'bad' })).status).toBe(400);
    expect((await admin('PATCH', '/mail_missing', { name: 'x' })).status).toBe(404);

    expect((await admin('PATCH', `/${id}/sync`)).status).toBe(200);
    expect((await admin('PATCH', '/mail_missing/sync')).status).toBe(404);

    expect((await member('PATCH', `/${id}/assign-users`, { isShared: false, assignedUserIds: [MEMBER] })).status).toBe(403);
    expect((await admin('PATCH', `/${id}/assign-users`, { isShared: false, assignedUserIds: ['user_nobody'] })).status).toBe(400);
    expect((await admin('PATCH', '/mail_missing/assign-users', { isShared: true })).status).toBe(404);
    const assigned = await admin('PATCH', `/${id}/assign-users`, { isShared: false, assignedUserIds: [MEMBER] });
    expect(assigned.status).toBe(200);
    expect(((await assigned.json()) as { data: { assignedUserIds: string[] } }).data.assignedUserIds).toEqual([MEMBER]);
    expect((await as(OTHER)('PATCH', `/${id}`, { name: 'Hijack' })).status).toBe(404);
    expect((await as(OTHER)('DELETE', `/${id}`)).status).toBe(404);
    expect((await admin('PATCH', `/${id}/assign-users`, { isShared: true })).status).toBe(200);

    expect((await admin('DELETE', `/${id}`)).status).toBe(204);
    expect((await admin('GET', `/${id}`)).status).toBe(404);
    expect((await admin('DELETE', `/${id}`)).status).toBe(404);
  });
});
