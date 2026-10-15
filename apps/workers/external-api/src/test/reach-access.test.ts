/**
 * WeldReach on the public API: who gets in.
 *
 * What must hold, whatever the payload:
 *   - only a workspace whose WeldReach access staff approved gets through, with
 *     403 APP_ACCESS_REQUIRED and the status otherwise, before any scope is looked at;
 *   - every endpoint is gated by its scope, and `reach_inbox:reply` is held by
 *     name only (`*` and `reach_inbox:*` do not grant it);
 *   - the partner licence applies to `/v1/reach/*` like it does to the app's own paths.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createExternalTestApp } from './harness';
import { createPgliteDb } from './pglite';
import { hasScope, NAMED_ONLY_SCOPES } from '../lib/scopes';
import type { Database } from '../db';
import { approvedAccess, ORG_ID, REACH_SCOPES, reachTestApp } from './reach-support';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

describe('the approval gate', () => {
  it.each(['none', 'requested', 'rejected', 'suspended', 'revoked'] as const)(
    'answers 403 APP_ACCESS_REQUIRED with the status when access is %s',
    async (status) => {
      const app = reachTestApp({ db, access: approvedAccess({ status }) });
      const res = await app.get<ErrorBody>('/v1/reach/overview');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: {
          code: 'APP_ACCESS_REQUIRED',
          message: 'This workspace has no approved access to weldreach.',
          details: { appCode: 'weldreach', status },
        },
      });
    },
  );

  it('lets an approved workspace through', async () => {
    const app = reachTestApp({ db });
    expect((await app.get('/v1/reach/overview')).status).toBe(200);
  });

  it('gates every path under /v1/reach, including ones that do not exist', async () => {
    const app = reachTestApp({ db, access: approvedAccess({ status: 'requested' }) });
    for (const [method, path] of [
      ['GET', '/v1/reach/campaigns'],
      ['POST', '/v1/reach/campaigns/rcmp_x/launch'],
      ['GET', '/v1/reach/threads/a%40b.c'],
      ['POST', '/v1/reach/threads/a%40b.c/reply'],
      ['GET', '/v1/reach/nothing-here'],
    ] as const) {
      const res = await app.send<ErrorBody>(method, path, method === 'POST' ? {} : undefined);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code).toBe('APP_ACCESS_REQUIRED');
    }
  });

  it('answers before the scope check: a key with no reach scope still learns the workspace is not approved', async () => {
    const app = reachTestApp({ db, scopes: [], access: approvedAccess({ status: 'suspended' }) });
    const res = await app.get<ErrorBody>('/v1/reach/campaigns');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('APP_ACCESS_REQUIRED');
  });

  it('is a plain scope error once the workspace is approved', async () => {
    const app = reachTestApp({ db, scopes: [] });
    const res = await app.get<ErrorBody>('/v1/reach/campaigns');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Missing required scope: reach_campaigns:read' });
  });

  it('refuses a workspace without a Clerk org, which cannot have been approved', async () => {
    const app = reachTestApp({ db, session: { clerkOrgId: null } });
    const res = await app.get<ErrorBody>('/v1/reach/overview');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'APP_ACCESS_REQUIRED', details: { appCode: 'weldreach', status: 'none' } });
  });

  it('answers 401 without a session', async () => {
    const { request } = createExternalTestApp({ session: null, tenantDb: db });
    expect((await request('/v1/reach/overview')).status).toBe(401);
  });

  it('fails closed: when the access cannot be read, the request is an error, never a pass', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Nothing cached and a master DB nobody listens on.
    const app = reachTestApp({
      db,
      access: null,
      env: { HYPERDRIVE_MASTER: { connectionString: 'postgres://nobody:nothing@127.0.0.1:1/master' } as Hyperdrive },
    });
    const res = await app.get<ErrorBody>('/v1/reach/overview');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  }, 20_000);

  it('applies the partner licence: a workspace not licensed for weldreach gets APP_NOT_LICENSED', async () => {
    const unlicensed = reachTestApp({ db, session: { licensedApps: ['weldcrm'] } });
    const res = await unlicensed.get<ErrorBody>('/v1/reach/overview');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'APP_NOT_LICENSED', details: { app: 'weldreach' } });

    const licensed = reachTestApp({ db, session: { licensedApps: ['weldreach'] } });
    expect((await licensed.get('/v1/reach/overview')).status).toBe(200);
  });

  it('keeps a read-only workspace read-only', async () => {
    const app = reachTestApp({ db, session: { readOnly: true, readOnlyReason: 'licence_inactive' } });
    expect((await app.get('/v1/reach/overview')).status).toBe(200);
    const write = await app.send<ErrorBody>('POST', '/v1/reach/campaigns', { name: 'Nope' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('WORKSPACE_READ_ONLY');
  });
});

/** Every endpoint and the scope that opens it. A body is sent where the route validates one, so a pass shows as 400/404, never 403. */
const ENDPOINTS: Array<[method: string, path: string, scope: string]> = [
  ['GET', '/v1/reach/access', 'reach_campaigns:read'],
  ['GET', '/v1/reach/overview', 'reach_campaigns:read'],
  ['GET', '/v1/reach/campaigns', 'reach_campaigns:read'],
  ['POST', '/v1/reach/campaigns', 'reach_campaigns:write'],
  ['GET', '/v1/reach/campaigns/rcmp_x', 'reach_campaigns:read'],
  ['PATCH', '/v1/reach/campaigns/rcmp_x', 'reach_campaigns:write'],
  ['DELETE', '/v1/reach/campaigns/rcmp_x', 'reach_campaigns:write'],
  ['PUT', '/v1/reach/campaigns/rcmp_x/steps', 'reach_campaigns:write'],
  ['PUT', '/v1/reach/campaigns/rcmp_x/mailboxes', 'reach_campaigns:write'],
  ['POST', '/v1/reach/campaigns/rcmp_x/prospects', 'reach_campaigns:write'],
  ['GET', '/v1/reach/campaigns/rcmp_x/enrollments', 'reach_campaigns:read'],
  ['DELETE', '/v1/reach/campaigns/rcmp_x/enrollments/renr_x', 'reach_campaigns:write'],
  ['POST', '/v1/reach/campaigns/rcmp_x/launch', 'reach_campaigns:write'],
  ['POST', '/v1/reach/campaigns/rcmp_x/pause', 'reach_campaigns:write'],
  ['POST', '/v1/reach/campaigns/rcmp_x/resume', 'reach_campaigns:write'],
  ['GET', '/v1/reach/campaigns/rcmp_x/stats', 'reach_campaigns:read'],
  ['GET', '/v1/reach/prospects', 'reach_prospects:read'],
  ['POST', '/v1/reach/prospects', 'reach_prospects:write'],
  ['POST', '/v1/reach/prospects/import', 'reach_prospects:write'],
  ['GET', '/v1/reach/prospects/rpro_x', 'reach_prospects:read'],
  ['PATCH', '/v1/reach/prospects/rpro_x', 'reach_prospects:write'],
  ['DELETE', '/v1/reach/prospects/rpro_x', 'reach_prospects:write'],
  ['GET', '/v1/reach/lists', 'reach_prospects:read'],
  ['POST', '/v1/reach/lists', 'reach_prospects:write'],
  ['GET', '/v1/reach/lists/rpl_x', 'reach_prospects:read'],
  ['PATCH', '/v1/reach/lists/rpl_x', 'reach_prospects:write'],
  ['DELETE', '/v1/reach/lists/rpl_x', 'reach_prospects:write'],
  ['POST', '/v1/reach/lists/rpl_x/members', 'reach_prospects:write'],
  ['POST', '/v1/reach/lists/rpl_x/members/remove', 'reach_prospects:write'],
  ['GET', '/v1/reach/suppressions', 'reach_settings:read'],
  ['POST', '/v1/reach/suppressions', 'reach_settings:write'],
  ['DELETE', '/v1/reach/suppressions/rsup_x', 'reach_settings:write'],
  ['GET', '/v1/reach/threads', 'reach_inbox:read'],
  ['GET', '/v1/reach/threads/thread%40getacme.com', 'reach_inbox:read'],
  ['POST', '/v1/reach/threads/thread%40getacme.com/reply', 'reach_inbox:reply'],
  ['GET', '/v1/reach/mailboxes', 'reach_mailboxes:read'],
  ['GET', '/v1/reach/mailboxes/rmbx_x', 'reach_mailboxes:read'],
  ['GET', '/v1/reach/domains', 'reach_mailboxes:read'],
  ['GET', '/v1/reach/domains/rdom_x', 'reach_mailboxes:read'],
];

