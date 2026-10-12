/**
 * /api/mail-signatures against a pglite tenant DB: who sees and changes which
 * signature, and which defaults a new default replaces.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailSignaturesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

const MEMBER = ['accounts:read', 'messages:read', 'messages:create'];
const ADMIN = [...MEMBER, 'accounts:update', 'accounts:delete'];

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function as(userId: string, keys: string[]) {
  const { request } = createTestApp('/api/mail-signatures', mailSignaturesRoutes, {
    context: { userId, tenantDb: db, permissions: permissions(...keys) },
  });
  const send = (method: string, path: string, body?: unknown) =>
    request(`/api/mail-signatures${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    create: (body: Record<string, unknown>) => send('POST', '', body),
    update: (id: string, body: Record<string, unknown>) => send('PATCH', `/${id}`, body),
    remove: (id: string) => send('DELETE', `/${id}`),
    get: (id: string) => send('GET', `/${id}`),
    list: async () => {
      const res = await send('GET', '?limit=100');
      const json = (await res.json()) as { data: Array<{ id: string; isDefault: boolean }> };
      return json.data;
    },
  };
}

async function idOf(res: Response): Promise<string> {
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

describe('personal signatures', () => {
  it('are created by any mail user, owned by them, and hidden from others', async () => {
    const alice = as('user_alice', MEMBER);
    const bob = as('user_bob', MEMBER);

    const res = await alice.create({ name: 'Alice', content: '<p>Alice</p>', userIds: ['user_bob'] });
    expect(res.status).toBe(201);
    const row = ((await res.json()) as { data: { id: string; type: string; userIds: string[] } }).data;
    expect(row.type).toBe('personal');
    // The owner is the caller, whatever the body says.
    expect(row.userIds).toEqual(['user_alice']);

    expect((await alice.list()).map((s) => s.id)).toContain(row.id);
    expect((await bob.list()).map((s) => s.id)).not.toContain(row.id);
    expect((await bob.get(row.id)).status).toBe(404);
    expect((await bob.update(row.id, { name: 'Taken' })).status).toBe(404);
    expect((await bob.remove(row.id)).status).toBe(404);

    expect((await alice.update(row.id, { name: 'Alice 2' })).status).toBe(200);
    expect((await alice.remove(row.id)).status).toBe(204);
    expect((await alice.get(row.id)).status).toBe(404);
  });

  it("a new default replaces only the owner's overlapping defaults", async () => {
    const carol = as('user_carol', MEMBER);
    const dave = as('user_dave', MEMBER);

    const daveDefault = await idOf(await dave.create({ name: 'Dave', content: 'D', isDefault: true }));
    const onlyA = await idOf(await carol.create({ name: 'A', content: 'A', isDefault: true, accountIds: ['acc_a'] }));
    const onlyB = await idOf(await carol.create({ name: 'B', content: 'B', isDefault: true, accountIds: ['acc_b'] }));

    let mine = await carol.list();
    // Different accounts: both stay the default for their own account.
    expect(mine.find((s) => s.id === onlyA)?.isDefault).toBe(true);
    expect(mine.find((s) => s.id === onlyB)?.isDefault).toBe(true);

    // Every account overlaps both, so it takes over from both.
    const everywhere = await idOf(await carol.create({ name: 'All', content: 'All', isDefault: true }));
    mine = await carol.list();
    expect(mine.find((s) => s.id === everywhere)?.isDefault).toBe(true);
    expect(mine.find((s) => s.id === onlyA)?.isDefault).toBe(false);
    expect(mine.find((s) => s.id === onlyB)?.isDefault).toBe(false);

    // Another member's default is untouched.
    expect((await dave.list()).find((s) => s.id === daveDefault)?.isDefault).toBe(true);
  });
});

describe('shared signatures', () => {
  it('are visible to everyone but only admins change them', async () => {
    const admin = as('user_admin', ADMIN);
    const member = as('user_member', MEMBER);

    expect((await member.create({ name: 'Co', content: 'Co', type: 'company' })).status).toBe(403);

    const id = await idOf(await admin.create({ name: 'Company', content: '<b>ACME</b>', type: 'company' }));
    expect((await member.list()).map((s) => s.id)).toContain(id);
    expect((await member.update(id, { name: 'Mine now' })).status).toBe(403);
    expect((await member.remove(id)).status).toBe(403);

    // A member cannot turn their own signature into a shared one either.
    const own = await idOf(await member.create({ name: 'Own', content: 'Own' }));
    expect((await member.update(own, { type: 'company' })).status).toBe(403);

    expect((await admin.update(id, { name: 'Company 2' })).status).toBe(200);
    expect((await admin.remove(id)).status).toBe(204);
  });

  it('a shared default does not unset anyone\'s personal default', async () => {
    const admin = as('user_admin2', ADMIN);
    const erin = as('user_erin', MEMBER);

    const personal = await idOf(await erin.create({ name: 'Erin', content: 'E', isDefault: true }));
    await idOf(await admin.create({ name: 'Co', content: 'Co', type: 'company', isDefault: true }));

    expect((await erin.list()).find((s) => s.id === personal)?.isDefault).toBe(true);
  });
});
