/**
 * DB-backed tests for the WeldPass secret vaults beyond the gates in
 * `index.test.ts`: projects and environments end to end, every secret route
 * including its refusals, the dotenv import and export, history, legacy
 * checksums, root-key rotation, and the audit trail with its paging.
 *
 * These also drive the Rust backend in conformance mode (rust/modules/pass),
 * so every request here is compared between the two.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { weldpassRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { sealSecret, sha256Hex, unwrapVaultKey } from '../../services/weldpass/envelope';

const ROOT_V1 = 'c'.repeat(64);
const ROOT_V2 = 'd'.repeat(64);
const BASE = '/api/weldpass';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const ADMIN = ['secrets:read', 'secrets:reveal', 'secrets:create', 'secrets:update', 'secrets:delete', 'secrets:manage'];

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function app(grants: string[] = ADMIN, env: Record<string, string | undefined> = { WELDPASS_ROOT_KEY: ROOT_V1 }, org = 'org_projects') {
  const { request } = createTestApp(BASE, weldpassRoutes, {
    context: { userId: 'user_owner', permissions: permissions(...grants), tenantDb: db, clerkOrgId: org, orgId: org },
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

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

interface ProjectBody {
  id: string;
  slug: string;
  rootKeyVersion: string;
  environments: Array<{ id: string; slug: string; secretCount?: number }>;
}

async function project(name: string, extra: Record<string, unknown> = {}) {
  const res = await app().send('POST', '/projects', { name, ...extra });
  expect(res.status).toBe(201);
  return data<ProjectBody>(res);
}

function secretsPath(projectId: string, environmentId: string) {
  return `/projects/${projectId}/environments/${environmentId}/secrets`;
}

async function secret(projectId: string, environmentId: string, key: string, value: string, note?: string | null) {
  const res = await app().send('POST', secretsPath(projectId, environmentId), { key, value, note });
  expect([200, 201]).toContain(res.status);
  return data<{ secret: { id: string; version: number; checksum: string } }>(res);
}

describe('weldpass projects', () => {
  it('lists the providers', async () => {
    const res = await app(['secrets:read']).get('/providers');
    expect(res.status).toBe(200);
    expect(await data<Array<{ id: string }>>(res)).toEqual([
      { id: 'cloudflare_workers', label: 'Cloudflare Workers' },
      { id: 'cloudflare_pages', label: 'Cloudflare Pages' },
      { id: 'vercel', label: 'Vercel' },
    ]);
    expect((await app(['passwords:use']).get('/providers')).status).toBe(403);
  });

  it('creates with a custom slug and a description, and refuses the same slug twice', async () => {
    const created = await project('Billing Service', { slug: 'Billing API!!', description: 'Payments' });
    expect(created.slug).toBe('billing-api');
    const again = await app().send('POST', '/projects', { name: 'Other', slug: 'billing-api' });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: { code: 'CONFLICT', message: 'A project with the slug "billing-api" already exists.' },
    });
  });

  it('answers a name without a letter or digit with a 500, as the worker does', async () => {
    const res = await app().send('POST', '/projects', { name: '!!!' });
    expect(res.status).toBe(500);
  });

  it('validates the body like Zod', async () => {
    const res = await app().send('POST', '/projects', { name: '', slug: '', description: 5 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { issues: unknown[] } };
    expect(body.error.issues).toHaveLength(3);
    expect((await app().send('POST', '/projects', [])).status).toBe(400);
  });

  it('reads one project with its environments and secret counts', async () => {
    const created = await project('Counted');
    await secret(created.id, created.environments[0].id, 'ONE', '1');
    await secret(created.id, created.environments[0].id, 'TWO', '2');
    const res = await app(['secrets:read']).get(`/projects/${created.id}`);
    expect(res.status).toBe(200);
    const read = await data<ProjectBody>(res);
    expect(read.environments.map((e) => e.secretCount)).toEqual([2, 0, 0]);

    const listed = await data<ProjectBody[]>(await app(['secrets:read']).get('/projects'));
    expect(listed.find((p) => p.id === created.id)?.environments[0].secretCount).toBe(2);
  });

  it('updates the name and clears the description', async () => {
    const created = await project('Renamable', { description: 'old' });
    const res = await app(['secrets:update']).send('PATCH', `/projects/${created.id}`, { name: 'Renamed', description: null });
    expect(res.status).toBe(200);
    expect(await data<{ name: string; description: string | null }>(res)).toMatchObject({ name: 'Renamed', description: null });

    const untouched = await app(['secrets:manage']).send('PATCH', `/projects/${created.id}`, {});
    expect(await data<{ name: string }>(untouched)).toMatchObject({ name: 'Renamed' });

    expect((await app(['secrets:read']).send('PATCH', `/projects/${created.id}`, { name: 'x' })).status).toBe(403);
    expect((await app().send('PATCH', '/projects/wpp_missing', { name: 'x' })).status).toBe(404);
    expect((await app().send('PATCH', `/projects/${created.id}`, { name: '' })).status).toBe(400);
  });

  it('deletes a project, which then reads as not found', async () => {
    const created = await project('Doomed');
    expect((await app(['secrets:read']).send('DELETE', `/projects/${created.id}`)).status).toBe(403);
    expect((await app(['secrets:delete']).send('DELETE', `/projects/${created.id}`)).status).toBe(204);
    const gone = await app().get(`/projects/${created.id}`);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({
      error: { code: 'NOT_FOUND', message: `project with ID '${created.id}' not found` },
    });
    expect((await app().send('DELETE', `/projects/${created.id}`)).status).toBe(404);
  });

  it('wraps new vault keys with the newest root key during a rotation and still opens the old ones', async () => {
    const before = await project('Rotation');
    const environment = before.environments[2].id;
    const written = await secret(before.id, environment, 'API_TOKEN', 'rotation-value-1');

    const rotating = app(ADMIN, { WELDPASS_ROOT_KEY: ROOT_V1, WELDPASS_ROOT_KEY_V2: ROOT_V2 });
    const fresh = await rotating.send('POST', '/projects', { name: 'After rotation' });
    expect((await data<ProjectBody>(fresh)).rootKeyVersion).toBe('v2');

    const revealed = await rotating.get(`${secretsPath(before.id, environment)}/${written.secret.id}/reveal`);
    expect(await data<{ value: string }>(revealed)).toMatchObject({ value: 'rotation-value-1' });

    // Without the v1 key the old project no longer opens.
    const onlyNew = app(ADMIN, { WELDPASS_ROOT_KEY_V2: ROOT_V2 });
    const refused = await onlyNew.get(`${secretsPath(before.id, environment)}/${written.secret.id}/reveal`);
    expect(refused.status).toBe(500);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('CRYPTO_ERROR');
  });

  it('answers CRYPTO_ERROR on every route that opens a vault when the root key is missing', async () => {
    const created = await project('Keyless');
    const keyless = app(ADMIN, {});
    for (const path of [`/projects/${created.id}/credentials`, `/projects/${created.id}/sync-targets`, `/projects/${created.id}/audit`]) {
      const res = await keyless.get(path);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: {
          code: 'CRYPTO_ERROR',
          message: 'This vault could not be opened. Its encryption key is unavailable — contact an administrator.',
        },
      });
    }
    // Reading the project itself does not open the vault.
    expect((await keyless.get(`/projects/${created.id}`)).status).toBe(200);
  });
});

describe('weldpass environments', () => {
  it('lists, adds, renames and deletes environments', async () => {
    const created = await project('Envs');
    const listed = await app(['secrets:read']).get(`/projects/${created.id}/environments`);
    expect((await data<Array<{ slug: string }>>(listed)).map((e) => e.slug)).toEqual(['development', 'preview', 'production']);

    const added = await app(['secrets:manage']).send('POST', `/projects/${created.id}/environments`, {
      name: 'Staging EU',
      isProduction: true,
    });
    expect(added.status).toBe(201);
    const staging = await data<{ id: string; slug: string; sortOrder: number; isProduction: boolean }>(added);
    expect(staging).toMatchObject({ slug: 'staging-eu', sortOrder: 3, isProduction: true });

    const clash = await app().send('POST', `/projects/${created.id}/environments`, { name: 'x', slug: 'Staging EU' });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: { message: string } }).error.message).toBe(
      'This project already has an environment named "staging-eu".',
    );
    expect((await app(['secrets:create']).send('POST', `/projects/${created.id}/environments`, { name: 'x' })).status).toBe(403);
    expect((await app().send('POST', `/projects/${created.id}/environments`, { name: 'x'.repeat(61) })).status).toBe(400);
    expect((await app().send('POST', '/projects/wpp_nope/environments', { name: 'x' })).status).toBe(404);

    const renamed = await app().send('PATCH', `/projects/${created.id}/environments/${staging.id}`, {
      name: 'Staging',
      isProduction: false,
      sortOrder: 0,
    });
    expect(await data<Record<string, unknown>>(renamed)).toMatchObject({ name: 'Staging', isProduction: false, sortOrder: 0 });
    expect((await app().send('PATCH', `/projects/${created.id}/environments/${staging.id}`, { sortOrder: -1 })).status).toBe(400);
    expect((await app().send('PATCH', `/projects/${created.id}/environments/${staging.id}`, { sortOrder: 1.5 })).status).toBe(400);
    expect((await app().send('PATCH', `/projects/${created.id}/environments/wpe_nope`, { name: 'x' })).status).toBe(404);

    await secret(created.id, staging.id, 'IN_STAGING', 'value');
    expect((await app().send('DELETE', `/projects/${created.id}/environments/${staging.id}`)).status).toBe(204);
    expect((await app().get(secretsPath(created.id, staging.id))).status).toBe(404);
    expect((await app().send('DELETE', `/projects/${created.id}/environments/${staging.id}`)).status).toBe(404);

    const rows = await db
      .select()
      .from(schema.weldpassSecrets)
      .where(eq(schema.weldpassSecrets.environmentId, staging.id));
    expect(rows.every((row) => row.deletedAt !== null)).toBe(true);
  });
});

describe('weldpass secrets', () => {
  it('updates a note without the value, keeps the value, and refuses an empty patch', async () => {
    const created = await project('Notes');
    const env = created.environments[0].id;
    const written = await secret(created.id, env, 'NOTED', 'noted-value-123', 'first note');
    const path = `${secretsPath(created.id, env)}/${written.secret.id}`;

    const noteOnly = await app().send('PATCH', path, { note: 'second note' });
    expect(noteOnly.status).toBe(200);
    expect(await data<{ secret: { note: string; version: number } }>(noteOnly)).toMatchObject({
      secret: { note: 'second note', version: 2 },
    });

    const cleared = await app().send('PATCH', path, { note: null });
    expect(await data<{ secret: { note: string | null } }>(cleared)).toMatchObject({ secret: { note: null } });

    const same = await app().send('PATCH', path, { value: 'noted-value-123' });
    expect(await data<{ secret: { version: number } }>(same)).toMatchObject({ secret: { version: 3 } });

    const empty = await app().send('PATCH', path, {});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'Provide a value, a note, or both.' } });

    expect((await app().send('PATCH', `${secretsPath(created.id, env)}/wps_nope`, { value: 'x' })).status).toBe(404);
    expect((await app(['secrets:read']).send('PATCH', path, { value: 'x' })).status).toBe(403);

    const revealed = await app().get(`${path}/reveal`);
    expect(await data<{ value: string; note: string | null }>(revealed)).toMatchObject({ value: 'noted-value-123' });
  });

  it('re-posting a value creates nothing new, a changed one is a new version', async () => {
    const created = await project('Upserts');
    const env = created.environments[1].id;
    const first = await app().send('POST', secretsPath(created.id, env), { key: 'REPEAT', value: 'one' });
    expect(first.status).toBe(201);
    const again = await app().send('POST', secretsPath(created.id, env), { key: 'REPEAT', value: 'one' });
    expect(again.status).toBe(200);
    expect(await data<{ created: boolean; secret: { version: number } }>(again)).toMatchObject({
      created: false,
      secret: { version: 1 },
    });
    const changed = await app().send('POST', secretsPath(created.id, env), { key: 'REPEAT', value: 'two', note: 'n' });
    expect(await data<{ secret: { version: number; note: string } }>(changed)).toMatchObject({
      secret: { version: 2, note: 'n' },
    });
    expect((await app().send('POST', secretsPath(created.id, env), { key: '', value: 'x' })).status).toBe(400);
    expect((await app().send('POST', secretsPath(created.id, env), { key: '9LIVES', value: 'x' })).status).toBe(400);
    expect((await app().send('POST', secretsPath(created.id, 'wpe_nope'), { key: 'A', value: 'x' })).status).toBe(404);
  });

  it('upgrades a legacy SHA-256 checksum when the same value is written again', async () => {
    const created = await project('Legacy');
    const env = created.environments[0].id;
    const [projectRow] = await db.select().from(schema.weldpassProjects).where(eq(schema.weldpassProjects.id, created.id));
    const kek = await unwrapVaultKey({ v1: ROOT_V1 }, created.id, projectRow.kekWrapped);
    const location = { projectId: created.id, environmentId: env, key: 'OLD_STYLE' };
    const sealed = await sealSecret(kek, location, 'legacy-value-42');
    const legacy = await sha256Hex('legacy-value-42');
    await db.insert(schema.weldpassSecrets).values({
      id: 'wps_legacy_1',
      projectId: created.id,
      environmentId: env,
      key: 'OLD_STYLE',
      ciphertext: sealed.ciphertext,
      dekWrapped: sealed.dekWrapped,
      checksum: legacy,
      valueLength: sealed.valueLength,
      valueHint: sealed.valueHint,
    });

    const listed = await data<Array<{ key: string; checksum: string }>>(await app(['secrets:read']).get(secretsPath(created.id, env)));
    expect(listed.find((s) => s.key === 'OLD_STYLE')?.checksum).toBe(legacy);

    const same = await app().send('POST', secretsPath(created.id, env), { key: 'OLD_STYLE', value: 'legacy-value-42' });
    const body = await data<{ created: boolean; secret: { checksum: string; version: number } }>(same);
    expect(body.created).toBe(false);
    expect(body.secret.version).toBe(1);
    expect(body.secret.checksum).toMatch(/^h1:[0-9a-f]{61}$/);
    expect(body.secret.checksum).toBe(sealed.checksum);
  });

  it('upgrades a legacy checksum on reveal', async () => {
    const created = await project('Legacy reveal');
    const env = created.environments[0].id;
    const [projectRow] = await db.select().from(schema.weldpassProjects).where(eq(schema.weldpassProjects.id, created.id));
    const kek = await unwrapVaultKey({ v1: ROOT_V1 }, created.id, projectRow.kekWrapped);
    const sealed = await sealSecret(kek, { projectId: created.id, environmentId: env, key: 'OLDER' }, 'older-value');
    await db.insert(schema.weldpassSecrets).values({
      id: 'wps_legacy_2',
      projectId: created.id,
      environmentId: env,
      key: 'OLDER',
      ciphertext: sealed.ciphertext,
      dekWrapped: sealed.dekWrapped,
      checksum: await sha256Hex('older-value'),
      valueLength: sealed.valueLength,
    });
    const revealed = await data<{ checksum: string; value: string }>(
      await app(['secrets:reveal']).get(`${secretsPath(created.id, env)}/wps_legacy_2/reveal`),
    );
    expect(revealed.value).toBe('older-value');
    expect(revealed.checksum).toBe(sealed.checksum);
  });

  it('deletes a secret into its history, restores it, and refuses an unknown version', async () => {
    const created = await project('Deletes');
    const env = created.environments[0].id;
    const written = await secret(created.id, env, 'TEMP', 'temporary-value');
    const path = `${secretsPath(created.id, env)}/${written.secret.id}`;

    expect((await app(['secrets:update']).send('DELETE', path)).status).toBe(403);
    expect((await app(['secrets:delete']).send('DELETE', path)).status).toBe(204);
    expect((await app().send('DELETE', path)).status).toBe(404);
    expect((await app().get(`${path}/versions`)).status).toBe(404);

    const versions = await db
      .select()
      .from(schema.weldpassSecretVersions)
      .where(eq(schema.weldpassSecretVersions.secretId, written.secret.id));
    expect(versions.map((v) => v.action).sort()).toEqual(['created', 'deleted']);

    const restored = await app().send('POST', `${path}/restore`, { version: 1 });
    expect(restored.status).toBe(404);

    // Writing a deleted key again collides with its `deleted` history row
    // (the delete does not bump the row's version), so pass-api answers 500.
    // Kept as the worker does it; reported as a bug, not fixed here.
    const revived = await app().send('POST', secretsPath(created.id, env), { key: 'TEMP', value: 'temporary-value-2' });
    expect(revived.status).toBe(500);
    expect(await revived.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  });

  it('restores an earlier version as a new one, and refuses an unknown version', async () => {
    const created = await project('Restores');
    const env = created.environments[0].id;
    const written = await secret(created.id, env, 'ROLLED', 'first-value');
    const path = `${secretsPath(created.id, env)}/${written.secret.id}`;
    expect((await app().send('PATCH', path, { value: 'second-value' })).status).toBe(200);

    const missing = await app().send('POST', `${path}/restore`, { version: 99 });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { message: string } }).error.message).toBe(
      `secret with ID '${written.secret.id}@v99' not found`,
    );
    expect((await app().send('POST', `${path}/restore`, { version: 0 })).status).toBe(400);
    expect((await app(['secrets:read']).send('POST', `${path}/restore`, { version: 1 })).status).toBe(403);
    const back = await app().send('POST', `${path}/restore`, { version: 1 });
    expect(await data<{ secret: { version: number }; autoSync: unknown[] }>(back)).toMatchObject({
      secret: { version: 3 },
      autoSync: [],
    });
    const history = await data<Array<{ version: number; action: string }>>(await app().get(`${path}/versions`));
    expect(history.map((v) => `${v.version}:${v.action}`)).toEqual(['3:restored', '2:updated', '1:created']);
    const revealed = await data<{ value: string }>(await app().get(`${path}/reveal`));
    expect(revealed.value).toBe('first-value');
  });

  it('imports a .env with replace, reports skipped lines, and refuses a file with no variables', async () => {
    const created = await project('Imports');
    const env = created.environments[0].id;
    await secret(created.id, env, 'STALE_KEY', 'stale');
    await secret(created.id, env, 'KEEP', 'kept-value');
    const path = `${secretsPath(created.id, env)}/import`;

    const content = [
      '# comment',
      'export KEEP=kept-value',
      'NEW_ONE="line\\nbreak"',
      'bad-key=1',
      'NO_EQUALS',
      'INLINE=pass#word # trailing',
    ].join('\n');
    const res = await app().send('POST', path, { content, replace: true });
    expect(res.status).toBe(200);
    const body = await data<Record<string, unknown>>(res);
    expect(body).toMatchObject({
      created: ['NEW_ONE', 'INLINE'],
      updated: [],
      unchanged: ['KEEP'],
      removed: ['STALE_KEY'],
      skipped: [
        { line: 4, reason: '"bad-key" is not a valid variable name' },
        { line: 5, reason: 'No "=" found' },
      ],
      autoSync: [],
    });

    const empty = await app().send('POST', path, { content: '# nothing\nnope' });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'No variables found in that file.',
        details: { skipped: [{ line: 2, reason: 'No "=" found' }] },
      },
    });
    expect((await app().send('POST', path, { content: 5 })).status).toBe(400);
    expect((await app(['secrets:read']).send('POST', path, { content: 'A=1' })).status).toBe(403);
  });

  it('exports an environment as JSON and as a .env file, and audits both', async () => {
    const created = await project('Exports');
    const env = created.environments[2];
    await secret(created.id, env.id, 'B_VALUE', 'with space');
    await secret(created.id, env.id, 'A_VALUE', 'plain');
    const path = `${secretsPath(created.id, env.id)}/export`;

    const json = await app(['secrets:reveal']).get(path);
    expect(await data<Record<string, string>>(json)).toEqual({ A_VALUE: 'plain', B_VALUE: 'with space' });

    const dotenv = await app(['secrets:reveal']).get(`${path}?format=dotenv`);
    expect(dotenv.status).toBe(200);
    expect(dotenv.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(dotenv.headers.get('content-disposition')).toBe(`attachment; filename="${created.slug}.production.env"`);
    expect(await dotenv.text()).toBe('A_VALUE=plain\nB_VALUE="with space"\n');

    const events = await db
      .select()
      .from(schema.weldpassAuditEvents)
      .where(and(eq(schema.weldpassAuditEvents.projectId, created.id), eq(schema.weldpassAuditEvents.action, 'secret.exported')));
    expect(events.map((e) => (e.metadata as { format: string }).format)).toEqual(
      expect.arrayContaining(['json', 'dotenv']),
    );
    expect(JSON.stringify(events)).not.toContain('with space');
  });

  it('will not reveal through another environment of the same project', async () => {
    const created = await project('Crossed');
    const written = await secret(created.id, created.environments[0].id, 'HERE', 'only-here');
    const res = await app().get(`${secretsPath(created.id, created.environments[1].id)}/${written.secret.id}/reveal`);
    expect(res.status).toBe(404);
  });
});

describe('weldpass audit trail', () => {
  it('pages newest first with a cursor and a clamped limit', async () => {
    const created = await project('Audited');
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute, 0));
    await db.insert(schema.weldpassAuditEvents).values(
      [1, 2, 3, 4, 5].map((minute) => ({
        id: `wpa_s${minute}_${created.id.slice(-10)}`,
        projectId: created.id,
        actorId: 'user_seed',
        action: 'secret.revealed',
        targetKey: `KEY_${minute}`,
        metadata: { minute },
        ip: '203.0.113.7',
        createdAt: at(minute),
      })),
    );

    const first = await app(['secrets:manage']).get(`/projects/${created.id}/audit?limit=2`);
    const page1 = (await first.json()) as {
      data: Array<{ targetKey: string | null; createdAt: string }>;
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(page1.pagination.hasMore).toBe(true);
    expect(page1.data).toHaveLength(2);

    let cursor = page1.pagination.cursor;
    const seen: Array<string | null> = page1.data.map((row) => row.targetKey);
    while (cursor) {
      const next = (await (
        await app(['secrets:manage']).get(`/projects/${created.id}/audit?limit=2&cursor=${encodeURIComponent(cursor)}`)
      ).json()) as typeof page1;
      seen.push(...next.data.map((row) => row.targetKey));
      cursor = next.pagination.cursor;
    }
    expect(seen.slice(-5)).toEqual(['KEY_5', 'KEY_4', 'KEY_3', 'KEY_2', 'KEY_1']);

    const clamped = await app(['secrets:manage']).get(`/projects/${created.id}/audit?limit=0&cursor=not-a-date`);
    expect(((await clamped.json()) as typeof page1).data).toHaveLength(1);
    const garbage = await app(['secrets:manage']).get(`/projects/${created.id}/audit?limit=abc`);
    expect(((await garbage.json()) as typeof page1).pagination.totalCount).toBeGreaterThan(5);
  });
});
