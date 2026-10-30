/**
 * /api/auth-sessions with Clerk's sessions API as a fetch stub: revoking every
 * other session of the caller (the current one kept, refusals counted, Clerk
 * failures), and revoking one after checking it is the caller's.
 *
 * The stub answers by method and URL, never by call order, so the conformance
 * suite can run these against the Rust backend too (its Identity port reaches
 * the same stub through the outbound bridge).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

import { authSessionsRoutes } from './index';

const USER = 'user_as_me';
const CURRENT = 'sess_as_current';

/** What one Clerk endpoint answers; status 0 makes `fetch` throw. */
interface Answer {
  status: number;
  body?: unknown;
}

interface Scenario {
  /** `GET /sessions?user_id=…&status=active&limit=100`. */
  list: Answer;
  /** `GET /sessions/:id`, by id (missing: 404). */
  sessions: Record<string, Answer>;
  /** `POST /sessions/:id/revoke`, by id (missing: 200). */
  revoke: Record<string, Answer>;
}

let scenario: Scenario;
let calls: Array<{ method: string; url: string }>;
let tenant: Database;

function respond(answer: Answer): Response {
  if (answer.status === 0) throw new TypeError('fetch failed');
  return new Response(JSON.stringify(answer.body ?? {}), {
    status: answer.status,
    headers: { 'content-type': 'application/json' },
  });
}

function clerk(method: string, url: URL): Response {
  const path = url.pathname.replace(/^\/v1/, '');
  if (method === 'GET' && path === '/sessions') return respond(scenario.list);
  const [root, rawId, action] = path.split('/').filter(Boolean);
  const id = decodeURIComponent(rawId ?? '');
  if (root !== 'sessions' || !id) return respond({ status: 404 });
  if (method === 'GET' && !action) return respond(scenario.sessions[id] ?? { status: 404 });
  if (method === 'POST' && action === 'revoke') return respond(scenario.revoke[id] ?? { status: 200, body: { id } });
  return respond({ status: 404 });
}

function session(id: string, userId = USER): Answer {
  return { status: 200, body: { id, user_id: userId, status: 'active' } };
}

beforeAll(async () => {
  tenant = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  scenario = { list: { status: 200, body: [] }, sessions: {}, revoke: {} };
  calls = [];
  // Anything that isn't Clerk (the conformance harness talking to the Rust
  // server) goes out as usual.
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.hostname !== 'api.clerk.com') return realFetch(input, init);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url: url.href });
      return clerk(method, url);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function post(path: string) {
  const t = createTestApp('/api/auth-sessions', authSessionsRoutes, {
    context: { tenantDb: tenant, userId: USER, sessionId: CURRENT, orgId: 'org_as', workspaceId: 'ws_as' },
  });
  return t.request(`/api/auth-sessions${path}`, { method: 'POST' });
}

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string } };

describe('POST /api/auth-sessions/revoke-all', () => {
  it("revokes the caller's other sessions and keeps the current one", async () => {
    scenario.list = {
      status: 200,
      body: [
        { id: CURRENT, user_id: USER, status: 'active' },
        { id: 'sess_as_laptop', user_id: USER, status: 'active' },
        { id: 'sess_as_phone', user_id: USER, status: 'active' },
      ],
    };

    const res = await post('/revoke-all');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { revokedCount: 2, failedCount: 0 } });
  });

  it("counts the sessions Clerk refused, and reads Clerk's paginated shape", async () => {
    scenario.list = {
      status: 200,
      body: {
        data: [
          { id: 'sess_as_laptop', user_id: USER, status: 'active' },
          { id: 'sess_as_tablet', user_id: USER, status: 'active' },
        ],
        total_count: 2,
      },
    };
    scenario.revoke.sess_as_tablet = { status: 422, body: { errors: [{ code: 'session_not_active' }] } };

    const res = await post('/revoke-all');

    expect(await res.json()).toEqual({ data: { revokedCount: 1, failedCount: 1 } });
  });

  it('with nothing else signed in, revokes nothing', async () => {
    scenario.list = { status: 200, body: [{ id: CURRENT, user_id: USER, status: 'active' }] };

    const res = await post('/revoke-all');

    expect(await res.json()).toEqual({ data: { revokedCount: 0, failedCount: 0 } });
  });

  it('is a 500 when Clerk refuses the list', async () => {
    scenario.list = { status: 500, body: { errors: [{ code: 'internal' }] } };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await post('/revoke-all');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke sessions' } });
  });

  it('is a 500 when Clerk cannot be reached', async () => {
    scenario.list = { status: 0 };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await post('/revoke-all');

    expect(res.status).toBe(500);
    expect(((await res.json()) as Body).error?.message).toBe('Failed to revoke sessions');
  });

  it('is a 500 when Clerk drops a revoke', async () => {
    scenario.list = { status: 200, body: [{ id: 'sess_as_laptop', user_id: USER, status: 'active' }] };
    scenario.revoke.sess_as_laptop = { status: 0 };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await post('/revoke-all');

    expect(res.status).toBe(500);
    expect(((await res.json()) as Body).error?.message).toBe('Failed to revoke sessions');
  });
});

describe('POST /api/auth-sessions/:sessionId/revoke', () => {
  it("revokes one of the caller's sessions", async () => {
    scenario.sessions.sess_as_laptop = session('sess_as_laptop');

    const res = await post('/sess_as_laptop/revoke');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { revoked: true, sessionId: 'sess_as_laptop' } });
    // In conformance mode both backends reach the stub: the same calls twice.
    expect([...new Set(calls.map((c) => `${c.method} ${c.url}`))]).toEqual([
      'GET https://api.clerk.com/v1/sessions/sess_as_laptop',
      'POST https://api.clerk.com/v1/sessions/sess_as_laptop/revoke',
    ]);
  });

  it('encodes the session id for Clerk', async () => {
    scenario.sessions['sess as/odd'] = session('sess as/odd');

    const res = await post('/sess%20as%2Fodd/revoke');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { revoked: true, sessionId: 'sess as/odd' } });
  });

  it("never revokes another user's session", async () => {
    scenario.sessions.sess_as_theirs = session('sess_as_theirs', 'user_as_someone_else');

    const res = await post('/sess_as_theirs/revoke');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'You can only revoke your own sessions' } });
  });

  it('is a 404 for a session Clerk does not know', async () => {
    const res = await post('/sess_as_missing/revoke');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: "Session with ID 'sess_as_missing' not found" },
    });
  });

  it('is a 500 when Clerk refuses the lookup', async () => {
    scenario.sessions.sess_as_laptop = { status: 503 };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await post('/sess_as_laptop/revoke');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to verify session' } });
  });

  it('is a 500 when Clerk cannot be reached', async () => {
    scenario.sessions.sess_as_laptop = { status: 0 };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await post('/sess_as_laptop/revoke');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke session' } });
  });

  it('is a 500 when Clerk refuses the revoke', async () => {
    scenario.sessions.sess_as_laptop = session('sess_as_laptop');
    scenario.revoke.sess_as_laptop = { status: 400, body: { errors: [{ code: 'bad' }] } };

    const res = await post('/sess_as_laptop/revoke');

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke session' } });
  });
});
