/**
 * DB-backed tests for the WeldPass password manager beyond the rules in
 * `passwords.test.ts`: vault administration, membership edge cases, the
 * vault trail and its paging, item history, 2FA refusals, CSV import errors,
 * stale passwords in the health report, and request validation.
 *
 * These also drive the Rust backend in conformance mode (rust/modules/pass).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { weldpassRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const ROOT_KEY = 'f'.repeat(64);
const BASE = '/api/weldpass';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const OWEN = 'user_owen';
const PIA = 'user_pia';
const QUIN = 'user_quin';
const BOSS = 'user_boss';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_owen', userId: OWEN, name: 'Owen', email: 'owen@example.com', picture: 'https://img.test/o.png' },
    { id: 'wm_pia', userId: PIA, name: 'Pia', email: 'pia@example.com' },
    { id: 'wm_quin', userId: QUIN, name: 'Quin', email: 'quin@example.com', status: 'SUSPENDED' },
    { id: 'wm_boss', userId: BOSS, name: 'Boss', email: 'boss@example.com' },
    { id: 'wm_guest', userId: 'user_guest', name: 'Guest', email: 'guest@example.com', memberType: 'EXTERNAL' },
  ]);
}, 60_000);

function as(
  userId: string,
  grants: string[] = ['passwords:use', 'passwords:create'],
  env: Record<string, string | undefined> = { WELDPASS_ROOT_KEY: ROOT_KEY },
) {
  const { request } = createTestApp(BASE, weldpassRoutes, {
    context: { userId, permissions: permissions(...grants), tenantDb: db, clerkOrgId: 'org_vaults', orgId: 'org_vaults' },
    env,
  });
  return {
    get: (path: string, headers?: Record<string, string>) => request(`${BASE}${path}`, { headers }),
    send: (method: string, path: string, body?: unknown) =>
      request(`${BASE}${path}`, {
        method,
        headers: JSON_HEADERS,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

const boss = () => as(BOSS, ['passwords:use', 'passwords:create', 'passwords:manage']);

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

interface Vault {
  id: string;
  kind: string;
  name: string;
  role: string | null;
}

interface Item {
  id: string;
  title: string;
  version: number;
  type: string;
  subtitle: string | null;
}

async function shared(userId: string, name: string, description?: string | null): Promise<Vault> {
  const res = await as(userId).send('POST', '/vaults', { name, description });
  expect(res.status).toBe(201);
  return data<Vault>(res);
}

async function personal(userId: string): Promise<Vault> {
  const vaults = await data<Vault[]>(await as(userId).get('/vaults'));
  const vault = vaults.find((v) => v.kind === 'personal');
  if (!vault) throw new Error('no personal vault');
  return vault;
}

function login(title: string, password: string, fields: Record<string, unknown> = {}, url: string | null = 'https://vaults.test') {
  return { type: 'login', title, url, fields: { username: 'owen', password, ...fields } };
}

async function item(userId: string, vaultId: string, body: unknown): Promise<Item> {
  const res = await as(userId).send('POST', `/vaults/${vaultId}/items`, body);
  expect(res.status).toBe(201);
  return data<Item>(res);
}

describe('vault administration', () => {
  it('trims the name, renames, clears the description and deletes a shared vault', async () => {
    const vault = await shared(OWEN, '  Ops  ', '  runbooks  ');
    expect(vault).toMatchObject({ name: 'Ops', role: 'manager', itemCount: 0, memberCount: 1 });
    const read = await data<Vault & { description: string }>(await as(OWEN).get(`/vaults/${vault.id}`));
    expect(read).toMatchObject({ name: 'Ops', description: 'runbooks', role: 'manager' });

    const renamed = await as(OWEN).send('PATCH', `/vaults/${vault.id}`, { name: ' Operations ', description: null });
    expect(renamed.status).toBe(200);
    expect(await data<Record<string, unknown>>(renamed)).toMatchObject({ name: 'Operations', description: null, role: 'manager' });
    expect((await as(OWEN).send('PATCH', `/vaults/${vault.id}`, { name: '   ' })).status).toBe(400);

    const kept = await item(OWEN, vault.id, login('Router', 'router-pass-1'));
    expect((await as(OWEN).send('DELETE', `/vaults/${vault.id}`)).status).toBe(204);
    expect((await as(OWEN).get(`/vaults/${vault.id}`)).status).toBe(404);
    const [row] = await db.select().from(schema.weldpassItems).where(eq(schema.weldpassItems.id, kept.id));
    expect(row.deletedAt).not.toBeNull();
  });

  it('lets a workspace admin administer a shared vault without joining it', async () => {
    const vault = await shared(OWEN, 'Admin managed');
    const read = await data<Vault>(await boss().get(`/vaults/${vault.id}`));
    expect(read.role).toBeNull();
    const renamed = await boss().send('PATCH', `/vaults/${vault.id}`, { name: 'Renamed by admin' });
    expect(await data<Vault>(renamed)).toMatchObject({ name: 'Renamed by admin', role: null });
    const activity = await boss().get(`/vaults/${vault.id}/activity`);
    expect(activity.status).toBe(200);
    expect((await boss().send('POST', `/vaults/${vault.id}/items`, login('x', 'y'))).status).toBe(403);
    expect((await boss().send('DELETE', `/vaults/${vault.id}`)).status).toBe(204);
  });

  it('refuses to rename or delete as a viewer, and a personal vault always', async () => {
    const vault = await shared(OWEN, 'Viewer refusals');
    await as(OWEN).send('POST', `/vaults/${vault.id}/members`, { userId: PIA, role: 'viewer' });
    const rename = await as(PIA).send('PATCH', `/vaults/${vault.id}`, { name: 'Nope' });
    expect(rename.status).toBe(403);
    expect(await rename.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'This needs the manager role on the vault.' },
    });
    const mine = await personal(OWEN);
    const personalRename = await as(OWEN).send('PATCH', `/vaults/${mine.id}`, { name: 'Mine' });
    expect(await personalRename.json()).toEqual({
      error: { code: 'FORBIDDEN', message: 'A personal vault cannot be shared, renamed or deleted.' },
    });
    const leave = await as(OWEN).send('DELETE', `/vaults/${mine.id}/members/${OWEN}`);
    expect(leave.status).toBe(403);
    expect(await data<unknown[]>(await as(OWEN).get(`/vaults/${mine.id}/members`))).toEqual([]);
  });

  it('answers CRYPTO_ERROR when a vault key cannot be made or opened', async () => {
    const keyless = as('user_keyless', ['passwords:use', 'passwords:create'], {});
    const first = await keyless.get('/vaults');
    expect(first.status).toBe(500);
    expect(((await first.json()) as { error: { code: string } }).error.code).toBe('CRYPTO_ERROR');
    expect((await keyless.send('POST', '/vaults', { name: 'No key' })).status).toBe(500);

    const vault = await shared(OWEN, 'Locked later');
    const ownerWithoutKey = as(OWEN, ['passwords:use'], {});
    expect((await ownerWithoutKey.send('POST', `/vaults/${vault.id}/items`, login('x', 'y'))).status).toBe(500);
    expect((await ownerWithoutKey.get(`/vaults/${vault.id}`)).status).toBe(200);
  });
});

describe('vault members', () => {
  it('lists teammates who can be added: active and internal only', async () => {
    const res = await as(OWEN).get('/teammates');
    expect(res.status).toBe(200);
    const teammates = await data<Array<{ userId: string }>>(res);
    expect(teammates.map((t) => t.userId)).toEqual([BOSS, OWEN, PIA]);
    expect((await as(OWEN, ['secrets:read']).get('/teammates')).status).toBe(403);
  });

  it('changes a role by adding again, and refuses people outside the workspace', async () => {
    const vault = await shared(OWEN, 'Roles');
    expect((await as(OWEN).send('POST', `/vaults/${vault.id}/members`, { userId: PIA, role: 'viewer' })).status).toBe(201);
    const again = await as(OWEN).send('POST', `/vaults/${vault.id}/members`, { userId: PIA, role: 'editor' });
    expect(again.status).toBe(200);
    const members = await data<Array<{ userId: string; role: string; name: string | null }>>(again);
    expect(members.map((m) => `${m.name}:${m.role}`)).toEqual(['Owen:manager', 'Pia:editor']);

    expect((await as(OWEN).send('POST', `/vaults/${vault.id}/members`, { userId: QUIN, role: 'viewer' })).status).toBe(404);
    expect((await as(OWEN).send('POST', `/vaults/${vault.id}/members`, { userId: 'user_guest', role: 'viewer' })).status).toBe(404);
    expect((await as(OWEN).send('POST', `/vaults/${vault.id}/members`, { userId: '', role: 'owner' })).status).toBe(400);

    const missing = await as(OWEN).send('PATCH', `/vaults/${vault.id}/members/${BOSS}`, { role: 'viewer' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: 'NOT_FOUND', message: `vault member with ID '${BOSS}' not found` },
    });
    expect((await as(OWEN).send('PATCH', `/vaults/${vault.id}/members/${PIA}`, { role: 'admin' })).status).toBe(400);

    expect((await as(PIA).send('DELETE', `/vaults/${vault.id}/members/${OWEN}`)).status).toBe(403);
    expect((await as(OWEN).send('DELETE', `/vaults/${vault.id}/members/${BOSS}`)).status).toBe(404);

    const events = await db
      .select()
      .from(schema.weldpassVaultEvents)
      .where(and(eq(schema.weldpassVaultEvents.vaultId, vault.id), eq(schema.weldpassVaultEvents.action, 'member.role_changed')));
    expect(events.map((e) => e.metadata)).toEqual([{ role: 'editor' }]);
  });

  it('pages the trail newest first with a cursor', async () => {
    const vault = await shared(OWEN, 'Trail');
    const at = (minute: number) => new Date(Date.UTC(2026, 2, 1, 9, minute, 0));
    await db.insert(schema.weldpassVaultEvents).values(
      [1, 2, 3].map((minute) => ({
        id: `wpx_s${minute}_${vault.id.slice(-10)}`,
        vaultId: vault.id,
        actorId: PIA,
        action: 'item.revealed',
        targetLabel: `Seed ${minute}`,
        metadata: { client: 'web' },
        createdAt: at(minute),
      })),
    );
    const first = (await (await as(OWEN).get(`/vaults/${vault.id}/activity?limit=2`)).json()) as {
      data: Array<{ targetLabel: string | null; actorName: string | null }>;
      pagination: { hasMore: boolean; cursor: string | null };
    };
    expect(first.pagination.hasMore).toBe(true);
    const labels = first.data.map((e) => e.targetLabel);
    let cursor = first.pagination.cursor;
    while (cursor) {
      const next = (await (
        await as(OWEN).get(`/vaults/${vault.id}/activity?limit=2&cursor=${encodeURIComponent(cursor)}`)
      ).json()) as typeof first;
      labels.push(...next.data.map((e) => e.targetLabel));
      cursor = next.pagination.cursor;
    }
    expect(labels).toEqual(['Trail', 'Seed 3', 'Seed 2', 'Seed 1']);
    expect(first.data[1].actorName).toBe('Pia');
    const capped = (await (await as(OWEN).get(`/vaults/${vault.id}/activity?limit=999&cursor=`)).json()) as typeof first;
    expect(capped.data).toHaveLength(4);
  });
});

describe('items', () => {
  it('filters the list by type and ignores an unknown type', async () => {
    const vault = await shared(PIA, 'Typed items');
    await item(PIA, vault.id, login('A login', 'pw-123456789'));
    await item(PIA, vault.id, { type: 'note', title: 'A note', fields: { content: 'body' } });
    const notes = await data<Item[]>(await as(PIA).get(`/items?vaultId=${vault.id}&type=note`));
    expect(notes.map((i) => i.title)).toEqual(['A note']);
    const all = await data<Item[]>(await as(PIA).get(`/items?vaultId=${vault.id}&type=wallet`));
    expect(all.map((i) => i.title)).toEqual(['A login', 'A note']);
  });

  it('keeps an identical save and an identical restore out of the history', async () => {
    const vault = await personal(PIA);
    const created = await item(PIA, vault.id, login('Same', 'same-password-1', { totp: ' JBSWY3DPEHPK3PXP ' }));
    const path = `/vaults/${vault.id}/items/${created.id}`;
    const same = await as(PIA).send('PUT', path, login('Same', 'same-password-1', { totp: 'JBSWY3DPEHPK3PXP' }));
    expect((await data<Item>(same)).version).toBe(1);
    const renamed = await as(PIA).send('PUT', path, login('Same', 'same-password-1', { totp: 'JBSWY3DPEHPK3PXP' }, null));
    expect((await data<Item>(renamed)).version).toBe(2);
    const restored = await as(PIA).send('POST', `${path}/restore`, { version: 2 });
    expect((await data<Item>(restored)).version).toBe(2);
    const missing = await as(PIA).send('POST', `${path}/restore`, { version: 9 });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { message: string } }).error.message).toBe(
      `item with ID '${created.id}@v9' not found`,
    );
    expect((await as(PIA).send('POST', `${path}/restore`, { version: '1' })).status).toBe(400);
    const events = await db
      .select()
      .from(schema.weldpassVaultEvents)
      .where(and(eq(schema.weldpassVaultEvents.itemId, created.id), eq(schema.weldpassVaultEvents.action, 'item.restored')));
    expect(events.map((e) => e.metadata)).toEqual([{ restoredFrom: 2, changed: false }]);
  });

  it('deletes an item into its history', async () => {
    const vault = await shared(PIA, 'Deletion');
    const created = await item(PIA, vault.id, { type: 'card', title: 'Old card', fields: { number: '12' } });
    expect(created.subtitle).toBeNull();
    const path = `/vaults/${vault.id}/items/${created.id}`;
    expect((await as(PIA).send('DELETE', path)).status).toBe(204);
    expect((await as(PIA).get(`${path}/reveal`)).status).toBe(404);
    expect((await as(PIA).get(`${path}/versions`)).status).toBe(404);
    expect((await as(PIA).send('DELETE', path)).status).toBe(404);
    const versions = await db
      .select()
      .from(schema.weldpassItemVersions)
      .where(eq(schema.weldpassItemVersions.itemId, created.id));
    expect(versions.map((v) => v.action).sort()).toEqual(['created', 'deleted']);
  });

  it('records the client of a reveal', async () => {
    const vault = await personal(OWEN);
    const created = await item(OWEN, vault.id, login('Extension fill', 'ext-password-1'));
    const res = await as(OWEN).get(`/vaults/${vault.id}/items/${created.id}/reveal`, {
      'X-WeldPass-Client': 'extension/chrome-1.2.3-and-a-very-long-suffix-that-gets-cut',
    });
    expect(res.status).toBe(200);
    const events = await db
      .select()
      .from(schema.weldpassVaultEvents)
      .where(and(eq(schema.weldpassVaultEvents.itemId, created.id), eq(schema.weldpassVaultEvents.action, 'item.revealed')));
    expect(events.map((e) => e.metadata)).toContainEqual({ client: 'extension/chrome-1.2.3-and-a-very-long-s' });
  });

  it('refuses a 2FA code for items without a seed, and mints 8 digits from a URI', async () => {
    const vault = await personal(OWEN);
    const note = await item(OWEN, vault.id, { type: 'note', title: 'No seed', fields: { content: 'x' } });
    const noteCode = await as(OWEN).send('POST', `/vaults/${vault.id}/items/${note.id}/totp`);
    expect(noteCode.status).toBe(400);
    expect(await noteCode.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'This item has no two-factor secret.' } });
    const plain = await item(OWEN, vault.id, login('No 2FA', 'plain-password-1'));
    expect((await as(OWEN).send('POST', `/vaults/${vault.id}/items/${plain.id}/totp`)).status).toBe(400);

    const uri = 'otpauth://totp/Acme:owen?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=60';
    const eight = await item(OWEN, vault.id, login('Eight digits', 'eight-password-1', { totp: uri }));
    const code = await data<{ code: string; period: number }>(
      await as(OWEN).send('POST', `/vaults/${vault.id}/items/${eight.id}/totp`),
    );
    expect(code.code).toMatch(/^\d{8}$/);
    expect(code.period).toBe(60);
    const badUri = await as(OWEN).send('POST', `/vaults/${vault.id}/items`, login('Bad', 'x', { totp: 'otpauth://hotp/x?secret=JBSW' }));
    expect(await badUri.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Only time-based (TOTP) two-factor codes are supported.' },
    });
  });

  it('validates an item like Zod', async () => {
    const vault = await personal(OWEN);
    for (const body of [
      { type: 'wallet', title: 'w', fields: {} },
      { title: 'missing type' },
      { type: 'login', title: '   ', fields: { username: 5, totp: null } },
      { type: 'card', title: 'c', fields: { number: '  4242  ', expiry: '12345678901', notes: 3 } },
      { type: 'login', title: 'x', fields: null },
      [],
    ]) {
      const res = await as(OWEN).send('POST', `/vaults/${vault.id}/items`, body);
      expect(res.status).toBe(400);
    }
    expect((await as(OWEN).send('POST', `/vaults/${vault.id}/items/wpi_x/move`, { targetVaultId: '' })).status).toBe(400);
    expect((await as(OWEN).send('POST', `/vaults/${vault.id}/items/wpi_x/move`, { targetVaultId: vault.id })).status).toBe(400);
  });

  it('matches a single-label host exactly', async () => {
    const vault = await personal(QUIN);
    await item(QUIN, vault.id, login('Local dev', 'local-password-1', {}, 'http://localhost:3000/login'));
    const matched = await data<Item[]>(await as(QUIN).get(`/items/match?url=${encodeURIComponent('http://localhost:8080')}`));
    expect(matched.map((i) => i.title)).toEqual(['Local dev']);
  });
});

describe('import', () => {
  it('refuses an empty file, a file without a password column and one with nothing to import', async () => {
    const vault = await shared(OWEN, 'Import errors');
    const post = (content: string, format?: string) =>
      as(OWEN).send('POST', `/vaults/${vault.id}/items/import`, { content, format });
    const empty = await post('');
    expect(await empty.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'That file is empty.' } });
    const noPassword = await post('name,url,username\nX,https://x.test,u');
    expect(((await noPassword.json()) as { error: { message: string } }).error.message).toBe(
      'No password or notes column found. Export a CSV from your password manager and try again.',
    );
    const nothing = await post('name,type,login_uri,login_username,login_password,notes\nCard,card,,,,\nId,identity,,,,');
    expect(nothing.status).toBe(400);
    expect(await nothing.json()).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Nothing to import was found in that file.',
        details: {
          skipped: [
            { line: 2, reason: 'This kind of item is not supported.' },
            { line: 3, reason: 'This kind of item is not supported.' },
          ],
        },
      },
    });
    expect((await post('x', 'keepass')).status).toBe(400);
    expect((await as(PIA).send('POST', `/vaults/${vault.id}/items/import`, { content: 'x' })).status).toBe(404);
  });

  it('imports Bitwarden notes and logins with warnings and skipped rows', async () => {
    const vault = await shared(OWEN, 'Bitwarden');
    const content = [
      'name,type,login_uri,login_username,login_password,login_totp,notes',
      'BW,login,https://bw.test,bob,pw-bw-1,JBSWY3DPEHPK3PXP,',
      'Note,note,,,,,"secure\nnote"',
      `${'T'.repeat(201)},login,https://t.test,u,p,,`,
      'Bad2fa,login,https://x.test,x,y,not base32 !!!,',
    ].join('\n');
    const res = await as(OWEN).send('POST', `/vaults/${vault.id}/items/import`, { content, format: 'bitwarden' });
    expect(res.status).toBe(200);
    expect(await data<unknown>(res)).toEqual({
      format: 'bitwarden',
      created: 3,
      skipped: [{ line: 5, reason: 'title: String must contain at most 200 character(s)' }],
      warnings: [{ line: 6, reason: 'The two-factor secret could not be read and was left out.' }],
    });
    const items = await data<Item[]>(await as(OWEN).get(`/items?vaultId=${vault.id}`));
    expect(items.map((i) => `${i.type}:${i.title}`).sort()).toEqual(['login:BW', 'login:Bad2fa', 'note:Note']);
  });
});

describe('password health', () => {
  it('flags passwords nobody changed in a year, worst first', async () => {
    const vault = await personal('user_ivy');
    const stale = await item('user_ivy', vault.id, login('Stale strong', 'x9$Kq2!vLm8@Zr4#Tn6&-old'));
    const both = await item('user_ivy', vault.id, login('Stale weak', 'password'));
    await item('user_ivy', vault.id, login('Fresh', 'x9$Kq2!vLm8@Zr4#Tn6&-new'));
    await item('user_ivy', vault.id, { type: 'note', title: 'Ignored note', fields: { content: 'password' } });
    await item('user_ivy', vault.id, login('Empty', ''));
    const old = new Date(Date.UTC(2020, 0, 1));
    for (const id of [stale.id, both.id]) {
      await db.update(schema.weldpassItems).set({ passwordChangedAt: old }).where(eq(schema.weldpassItems.id, id));
    }
    const report = await data<{
      checked: number;
      healthy: number;
      weak: number;
      reused: number;
      old: number;
      items: Array<{ title: string; issues: string[]; reuseCount: number }>;
    }>(await as('user_ivy').get('/password-health'));
    expect(report).toMatchObject({ checked: 3, healthy: 1, weak: 1, reused: 0, old: 2 });
    expect(report.items.map((i) => `${i.title}:${i.issues.join('+')}`)).toEqual(['Stale weak:weak+old', 'Stale strong:old']);
  });
});
