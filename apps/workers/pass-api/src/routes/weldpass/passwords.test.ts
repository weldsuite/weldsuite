/**
 * DB-backed tests for the WeldPass password manager.
 *
 * The rules that must never regress, each covered directly:
 *
 *   1. A personal vault opens for its owner and nobody else — not a teammate,
 *      and not a workspace admin holding `passwords:manage`.
 *   2. A shared vault opens for its members only, at their role. A viewer reads
 *      but does not write.
 *   3. `passwords:manage` can repair a shared vault's membership but cannot
 *      read its items without joining, and joining lands in the trail.
 *   4. A password travels only on `reveal`. Lists never carry one, and the row
 *      in the database is not the plaintext.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { weldpassRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const ROOT_KEY = 'b'.repeat(64);
const BASE = '/api/weldpass';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const ALICE = 'user_alice';
const BOB = 'user_bob';
const CAROL = 'user_carol';
const ADMIN = 'user_admin';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;

  await db.insert(schema.workspaceMembers).values(
    [ALICE, BOB, CAROL, ADMIN].map((userId) => ({
      id: `wm_${userId}`,
      userId,
      name: userId.replace('user_', ''),
      email: `${userId}@example.com`,
    })),
  );
}, 60_000);

/** A caller in `workspaceId` holding exactly `grants`. */
function as(userId: string, grants: string[] = ['passwords:use', 'passwords:create'], workspaceId = 'org_pw') {
  const { request } = createTestApp(BASE, weldpassRoutes, {
    context: {
      userId,
      permissions: permissions(...grants),
      tenantDb: db,
      workspaceId,
      orgId: workspaceId,
    },
    env: { WELDPASS_ROOT_KEY: ROOT_KEY },
  });

  return {
    get: (path: string) => request(`${BASE}${path}`),
    send: (method: string, path: string, body?: unknown) =>
      request(`${BASE}${path}`, {
        method,
        headers: JSON_HEADERS,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

const admin = () => as(ADMIN, ['passwords:use', 'passwords:create', 'passwords:manage']);

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

interface VaultBody {
  id: string;
  kind: 'personal' | 'shared';
  name: string;
  role: string | null;
  itemCount: number;
  memberCount: number;
}

interface ItemBody {
  id: string;
  vaultId: string;
  title: string;
  subtitle: string | null;
  host: string | null;
  hasTotp: boolean;
  version: number;
}

async function personalVaultOf(userId: string): Promise<VaultBody> {
  const vaults = await data<VaultBody[]>(await as(userId).get('/vaults'));
  const personal = vaults.find((vault) => vault.kind === 'personal');
  if (!personal) throw new Error('no personal vault');
  return personal;
}

async function createShared(userId: string, name: string): Promise<VaultBody> {
  const res = await as(userId).send('POST', '/vaults', { name });
  expect(res.status).toBe(201);
  return data<VaultBody>(res);
}

function login(title: string, password: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'login',
    title,
    url: 'https://example.com/login',
    fields: { username: 'alice@example.com', password, totp: '', notes: '', ...extra },
  };
}

async function addItem(userId: string, vaultId: string, body: unknown): Promise<ItemBody> {
  const res = await as(userId).send('POST', `/vaults/${vaultId}/items`, body);
  expect(res.status).toBe(201);
  return data<ItemBody>(res);
}

describe('password manager · permission gate', () => {
  it('refuses everything without passwords:use', async () => {
    const caller = as(ALICE, ['secrets:read', 'secrets:reveal', 'secrets:manage']);
    expect((await caller.get('/vaults')).status).toBe(403);
    expect((await caller.get('/items')).status).toBe(403);
    expect((await caller.get('/password-health')).status).toBe(403);
  });

  it('needs passwords:create to start a shared vault', async () => {
    const res = await as(ALICE, ['passwords:use']).send('POST', '/vaults', { name: 'Nope' });
    expect(res.status).toBe(403);
  });
});

describe('password manager · personal vault', () => {
  it('is created on first use, exactly once', async () => {
    const first = await personalVaultOf(ALICE);
    const second = await personalVaultOf(ALICE);
    expect(second.id).toBe(first.id);
    expect(first.role).toBe('manager');
  });

  it('is invisible to a teammate', async () => {
    const mine = await personalVaultOf(ALICE);
    const item = await addItem(ALICE, mine.id, login('Private bank', 'hunter2-private'));

    const bob = as(BOB);
    expect((await bob.get(`/vaults/${mine.id}`)).status).toBe(404);
    expect((await bob.get(`/items?vaultId=${mine.id}`)).status).toBe(404);
    expect((await bob.get(`/vaults/${mine.id}/items/${item.id}/reveal`)).status).toBe(404);

    const bobsItems = await data<ItemBody[]>(await bob.get('/items'));
    expect(bobsItems.some((entry) => entry.id === item.id)).toBe(false);
  });

  it('is invisible to a workspace admin with passwords:manage', async () => {
    const mine = await personalVaultOf(ALICE);
    const item = await addItem(ALICE, mine.id, login('Admin cannot see', 'hunter2-admin'));

    expect((await admin().get(`/vaults/${mine.id}`)).status).toBe(404);
    expect((await admin().get(`/vaults/${mine.id}/items/${item.id}/reveal`)).status).toBe(404);
    expect((await admin().get(`/vaults/${mine.id}/activity`)).status).toBe(404);

    const listed = await data<VaultBody[]>(await admin().get('/vaults'));
    expect(listed.some((vault) => vault.id === mine.id)).toBe(false);
  });

  it('cannot be shared or deleted', async () => {
    const mine = await personalVaultOf(ALICE);
    const alice = as(ALICE);

    const share = await alice.send('POST', `/vaults/${mine.id}/members`, {
      userId: BOB,
      role: 'viewer',
    });
    expect(share.status).toBe(403);
    expect((await alice.send('DELETE', `/vaults/${mine.id}`)).status).toBe(403);
  });

  it('is scoped to the workspace', async () => {
    const mine = await personalVaultOf(ALICE);
    const elsewhere = as(ALICE, ['passwords:use'], 'org_other');
    expect((await elsewhere.get(`/vaults/${mine.id}`)).status).toBe(404);
  });
});

describe('password manager · secrecy', () => {
  it('never lists a password, and never stores one in the clear', async () => {
    const vault = await personalVaultOf(ALICE);
    const item = await addItem(ALICE, vault.id, login('Secrecy', 'correct-horse-battery'));

    const listing = await (await as(ALICE).get('/items')).text();
    expect(listing).not.toContain('correct-horse-battery');
    expect(JSON.stringify(item)).not.toContain('correct-horse-battery');

    const [row] = await db
      .select()
      .from(schema.weldpassItems)
      .where(eq(schema.weldpassItems.id, item.id));
    expect(JSON.stringify(row)).not.toContain('correct-horse-battery');
    // The username is a display column on purpose; the password is not.
    expect(row.subtitle).toBe('alice@example.com');
    expect(row.host).toBe('example.com');
  });

  it('reveals the fields to the owner and records it', async () => {
    const vault = await personalVaultOf(ALICE);
    const item = await addItem(ALICE, vault.id, login('Reveal me', 'reveal-value-123'));

    const res = await as(ALICE).get(`/vaults/${vault.id}/items/${item.id}/reveal`);
    expect(res.status).toBe(200);
    const revealed = await data<{ fields: { password: string; username: string } }>(res);
    expect(revealed.fields.password).toBe('reveal-value-123');

    const events = await db
      .select()
      .from(schema.weldpassVaultEvents)
      .where(eq(schema.weldpassVaultEvents.itemId, item.id));
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(['item.created', 'item.revealed']),
    );
    expect(JSON.stringify(events)).not.toContain('reveal-value-123');
  });

  it('will not open an item addressed through the wrong vault', async () => {
    const alices = await personalVaultOf(ALICE);
    const bobs = await personalVaultOf(BOB);
    const item = await addItem(ALICE, alices.id, login('Mine', 'only-alice'));

    expect((await as(BOB).get(`/vaults/${bobs.id}/items/${item.id}/reveal`)).status).toBe(404);
  });
});

describe('password manager · shared vaults', () => {
  it('opens for members at their role, and for nobody else', async () => {
    const vault = await createShared(ALICE, 'Marketing');
    const item = await addItem(ALICE, vault.id, login('Team Twitter', 'shared-secret-1'));

    // Not a member yet.
    expect((await as(BOB).get(`/vaults/${vault.id}`)).status).toBe(404);

    const add = await as(ALICE).send('POST', `/vaults/${vault.id}/members`, {
      userId: BOB,
      role: 'viewer',
    });
    expect(add.status).toBe(201);

    // A viewer reads…
    const reveal = await as(BOB).get(`/vaults/${vault.id}/items/${item.id}/reveal`);
    expect(reveal.status).toBe(200);
    expect((await data<{ fields: { password: string } }>(reveal)).fields.password).toBe(
      'shared-secret-1',
    );

    // …but does not write, share, or read the trail.
    const bob = as(BOB);
    expect(
      (await bob.send('POST', `/vaults/${vault.id}/items`, login('Sneaky', 'x'))).status,
    ).toBe(403);
    expect(
      (await bob.send('PUT', `/vaults/${vault.id}/items/${item.id}`, login('Renamed', 'x'))).status,
    ).toBe(403);
    expect((await bob.send('DELETE', `/vaults/${vault.id}/items/${item.id}`)).status).toBe(403);
    expect(
      (await bob.send('POST', `/vaults/${vault.id}/members`, { userId: CAROL, role: 'viewer' }))
        .status,
    ).toBe(403);
    expect((await bob.get(`/vaults/${vault.id}/activity`)).status).toBe(403);

    // Carol was never added.
    expect((await as(CAROL).get(`/vaults/${vault.id}/items/${item.id}/reveal`)).status).toBe(404);
  });

  it('lets an editor write but not manage members', async () => {
    const vault = await createShared(ALICE, 'Editors');
    await as(ALICE).send('POST', `/vaults/${vault.id}/members`, { userId: BOB, role: 'editor' });

    const item = await addItem(BOB, vault.id, login('Added by editor', 'editor-pw-123456'));
    expect(item.vaultId).toBe(vault.id);
    expect(
      (await as(BOB).send('POST', `/vaults/${vault.id}/members`, { userId: CAROL, role: 'viewer' }))
        .status,
    ).toBe(403);
  });

  it('stops reading the moment a member is removed', async () => {
    const vault = await createShared(ALICE, 'Revocation');
    const item = await addItem(ALICE, vault.id, login('Revocable', 'revoke-me-please'));
    await as(ALICE).send('POST', `/vaults/${vault.id}/members`, { userId: BOB, role: 'viewer' });
    expect((await as(BOB).get(`/vaults/${vault.id}/items/${item.id}/reveal`)).status).toBe(200);

    expect((await as(ALICE).send('DELETE', `/vaults/${vault.id}/members/${BOB}`)).status).toBe(204);
    expect((await as(BOB).get(`/vaults/${vault.id}/items/${item.id}/reveal`)).status).toBe(404);
  });

  it('refuses to share with someone outside the workspace', async () => {
    const vault = await createShared(ALICE, 'Strangers');
    const res = await as(ALICE).send('POST', `/vaults/${vault.id}/members`, {
      userId: 'user_nobody',
      role: 'viewer',
    });
    expect(res.status).toBe(404);
  });

  it('always keeps one manager', async () => {
    const vault = await createShared(ALICE, 'Last manager');
    await as(ALICE).send('POST', `/vaults/${vault.id}/members`, { userId: BOB, role: 'viewer' });

    const alice = as(ALICE);
    expect((await alice.send('DELETE', `/vaults/${vault.id}/members/${ALICE}`)).status).toBe(409);
    expect(
      (await alice.send('PATCH', `/vaults/${vault.id}/members/${ALICE}`, { role: 'viewer' })).status,
    ).toBe(409);

    // With a second manager in place, the first may step down.
    await alice.send('PATCH', `/vaults/${vault.id}/members/${BOB}`, { role: 'manager' });
    expect((await alice.send('DELETE', `/vaults/${vault.id}/members/${ALICE}`)).status).toBe(204);
    expect((await as(ALICE).get(`/vaults/${vault.id}`)).status).toBe(404);
  });

  it('lets a member leave on their own', async () => {
    const vault = await createShared(ALICE, 'Leaving');
    await as(ALICE).send('POST', `/vaults/${vault.id}/members`, { userId: BOB, role: 'viewer' });
    expect((await as(BOB).send('DELETE', `/vaults/${vault.id}/members/${BOB}`)).status).toBe(204);
    expect((await as(BOB).get(`/vaults/${vault.id}`)).status).toBe(404);
  });
});

describe('password manager · workspace admin (passwords:manage)', () => {
  it('sees a shared vault and its members, but not its items', async () => {
    const vault = await createShared(ALICE, 'Finance');
    const item = await addItem(ALICE, vault.id, login('Bank', 'finance-secret-9'));

    const listed = await data<VaultBody[]>(await admin().get('/vaults'));
    expect(listed.find((entry) => entry.id === vault.id)?.role).toBeNull();
    expect((await admin().get(`/vaults/${vault.id}/members`)).status).toBe(200);

    expect((await admin().get(`/vaults/${vault.id}/items/${item.id}/reveal`)).status).toBe(403);
    expect((await admin().get(`/items?vaultId=${vault.id}`)).status).toBe(404);
    const everything = await (await admin().get('/items')).text();
    expect(everything).not.toContain(item.id);
  });

  it('can join to recover a vault, and that is recorded', async () => {
    const vault = await createShared(ALICE, 'Recovery');
    const item = await addItem(ALICE, vault.id, login('Recover', 'recover-secret-9'));

    const join = await admin().send('POST', `/vaults/${vault.id}/members`, {
      userId: ADMIN,
      role: 'manager',
    });
    expect(join.status).toBe(201);
    expect((await admin().get(`/vaults/${vault.id}/items/${item.id}/reveal`)).status).toBe(200);

    const activity = await admin().get(`/vaults/${vault.id}/activity`);
    const body = (await activity.json()) as {
      data: Array<{ action: string; actorId: string; targetLabel: string | null }>;
    };
    expect(
      body.data.some(
        (event) =>
          event.action === 'member.added' &&
          event.actorId === ADMIN &&
          event.targetLabel === ADMIN,
      ),
    ).toBe(true);
  });
});

describe('password manager · sharing by moving', () => {
  it('moves a personal item into a shared vault', async () => {
    const personal = await personalVaultOf(ALICE);
    const shared = await createShared(ALICE, 'Moved into');
    await as(ALICE).send('POST', `/vaults/${shared.id}/members`, { userId: BOB, role: 'viewer' });
    const item = await addItem(ALICE, personal.id, login('Was private', 'now-shared-pw'));

    const res = await as(ALICE).send('POST', `/vaults/${personal.id}/items/${item.id}/move`, {
      targetVaultId: shared.id,
    });
    expect(res.status).toBe(200);
    const moved = await data<ItemBody>(res);
    expect(moved.vaultId).toBe(shared.id);
    expect(moved.id).not.toBe(item.id);

    // Gone from the source, readable by the target's members.
    expect((await as(ALICE).get(`/vaults/${personal.id}/items/${item.id}/reveal`)).status).toBe(404);
    const reveal = await as(BOB).get(`/vaults/${shared.id}/items/${moved.id}/reveal`);
    expect((await data<{ fields: { password: string } }>(reveal)).fields.password).toBe(
      'now-shared-pw',
    );
  });

  it('will not move into a vault the caller cannot edit', async () => {
    const personal = await personalVaultOf(BOB);
    const shared = await createShared(ALICE, 'Read-only target');
    await as(ALICE).send('POST', `/vaults/${shared.id}/members`, { userId: BOB, role: 'viewer' });
    const item = await addItem(BOB, personal.id, login('Stays put', 'stays-put-pw'));

    const viewerTarget = await as(BOB).send('POST', `/vaults/${personal.id}/items/${item.id}/move`, {
      targetVaultId: shared.id,
    });
    expect(viewerTarget.status).toBe(403);

    const strangerTarget = await as(BOB).send(
      'POST',
      `/vaults/${personal.id}/items/${item.id}/move`,
      { targetVaultId: (await personalVaultOf(ALICE)).id },
    );
    expect(strangerTarget.status).toBe(404);
  });
});

describe('password manager · editing and history', () => {
  it('versions a change, skips an identical save, and restores', async () => {
    const vault = await personalVaultOf(CAROL);
    const item = await addItem(CAROL, vault.id, login('History', 'first-password'));
    const carol = as(CAROL);
    const path = `/vaults/${vault.id}/items/${item.id}`;

    const same = await data<ItemBody>(await carol.send('PUT', path, login('History', 'first-password')));
    expect(same.version).toBe(1);

    const changed = await data<ItemBody>(
      await carol.send('PUT', path, login('History', 'second-password')),
    );
    expect(changed.version).toBe(2);

    const versions = await data<Array<{ version: number; action: string }>>(
      await carol.get(`${path}/versions`),
    );
    expect(versions.map((entry) => entry.version)).toEqual([2, 1]);

    const restored = await carol.send('POST', `${path}/restore`, { version: 1 });
    expect((await data<ItemBody>(restored)).version).toBe(3);
    const reveal = await data<{ fields: { password: string } }>(await carol.get(`${path}/reveal`));
    expect(reveal.fields.password).toBe('first-password');
  });

  it('will not let an item change type', async () => {
    const vault = await personalVaultOf(CAROL);
    const item = await addItem(CAROL, vault.id, login('Typed', 'typed-password'));
    const res = await as(CAROL).send('PUT', `/vaults/${vault.id}/items/${item.id}`, {
      type: 'note',
      title: 'Typed',
      fields: { content: 'now a note' },
    });
    expect(res.status).toBe(400);
  });

  it('stores notes and cards, showing only the last four digits', async () => {
    const vault = await personalVaultOf(CAROL);
    const card = await addItem(CAROL, vault.id, {
      type: 'card',
      title: 'Company Visa',
      fields: { cardholder: 'Carol', number: '4111 1111 1111 4242', expiry: '08/29', cvc: '123' },
    });
    expect(card.subtitle).toBe('•••• 4242');

    const listing = await (await as(CAROL).get('/items')).text();
    expect(listing).not.toContain('4111');
  });
});

describe('password manager · two-factor codes', () => {
  it('generates a code without revealing the seed', async () => {
    const vault = await personalVaultOf(CAROL);
    const item = await addItem(
      CAROL,
      vault.id,
      login('With 2FA', 'totp-password', { totp: 'JBSWY3DPEHPK3PXP' }),
    );
    expect(item.hasTotp).toBe(true);

    const res = await as(CAROL).send('POST', `/vaults/${vault.id}/items/${item.id}/totp`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/"code":"\d{6}"/);
    expect(body).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('rejects a seed that is not base32', async () => {
    const vault = await personalVaultOf(CAROL);
    const res = await as(CAROL).send(
      'POST',
      `/vaults/${vault.id}/items`,
      login('Bad 2FA', 'pw', { totp: 'not base32 !!!' }),
    );
    expect(res.status).toBe(400);
  });
});

describe('password manager · matching a page', () => {
  it('finds logins for the same site and its subdomains only', async () => {
    const vault = await createShared(CAROL, 'Matching');
    await addItem(CAROL, vault.id, {
      ...login('Acme root', 'acme-root-password'),
      url: 'https://acme-match.test/login',
    });
    await addItem(CAROL, vault.id, {
      ...login('Acme app', 'acme-app-password'),
      url: 'app.acme-match.test',
    });
    await addItem(CAROL, vault.id, {
      ...login('Unrelated', 'unrelated-password'),
      url: 'https://notacme-match.test',
    });

    const titles = async (url: string) =>
      (
        await data<ItemBody[]>(
          await as(CAROL).get(`/items/match?url=${encodeURIComponent(url)}`),
        )
      ).map((entry) => entry.title);

    expect(await titles('https://www.acme-match.test/signin')).toEqual(['Acme app', 'Acme root']);
    expect(await titles('https://app.acme-match.test')).toEqual(['Acme app', 'Acme root']);
    expect(await titles('https://notacme-match.test')).toEqual(['Unrelated']);
    expect(await titles('not a url')).toEqual([]);
  });

  it('never matches into a vault the caller is not in', async () => {
    const titles = await data<ItemBody[]>(
      await as(BOB).get(`/items/match?url=${encodeURIComponent('https://acme-match.test')}`),
    );
    expect(titles).toEqual([]);
  });
});

describe('password manager · import and health', () => {
  it('imports a CSV export', async () => {
    const vault = await createShared(CAROL, 'Imported');
    const content = [
      'name,url,username,password,note',
      'GitHub,https://github.com/login,carol,gh-imported-password,',
      '"Multi, line",https://example.org,carol,"quoted ""pw""","line one\nline two"',
    ].join('\n');

    const res = await as(CAROL).send('POST', `/vaults/${vault.id}/items/import`, { content });
    expect(res.status).toBe(200);
    expect(await data<{ created: number; format: string }>(res)).toMatchObject({
      created: 2,
      format: 'chrome',
    });

    const items = await data<ItemBody[]>(await as(CAROL).get(`/items?vaultId=${vault.id}`));
    const quoted = items.find((entry) => entry.title === 'Multi, line');
    expect(quoted).toBeDefined();
    const revealed = await data<{ fields: { password: string; notes: string } }>(
      await as(CAROL).get(`/vaults/${vault.id}/items/${quoted?.id}/reveal`),
    );
    expect(revealed.fields.password).toBe('quoted "pw"');
    expect(revealed.fields.notes).toBe('line one\nline two');
  });

  it('reports weak and reused passwords without returning them', async () => {
    // A fresh user, so the report is only about these three logins.
    const DAVE = 'user_dave';
    const vault = await personalVaultOf(DAVE);
    await addItem(DAVE, vault.id, login('Weak one', 'password'));
    await addItem(DAVE, vault.id, login('Reused A', 'Tr0ub4dor&3-horse-staple!'));
    await addItem(DAVE, vault.id, login('Reused B', 'Tr0ub4dor&3-horse-staple!'));
    await addItem(DAVE, vault.id, login('Fine', 'x9$Kq2!vLm8@Zr4#Tn6&'));

    const res = await as(DAVE).get('/password-health');
    const text = await res.text();
    expect(text).not.toContain('Tr0ub4dor');

    const report = JSON.parse(text).data as {
      checked: number;
      healthy: number;
      weak: number;
      reused: number;
      items: Array<{ title: string; issues: string[]; reuseCount: number }>;
    };
    expect(report).toMatchObject({ checked: 4, healthy: 1, weak: 1, reused: 2 });
    expect(report.items.find((entry) => entry.title === 'Weak one')?.issues).toEqual(['weak']);
    expect(report.items.find((entry) => entry.title === 'Reused A')).toMatchObject({
      issues: ['reused'],
      reuseCount: 2,
    });
  });
});
