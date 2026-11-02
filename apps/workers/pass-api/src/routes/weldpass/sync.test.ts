/**
 * DB-backed tests for WeldPass provider credentials and sync targets: the
 * credential lifecycle, verification and pushes against Cloudflare Workers,
 * Cloudflare Pages and Vercel, pruning, auto-sync after a secret write, and
 * the refusals.
 *
 * The providers are a `fetch` stub that answers by URL and method (never by
 * call order), so in conformance mode it answers the Rust backend's calls the
 * same way, and the harness compares the calls both made. The Cloudflare SDK
 * keeps its own `fetch`; `__setDeployFetchForTests` points it at the global
 * one so the stub (and the recording) sees its calls too.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { __setDeployFetchForTests } from '@weldsuite/cloudflare-deploy';
import { weldpassRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const ROOT_KEY = 'e'.repeat(64);
const BASE = '/api/weldpass';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CF = 'https://api.cloudflare.com/client/v4';
const VERCEL = 'https://api.vercel.com';

let db: Database;
const realFetch = globalThis.fetch;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const cfOk = (result: unknown) => json(200, { success: true, errors: [], messages: [], result });
const cfError = (status: number, message: string) =>
  json(status, { success: false, errors: [{ code: 10000, message }], messages: [], result: null });

/** Cloudflare and Vercel, by URL and method. */
async function providers(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(CF) && !url.startsWith(VERCEL)) return realFetch(input, init);
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = url.startsWith(CF) ? url.slice(CF.length) : url.slice(VERCEL.length);

  // ── Cloudflare ──
  if (path === '/accounts/acct_ok' && method === 'GET') return cfOk({ id: 'acct_ok', name: 'Acme Corp' });
  if (path === '/accounts/acct_denied' && method === 'GET') return cfError(403, 'Authentication error');
  if (path === '/accounts/acct_odd' && method === 'GET') return json(404, { success: false, errors: [] });
  if (path === '/accounts/acct_ok/workers/scripts/worker-a/secrets' && method === 'GET') {
    return cfOk([{ name: 'OLD_SECRET', type: 'secret_text' }, { name: 'KEEP_ME', type: 'secret_text' }, { name: 'API_KEY', type: 'secret_text' }]);
  }
  if (path === '/accounts/acct_ok/workers/scripts/missing-worker/secrets') return cfError(404, 'workers.api.error.script_not_found');
  if (path === '/accounts/acct_ok/workers/scripts/worker-a/secrets-bulk' && method === 'PATCH') return cfOk(null);
  if (path === '/accounts/acct_ok/workers/scripts/broken-worker/secrets-bulk' && method === 'PATCH') {
    return json(400, { success: false, errors: [{ code: 1, message: 'bad secret' }, { code: 2, message: 'and another' }] });
  }
  if (path === '/accounts/acct_ok/workers/scripts/flaky-worker/secrets-bulk' && method === 'PATCH') {
    return json(503, { success: false, errors: [{ code: 3, message: 'try later' }] });
  }
  if (path.startsWith('/accounts/acct_down/')) throw new TypeError('fetch failed');
  if (path === '/accounts/acct_ok/pages/projects/site' && method === 'GET') {
    return cfOk({
      name: 'site',
      deployment_configs: {
        production: { env_vars: { OLD_VAR: { type: 'plain_text', value: 'x' }, API_KEY: { type: 'secret_text' }, KEEP: { type: 'plain_text' } } },
        preview: { env_vars: null },
      },
    });
  }
  if (path === '/accounts/acct_ok/pages/projects/site' && method === 'PATCH') return cfOk({ name: 'site' });

  // ── Vercel ──
  if (path === '/v9/projects/prj_ok?teamId=team_1' && method === 'GET') return json(200, { id: 'prj_ok', name: 'web-app' });
  if (path === '/v9/projects/prj_noname' && method === 'GET') return json(200, { id: 'prj_noname' });
  if (path === '/v9/projects/prj_missing' && method === 'GET') {
    return json(404, { error: { code: 'not_found', message: 'Project not found' } });
  }
  if (path === '/v9/projects/prj_plain' && method === 'GET') return new Response('upstream exploded', { status: 500 });
  if (path === '/v9/projects/prj_unreachable' && method === 'GET') throw new Error('socket hang up');
  if (path.startsWith('/v10/projects/prj_ok/env?upsert=true') && method === 'POST') {
    const body = JSON.parse(String(init?.body)) as Array<{ key: string }>;
    return json(200, {
      created: body.filter((e) => e.key !== 'REJECTED').map((e) => ({ key: e.key })),
      failed: body.filter((e) => e.key === 'REJECTED').map((e) => ({ error: { key: e.key, message: 'Value too long' } })),
    });
  }
  if (path.startsWith('/v9/projects/prj_ok/env?') || path === '/v9/projects/prj_ok/env') {
    if (method === 'GET') {
      return json(200, {
        envs: [
          { id: 'env_stale', key: 'STALE', target: ['production', 'preview'] },
          { id: 'env_partial', key: 'PARTIAL', target: ['preview'] },
          { id: 'env_kept', key: 'API_KEY', target: ['production', 'preview'] },
          { id: 'env/locked', key: 'LOCKED', target: ['production', 'preview', 'development'] },
        ],
      });
    }
  }
  if (path.startsWith('/v9/projects/prj_ok/env/env_stale') && method === 'DELETE') return json(200, {});
  if (path.startsWith('/v9/projects/prj_ok/env/env%2Flocked') && method === 'DELETE') {
    return json(403, { error: { message: 'Environment variable is locked' } });
  }
  return json(418, { error: { message: `unexpected ${method} ${path}` } });
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(providers));
  __setDeployFetchForTests(((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  __setDeployFetchForTests(undefined);
});

function app(grants: string[] = ['secrets:read', 'secrets:reveal', 'secrets:create', 'secrets:update', 'secrets:delete', 'secrets:sync', 'secrets:manage']) {
  const { request } = createTestApp(BASE, weldpassRoutes, {
    context: { userId: 'user_syncer', permissions: permissions(...grants), tenantDb: db, clerkOrgId: 'org_sync', orgId: 'org_sync' },
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

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as { data: T }).data;
}

interface Project {
  id: string;
  environments: Array<{ id: string; slug: string }>;
}

async function project(name: string): Promise<Project> {
  const res = await app().send('POST', '/projects', { name });
  expect(res.status).toBe(201);
  return data<Project>(res);
}

async function credential(projectId: string, provider: string, name: string, token = 'tok', metadata?: unknown) {
  const res = await app().send('POST', `/projects/${projectId}/credentials`, { provider, name, token, metadata });
  expect(res.status).toBe(201);
  return data<{ id: string; provider: string; lastVerifiedAt: string | null }>(res);
}

async function target(projectId: string, body: Record<string, unknown>) {
  const res = await app().send('POST', `/projects/${projectId}/sync-targets`, body);
  expect(res.status).toBe(201);
  return data<{ id: string; redeployNotice: string | null; config: Record<string, unknown> }>(res);
}

async function addSecrets(projectId: string, environmentId: string, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    const res = await app().send('POST', `/projects/${projectId}/environments/${environmentId}/secrets`, { key, value });
    expect([200, 201]).toContain(res.status);
  }
}

describe('weldpass credentials', () => {
  it('renames, replaces the token, edits metadata and deletes with its targets', async () => {
    const p = await project('Credential life');
    const cred = await credential(p.id, 'cloudflare_workers', 'CF', 'cf-token', { accountId: 'acct_ok', extra: 'dropped' });
    const listed = await data<Array<{ id: string; metadata: unknown }>>(await app().get(`/projects/${p.id}/credentials`));
    expect(listed.find((c) => c.id === cred.id)?.metadata).toEqual({ accountId: 'acct_ok' });

    const renamed = await app().send('PATCH', `/projects/${p.id}/credentials/${cred.id}`, {
      name: 'CF prod',
      token: 'cf-token-2',
      metadata: { teamId: 't' },
    });
    expect(renamed.status).toBe(200);
    expect(await data<Record<string, unknown>>(renamed)).toMatchObject({ name: 'CF prod', metadata: { teamId: 't' }, lastVerifiedAt: null });
    expect((await app().send('PATCH', `/projects/${p.id}/credentials/wpc_nope`, { name: 'x' })).status).toBe(404);
    expect((await app().send('PATCH', `/projects/${p.id}/credentials/${cred.id}`, { token: '' })).status).toBe(400);
    expect((await app(['secrets:read']).send('PATCH', `/projects/${p.id}/credentials/${cred.id}`, { name: 'x' })).status).toBe(403);

    const t = await target(p.id, {
      environmentId: p.environments[0].id,
      credentialId: cred.id,
      name: 'Worker A',
      config: { provider: 'cloudflare_workers', accountId: 'acct_ok', scriptName: 'worker-a' },
    });
    expect((await app().send('DELETE', `/projects/${p.id}/credentials/${cred.id}`)).status).toBe(204);
    expect((await app().get(`/projects/${p.id}/sync-targets/${t.id}/preview`)).status).toBe(404);
    expect((await app().send('DELETE', `/projects/${p.id}/credentials/${cred.id}`)).status).toBe(404);

    const [event] = await db
      .select()
      .from(schema.weldpassAuditEvents)
      .where(eq(schema.weldpassAuditEvents.action, 'credential.deleted'));
    expect(event.metadata).toEqual({ detachedTargets: 1 });
  });

  it('validates a credential body', async () => {
    const p = await project('Credential bodies');
    const res = await app().send('POST', `/projects/${p.id}/credentials`, { provider: 'aws', name: '', token: 't', metadata: { accountId: 1 } });
    expect(res.status).toBe(400);
    expect((await app(['secrets:read']).get(`/projects/${p.id}/credentials`)).status).toBe(403);
  });

  it('verifies against each provider and records the outcome', async () => {
    const p = await project('Verification');
    const workers = await credential(p.id, 'cloudflare_workers', 'Workers');
    const verify = (id: string, config: unknown) => app().send('POST', `/projects/${p.id}/credentials/${id}/verify`, { config });

    const ok = await verify(workers.id, { provider: 'cloudflare_workers', accountId: 'acct_ok', scriptName: 'worker-a' });
    expect(await data<unknown>(ok)).toEqual({ ok: true, identity: 'Acme Corp → worker-a' });
    const denied = await verify(workers.id, { provider: 'cloudflare_workers', accountId: 'acct_denied', scriptName: 'worker-a' });
    expect(await data<unknown>(denied)).toEqual({
      ok: false,
      message: 'Cloudflare account acct_denied is not reachable with this token: Authentication error',
    });
    const odd = await verify(workers.id, { provider: 'cloudflare_workers', accountId: 'acct_odd', scriptName: 'worker-a' });
    expect(await data<unknown>(odd)).toEqual({
      ok: false,
      message: 'Cloudflare account acct_odd is not reachable with this token: 404 {"success":false,"errors":[]}',
    });
    const noScript = await verify(workers.id, { provider: 'cloudflare_workers', accountId: 'acct_ok', scriptName: 'missing-worker' });
    expect(await data<unknown>(noScript)).toEqual({
      ok: false,
      message: 'Could not list secrets on Worker "missing-worker": workers.api.error.script_not_found',
    });
    const dots = await verify(workers.id, { provider: 'cloudflare_workers', accountId: 'acct_ok', scriptName: '..' });
    expect((await data<{ ok: boolean }>(dots)).ok).toBe(false);

    const wrongConfig = await verify(workers.id, { provider: 'vercel', projectId: 'prj_ok', targets: ['production'] });
    expect(wrongConfig.status).toBe(502);
    expect(await wrongConfig.json()).toEqual({
      error: { code: 'SYNC_FAILED', message: 'Config does not describe a Cloudflare Workers target' },
    });

    const pages = await credential(p.id, 'cloudflare_pages', 'Pages');
    const pagesOk = await verify(pages.id, { provider: 'cloudflare_pages', accountId: 'acct_ok', projectName: 'site', environment: 'preview' });
    expect(await data<unknown>(pagesOk)).toEqual({ ok: true, identity: 'Acme Corp → site (preview)' });

    const vercel = await credential(p.id, 'vercel', 'Vercel');
    const vercelOk = await verify(vercel.id, { provider: 'vercel', projectId: 'prj_ok', teamId: 'team_1', targets: ['production'] });
    expect(await data<unknown>(vercelOk)).toEqual({ ok: true, identity: 'web-app' });
    const vercelId = await verify(vercel.id, { provider: 'vercel', projectId: 'prj_noname', targets: ['preview'] });
    expect(await data<unknown>(vercelId)).toEqual({ ok: true, identity: 'prj_noname' });
    const vercelMissing = await verify(vercel.id, { provider: 'vercel', projectId: 'prj_missing', targets: ['preview'] });
    expect(await data<unknown>(vercelMissing)).toEqual({ ok: false, message: 'Vercel API 404: Project not found' });
    const vercelPlain = await verify(vercel.id, { provider: 'vercel', projectId: 'prj_plain', targets: ['preview'] });
    expect(await data<unknown>(vercelPlain)).toEqual({ ok: false, message: 'Vercel API 500: upstream exploded' });
    const unreachable = await verify(vercel.id, { provider: 'vercel', projectId: 'prj_unreachable', targets: ['preview'] });
    expect(await data<unknown>(unreachable)).toEqual({
      ok: false,
      message: 'Could not reach the Vercel API: socket hang up',
    });

    const listed = await data<Array<{ id: string; lastVerifyError: string | null; lastVerifiedAt: string | null }>>(
      await app().get(`/projects/${p.id}/credentials`),
    );
    expect(listed.find((c) => c.id === vercel.id)?.lastVerifyError).toBe('Could not reach the Vercel API: socket hang up');
    expect(listed.find((c) => c.id === vercel.id)?.lastVerifiedAt).not.toBeNull();

    expect((await verify('wpc_missing', { provider: 'vercel', projectId: 'p', targets: ['preview'] })).status).toBe(404);
    expect((await verify(vercel.id, { provider: 'netlify' })).status).toBe(400);
  });
});

describe('weldpass sync targets', () => {
  it('creates, lists, previews, updates and deletes targets', async () => {
    const p = await project('Targets');
    const [dev, preview] = p.environments;
    const workers = await credential(p.id, 'cloudflare_workers', 'Workers');
    const vercel = await credential(p.id, 'vercel', 'Vercel');
    await addSecrets(p.id, dev.id, { B_KEY: 'b', A_KEY: 'a' });

    const w = await target(p.id, {
      environmentId: dev.id,
      credentialId: workers.id,
      name: 'Zeta worker',
      config: { provider: 'cloudflare_workers', accountId: 'acct_ok', scriptName: 'worker-a', extra: true },
      prune: true,
    });
    expect(w.redeployNotice).toBe('Cloudflare rolls a new Worker version when secrets change; a redeploy is not needed.');
    const v = await target(p.id, {
      environmentId: preview.id,
      credentialId: vercel.id,
      name: 'Alpha vercel',
      config: { provider: 'vercel', projectId: 'prj_ok', targets: ['preview'] },
      autoSync: true,
    });
    expect(v.redeployNotice).toBe('Vercel applies these on the next deployment — redeploy to pick them up.');

    const all = await data<Array<{ name: string }>>(await app(['secrets:read']).get(`/projects/${p.id}/sync-targets`));
    expect(all.map((t) => t.name)).toEqual(['Alpha vercel', 'Zeta worker']);
    const one = await data<Array<{ name: string }>>(
      await app(['secrets:read']).get(`/projects/${p.id}/sync-targets?environmentId=${dev.id}`),
    );
    expect(one.map((t) => t.name)).toEqual(['Zeta worker']);
    const none = await data<unknown[]>(await app(['secrets:read']).get(`/projects/${p.id}/sync-targets?environmentId=`));
    expect(none).toHaveLength(2);

    const previewRes = await app(['secrets:read']).get(`/projects/${p.id}/sync-targets/${w.id}/preview`);
    expect(await data<unknown>(previewRes)).toEqual({
      targetId: w.id,
      environmentId: dev.id,
      keys: ['A_KEY', 'B_KEY'],
      prune: true,
      redeployNotice: 'Cloudflare rolls a new Worker version when secrets change; a redeploy is not needed.',
    });

    const updated = await app().send('PATCH', `/projects/${p.id}/sync-targets/${w.id}`, {
      name: 'Renamed worker',
      autoSync: true,
      prune: false,
      config: { provider: 'cloudflare_workers', accountId: 'acct_ok', scriptName: 'worker-b' },
    });
    expect(await data<Record<string, unknown>>(updated)).toMatchObject({
      name: 'Renamed worker',
      autoSync: true,
      prune: false,
      config: { provider: 'cloudflare_workers', accountId: 'acct_ok', scriptName: 'worker-b' },
    });

    const changeProvider = await app().send('PATCH', `/projects/${p.id}/sync-targets/${w.id}`, {
      config: { provider: 'vercel', projectId: 'p', targets: ['preview'] },
    });
    expect(changeProvider.status).toBe(400);
    expect(((await changeProvider.json()) as { error: { message: string } }).error.message).toBe(
      'A target cannot change provider — create a new target instead.',
    );
    const wrongCredential = await app().send('PATCH', `/projects/${p.id}/sync-targets/${w.id}`, { credentialId: vercel.id });
    expect(await wrongCredential.json()).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'That credential is for vercel, but the target is configured for cloudflare_workers.',
      },
    });
    expect((await app().send('PATCH', `/projects/${p.id}/sync-targets/${w.id}`, { credentialId: 'wpc_nope' })).status).toBe(404);
    expect((await app().send('PATCH', `/projects/${p.id}/sync-targets/wpt_nope`, { name: 'x' })).status).toBe(404);

    expect((await app().send('DELETE', `/projects/${p.id}/sync-targets/${v.id}`)).status).toBe(204);
    expect((await app().send('DELETE', `/projects/${p.id}/sync-targets/${v.id}`)).status).toBe(404);
    expect((await app(['secrets:read']).send('DELETE', `/projects/${p.id}/sync-targets/${w.id}`)).status).toBe(403);
  });

  it('refuses a target in another project, or with a body Zod rejects', async () => {
    const mine = await project('Target refusals');
    const other = await project('Target other');
    const otherCred = await credential(other.id, 'vercel', 'Theirs');
    const res = await app().send('POST', `/projects/${mine.id}/sync-targets`, {
      environmentId: mine.environments[0].id,
      credentialId: otherCred.id,
      name: 'Borrowed',
      config: { provider: 'vercel', projectId: 'prj_ok', targets: ['preview'] },
    });
    expect(res.status).toBe(404);
    const badEnv = await app().send('POST', `/projects/${mine.id}/sync-targets`, {
      environmentId: other.environments[0].id,
      credentialId: otherCred.id,
      name: 'Borrowed',
      config: { provider: 'vercel', projectId: 'prj_ok', targets: ['preview'] },
    });
    expect(badEnv.status).toBe(404);
    for (const config of [
      { provider: 'netlify' },
      {},
      'x',
      { provider: 'cloudflare_pages', accountId: '', projectName: 'p', environment: 'staging' },
      { provider: 'vercel', projectId: 'p', targets: [] },
      { provider: 'vercel', projectId: 'p', targets: ['production', 'qa', 'preview', 'development'] },
    ]) {
      const invalid = await app().send('POST', `/projects/${mine.id}/sync-targets`, {
        environmentId: 'e',
        credentialId: 'c',
        name: 'n',
        config,
      });
      expect(invalid.status).toBe(400);
    }
  });

  it('pushes to a Worker, pruning keys the vault no longer has', async () => {
    const p = await project('Worker push');
    const env = p.environments[2];
    await addSecrets(p.id, env.id, { API_KEY: 'k-123', DATABASE_URL: 'postgres://db' });
    const cred = await credential(p.id, 'cloudflare_workers', 'Workers', 'cf-push-token');
    const t = await target(p.id, {
      environmentId: env.id,
      credentialId: cred.id,
      name: 'Worker A',
      config: { provider: 'cloudflare_workers', accountId: 'acct_ok', scriptName: 'worker-a' },
      prune: true,
    });

    const res = await app(['secrets:sync']).send('POST', `/projects/${p.id}/sync-targets/${t.id}/push`);
    expect(res.status).toBe(200);
    const body = await data<{
      run: { status: string; pushed: number; removed: number; details: Array<{ key: string; action: string }> };
      target: { status: string; lastSyncedCount: number; redeployNotice: string };
    }>(res);
    expect(body.run).toMatchObject({ status: 'success', pushed: 2, removed: 2 });
    expect(body.run.details).toEqual([
      { key: 'API_KEY', action: 'pushed' },
      { key: 'DATABASE_URL', action: 'pushed' },
      { key: 'OLD_SECRET', action: 'removed' },
      { key: 'KEEP_ME', action: 'removed' },
    ]);
    expect(body.target).toMatchObject({ status: 'success', lastSyncedCount: 2 });

    const bulk = vi.mocked(globalThis.fetch).mock.calls.find(([input, init]) =>
      String(input).endsWith('/secrets-bulk') && init?.method === 'PATCH',
    );
    expect(JSON.parse(String(bulk?.[1]?.body))).toEqual({
      secrets: {
        API_KEY: { name: 'API_KEY', text: 'k-123', type: 'secret_text' },
        DATABASE_URL: { name: 'DATABASE_URL', text: 'postgres://db', type: 'secret_text' },
        OLD_SECRET: null,
        KEEP_ME: null,
      },
    });

    const runs = await data<Array<{ trigger: string; status: string }>>(
      await app(['secrets:read']).get(`/projects/${p.id}/sync-runs?targetId=${t.id}&limit=500`),
    );
    expect(runs[0]).toMatchObject({ trigger: 'manual', status: 'success' });
    expect((await app(['secrets:read']).get(`/projects/${p.id}/sync-runs?limit=x`)).status).toBe(200);
  });

  it('records a failed push as a run, not an error', async () => {
    const p = await project('Failed push');
    const env = p.environments[0];
    await addSecrets(p.id, env.id, { ONLY: 'one' });
    const cred = await credential(p.id, 'cloudflare_workers', 'Workers');
    const broken = await target(p.id, {
      environmentId: env.id,
      credentialId: cred.id,
      name: 'Broken',
      config: { provider: 'cloudflare_workers', accountId: 'acct_ok', scriptName: 'broken-worker' },
    });
    const res = await app().send('POST', `/projects/${p.id}/sync-targets/${broken.id}/push`);
    expect(res.status).toBe(200);
    const body = await data<{ run: { status: string; error: string }; target: { status: string; lastError: string } }>(res);
    expect(body.run).toMatchObject({
      status: 'failed',
      error: 'Could not write secrets to Worker "broken-worker": bad secret; and another',
    });
    expect(body.target).toMatchObject({ status: 'failed', lastError: body.run.error });

    const flaky = await target(p.id, {
      environmentId: env.id,
      credentialId: cred.id,
      name: 'Flaky',
      config: { provider: 'cloudflare_workers', accountId: 'acct_ok', scriptName: 'flaky-worker' },
    });
    const retried = await app().send('POST', `/projects/${p.id}/sync-targets/${flaky.id}/push`);
    expect((await data<{ run: { error: string } }>(retried)).run.error).toBe(
      'Could not write secrets to Worker "flaky-worker": try later',
    );

    const down = await target(p.id, {
      environmentId: env.id,
      credentialId: cred.id,
      name: 'Down',
      config: { provider: 'cloudflare_workers', accountId: 'acct_down', scriptName: 'any' },
    });
    const unreachable = await app().send('POST', `/projects/${p.id}/sync-targets/${down.id}/push`);
    expect((await data<{ run: { error: string } }>(unreachable)).run.error).toBe(
      'Could not write secrets to Worker "any": Connection error.',
    );

    // A credential deleted under a target: the target goes with it.
    expect((await app().send('POST', `/projects/${p.id}/sync-targets/wpt_missing/push`)).status).toBe(404);

    const events = await db
      .select()
      .from(schema.weldpassAuditEvents)
      .where(eq(schema.weldpassAuditEvents.action, 'sync.failed'));
    expect(events.some((e) => e.targetKey === 'Broken')).toBe(true);
  });

  it('pushes Pages env vars, pruning only the chosen deployment config', async () => {
    const p = await project('Pages push');
    const env = p.environments[2];
    await addSecrets(p.id, env.id, { API_KEY: 'pk', NEW_VAR: 'nv' });
    const cred = await credential(p.id, 'cloudflare_pages', 'Pages');
    const t = await target(p.id, {
      environmentId: env.id,
      credentialId: cred.id,
      name: 'Site',
      config: { provider: 'cloudflare_pages', accountId: 'acct_ok', projectName: 'site', environment: 'production' },
      prune: true,
    });
    expect(t.redeployNotice).toBe('Cloudflare Pages applies these on the next deployment — redeploy to pick them up.');
    const res = await app().send('POST', `/projects/${p.id}/sync-targets/${t.id}/push`);
    const body = await data<{ run: { status: string; details: Array<{ key: string; action: string }> } }>(res);
    expect(body.run.status).toBe('success');
    expect(body.run.details).toEqual([
      { key: 'API_KEY', action: 'pushed' },
      { key: 'NEW_VAR', action: 'pushed' },
      { key: 'OLD_VAR', action: 'removed' },
      { key: 'KEEP', action: 'removed' },
    ]);
  });

  it('pushes to Vercel, reporting rejected values and prunable keys', async () => {
    const p = await project('Vercel push');
    const env = p.environments[1];
    await addSecrets(p.id, env.id, { API_KEY: 'v1', REJECTED: 'too-long' });
    const cred = await credential(p.id, 'vercel', 'Vercel');
    const t = await target(p.id, {
      environmentId: env.id,
      credentialId: cred.id,
      name: 'Web',
      config: { provider: 'vercel', projectId: 'prj_ok', targets: ['production', 'preview'] },
      prune: true,
    });
    const res = await app().send('POST', `/projects/${p.id}/sync-targets/${t.id}/push`);
    const body = await data<{
      run: { status: string; pushed: number; removed: number; failed: number; error: string; details: unknown[] };
    }>(res);
    expect(body.run).toMatchObject({
      status: 'partial',
      pushed: 1,
      removed: 1,
      failed: 2,
      error: '2 of 3 values were rejected',
    });
    expect(body.run.details).toEqual([
      { key: 'API_KEY', action: 'pushed' },
      { key: 'REJECTED', action: 'failed', message: 'Value too long' },
      { key: 'STALE', action: 'removed' },
      { key: 'LOCKED', action: 'failed', message: 'Vercel API 403: Environment variable is locked' },
    ]);
  });

  it('auto-syncs after a write and reports the outcome next to the secret', async () => {
    const p = await project('Auto sync');
    const env = p.environments[0];
    const cred = await credential(p.id, 'cloudflare_workers', 'Workers');
    await target(p.id, {
      environmentId: env.id,
      credentialId: cred.id,
      name: 'Auto worker',
      config: { provider: 'cloudflare_workers', accountId: 'acct_ok', scriptName: 'worker-a' },
      autoSync: true,
    });
    const res = await app().send('POST', `/projects/${p.id}/environments/${env.id}/secrets`, { key: 'AUTO', value: 'synced' });
    expect(res.status).toBe(201);
    const body = await data<{ autoSync: Array<{ name: string; status: string; pushed: number; error: string | null }> }>(res);
    expect(body.autoSync).toEqual([
      expect.objectContaining({ name: 'Auto worker', status: 'success', pushed: 1, error: null }),
    ]);

    const unchanged = await app().send('POST', `/projects/${p.id}/environments/${env.id}/secrets`, { key: 'AUTO', value: 'synced' });
    expect((await data<{ autoSync: unknown[] }>(unchanged)).autoSync).toEqual([]);

    const runs = await data<Array<{ trigger: string }>>(await app().get(`/projects/${p.id}/sync-runs`));
    expect(runs.map((r) => r.trigger)).toContain('auto');
  });
});