describe('scopes', () => {
  it('covers the endpoints of the plan, and only the six scope objects', () => {
    expect(ENDPOINTS).toHaveLength(39);
    expect([...new Set(ENDPOINTS.map(([, , scope]) => scope))].sort()).toEqual([
      'reach_campaigns:read',
      'reach_campaigns:write',
      'reach_inbox:read',
      'reach_inbox:reply',
      'reach_mailboxes:read',
      'reach_prospects:read',
      'reach_prospects:write',
      'reach_settings:read',
      'reach_settings:write',
    ]);
  });

  describe.each(ENDPOINTS)('%s %s', (method, path, scope) => {
    const body = method === 'GET' || method === 'DELETE' ? undefined : {};

    it(`needs ${scope}: 403 with every other scope, including the named-only one`, async () => {
      const others = [...REACH_SCOPES, 'reach_inbox:reply'].filter((s) => s !== scope);
      const app = reachTestApp({ db, scopes: others });
      const res = await app.send<ErrorBody>(method, path, body);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: `Missing required scope: ${scope}` });
    });

    it(`is open to a key that holds just ${scope}`, async () => {
      const app = reachTestApp({ db, scopes: [scope] });
      const res = await app.send(method, path, body);
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  });
});

describe('reach_inbox:reply is named only', () => {
  it('is not granted by `*` or `reach_inbox:*`, and is by its own name', () => {
    expect(NAMED_ONLY_SCOPES.has('reach_inbox:reply')).toBe(true);
    expect(hasScope(['*'], 'reach_inbox:reply')).toBe(false);
    expect(hasScope(['reach_inbox:*'], 'reach_inbox:reply')).toBe(false);
    expect(hasScope(['*', 'reach_inbox:read'], 'reach_inbox:reply')).toBe(false);
    expect(hasScope(['reach_inbox:reply'], 'reach_inbox:reply')).toBe(true);
    // The wildcards still cover everything else of the object.
    expect(hasScope(['reach_inbox:*'], 'reach_inbox:read')).toBe(true);
    expect(hasScope(['*'], 'reach_inbox:read')).toBe(true);
  });

  it.each([['*'], ['reach_inbox:*'], ['*', 'reach_inbox:*', 'reach_inbox:read']])('refuses a reply for a key holding %j', async (...scopes) => {
    const app = reachTestApp({ db, scopes });
    const res = await app.send<ErrorBody>('POST', '/v1/reach/threads/thread%40getacme.com/reply', { body: 'Hello' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Missing required scope: reach_inbox:reply' });
  });

  it('lets a key that holds it by name reach the thread lookup', async () => {
    const app = reachTestApp({ db, scopes: ['reach_inbox:reply'] });
    const res = await app.send<ErrorBody>('POST', '/v1/reach/threads/thread%40getacme.com/reply', { body: 'Hello' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /v1', () => {
  it('lists the reach endpoints', async () => {
    const { request } = createExternalTestApp({ scopes: ['*'], tenantDb: db });
    const res = await request('/v1');
    const body = (await res.json()) as { data: { endpoints: string[] } };
    for (const endpoint of [
      'access',
      'campaigns',
      'domains',
      'lists',
      'mailboxes',
      'overview',
      'prospects',
      'suppressions',
      'threads',
    ]) {
      expect(body.data.endpoints).toContain(`/v1/reach/${endpoint}`);
    }
  });
});

describe('the access cache', () => {
  it('reads the entry reach-api shares, keyed by the Clerk org id (not the master workspace id)', async () => {
    const keys: string[] = [];
    const cache = {
      get: async (key: string) => {
        keys.push(key);
        return approvedAccess();
      },
      put: async () => undefined,
    } as unknown as KVNamespace;
    const app = reachTestApp({ db, env: { WORKSPACE_CACHE: cache } });

    expect((await app.get('/v1/reach/overview')).status).toBe(200);
    expect(keys).toEqual([`appaccess:${ORG_ID}:weldreach`]);
  });
});
