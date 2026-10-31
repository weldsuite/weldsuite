/**
 * POST /api/visitor on pglite: anonymous visitors keep their token, an
 * identity token makes a verified visitor, signing out on the customer's
 * site drops back to a fresh anonymous visitor, legacy ids are swapped once,
 * and "identity required" refuses everyone else. Then the visitor token is
 * what the conversation routes trust (visitorAuthMiddleware).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import * as schema from '@weldsuite/db/schema';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import type { DeskWidgetSettings } from '@weldsuite/db/schema/desk-widget-settings';
import type { Env, Variables } from '../index';
import { signJwt } from '../lib/tokens';
import { issueVisitorToken } from '../lib/visitor-identity';
import { visitorAuthMiddleware } from '../middleware/visitor-auth';

vi.setConfig({ testTimeout: 60_000 });

vi.mock('../lib/desk-live', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/desk-live')>()),
  publishConversationUpdated: vi.fn(() => Promise.resolve()),
}));

import { visitorRoutes } from './visitor';

const SECRET = 'worker-secret';
const IDENTITY_SECRET = 'site-secret';
const WIDGET = 'widget_visitor_test';
const WORKSPACE = 'ws_visitor_test';

type Db = Awaited<ReturnType<typeof createPgliteDb>>['db'];
let db: Db;
const env = { WIDGET_TOKEN_SECRET: SECRET, WORKSPACE_CACHE: createMemoryKv() } as unknown as Env;

function app(config: Partial<DeskWidgetSettings> = {}) {
  const root = new Hono<{ Bindings: Env; Variables: Variables }>();
  root.use('*', async (c, next) => {
    c.set('tenantDb', db as unknown as Variables['tenantDb']);
    c.set('workspaceId', WORKSPACE);
    c.set('clerkOrgId', 'org_visitor_test');
    c.set('widgetId', WIDGET);
    c.set('widgetConfig', { identitySecret: IDENTITY_SECRET, identityRequired: false, ...config } as DeskWidgetSettings);
    await next();
  });
  root.route('/api/visitor', visitorRoutes);
  root.use('/api/whoami', visitorAuthMiddleware());
  root.get('/api/whoami', (c) => c.json(c.get('principal')));
  return root;
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function session(body: Record<string, unknown>, config?: Partial<DeskWidgetSettings>) {
  const res = await app(config).request(
    '/api/visitor',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
    ctx,
  );
  return { status: res.status, body: (await res.json()) as { data?: any; error?: { code: string } } };
}

async function whoami(token: string, config?: Partial<DeskWidgetSettings>) {
  const res = await app(config).request('/api/whoami', { headers: { Authorization: `Bearer ${token}` } }, env, ctx);
  return { status: res.status, body: (await res.json()) as any };
}

const identity = (claims: Record<string, unknown>) =>
  signJwt(IDENTITY_SECRET, { exp: Math.floor(Date.now() / 1000) + 3600, ...claims });

beforeAll(async () => {
  db = (await createPgliteDb()).db;
});

describe('POST /api/visitor', () => {
  it('makes a new anonymous visitor, and keeps it for the token it handed out', async () => {
    const first = await session({});
    expect(first.status).toBe(200);
    expect(first.body.data.visitor).toMatchObject({ verified: false, email: null });
    expect(first.body.data.visitor.id).toMatch(/^dvis_/);

    const again = await session({ visitorToken: first.body.data.visitorToken });
    expect(again.body.data.visitor.id).toBe(first.body.data.visitor.id);
  });

  it('ignores a token of another widget', async () => {
    const foreign = await issueVisitorToken(SECRET, { visitorId: 'dvis_x', workspaceId: WORKSPACE, widgetId: 'other' });
    const result = await session({ visitorToken: foreign });
    expect(result.body.data.visitor.id).not.toBe('dvis_x');
  });

  it('verifies a visitor the site vouched for, one visitor per user id', async () => {
    const first = await session({ identityToken: await identity({ sub: 'u-1', email: 'Ada@Site.test', name: 'Ada' }) });
    expect(first.body.data.visitor).toMatchObject({ verified: true, email: 'ada@site.test', name: 'Ada' });
    const again = await session({ identityToken: await identity({ sub: 'u-1', email: 'ada@site.test' }) });
    expect(again.body.data.visitor.id).toBe(first.body.data.visitor.id);

    const principal = await whoami(again.body.data.visitorToken);
    expect(principal.body).toEqual({ visitorId: first.body.data.visitor.id, verifiedEmail: 'ada@site.test' });
  });

  it('refuses a forged identity token', async () => {
    const forged = await signJwt('guessed-secret', { sub: 'u-1', email: 'ada@site.test', exp: Math.floor(Date.now() / 1000) + 60 });
    const result = await session({ identityToken: forged });
    expect(result.status).toBe(401);
    expect(result.body.error?.code).toBe('IDENTITY_INVALID');
  });

  it('starts over anonymously once the user signed out on the site', async () => {
    const signedIn = await session({ identityToken: await identity({ sub: 'u-2', email: 'bo@site.test' }) });
    const signedOut = await session({ visitorToken: signedIn.body.data.visitorToken });
    expect(signedOut.body.data.visitor.id).not.toBe(signedIn.body.data.visitor.id);
    expect(signedOut.body.data.visitor.verified).toBe(false);
  });

  it('swaps an existing browser-made id for a token, once', async () => {
    const now = new Date();
    await db.insert(schema.deskVisitors).values({ id: 'visitor_1700_legacy', createdAt: now, updatedAt: now, lastSeenAt: now, widgetId: WIDGET });
    const swapped = await session({ legacyVisitorId: 'visitor_1700_legacy' });
    expect(swapped.body.data.visitor.id).toBe('visitor_1700_legacy');
    const twice = await session({ legacyVisitorId: 'visitor_1700_legacy' });
    expect(twice.body.data.visitor.id).not.toBe('visitor_1700_legacy');
    const madeUp = await session({ legacyVisitorId: 'visitor_never_seen' });
    expect(madeUp.body.data.visitor.id).not.toBe('visitor_never_seen');
  });

  it('refuses anonymous visitors when identity is required', async () => {
    const anonymous = await session({});
    const refused = await session({ visitorToken: anonymous.body.data.visitorToken }, { identityRequired: true });
    expect(refused.status).toBe(401);
    expect(refused.body.error?.code).toBe('IDENTITY_REQUIRED');
    expect((await whoami(anonymous.body.data.visitorToken, { identityRequired: true })).status).toBe(401);

    const identified = await session({ identityToken: await identity({ sub: 'u-3' }) }, { identityRequired: true });
    expect(identified.status).toBe(200);
  });
});

describe('visitorAuthMiddleware', () => {
  it('needs a token, and one of ours', async () => {
    const res = await app().request('/api/whoami', {}, env, ctx);
    expect(res.status).toBe(401);
    expect((await whoami('not.a.token')).status).toBe(401);
    expect((await whoami(await issueVisitorToken('other-secret', { visitorId: 'dvis_1', workspaceId: WORKSPACE, widgetId: WIDGET }))).status).toBe(401);
  });
});
