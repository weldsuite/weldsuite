/**
 * POST /api/visitor and the visitor token on pglite (ADR DESK-010): who a
 * widget visitor is, and what that lets them see.
 *
 * - An anonymous visitor gets a new row and a token; the same browser keeps
 *   its row by sending the token back.
 * - An identity token the customer's server signed with the widget's identity
 *   secret makes a verified visitor: one row per (widget, user id), its email
 *   proven. Its visitor token ends with the identity token and carries a
 *   fingerprint of the secret, so rotating the secret ends the session.
 * - A token of an identified visitor without its identity token is a user who
 *   signed out on the customer's site: a new anonymous visitor.
 * - A browser-made id from before visitor tokens is swapped once (a KV marker).
 * - "Identity required" refuses everyone the customer's site did not vouch for.
 * - Every visitor route takes the visitor from the token (visitorAuthMiddleware).
 * - A verified visitor sees, and may write into, every conversation of that
 *   email: another verified visitor's (the help center's sign-in) and the
 *   email channel's. An email a visitor merely typed is never a key.
 *
 * The visitor token is an HS256 JWT whose `iat` is the second it was issued,
 * so the conformance harness masks it (conformance-volatile.ts); these tests
 * decode it and check every claim instead.
 */

import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as tenantSchema from '@weldsuite/db/schema';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  IDENTITY_SECRET,
  TOKEN_SECRET,
  WIDGET,
  WORKSPACE,
  addWidget,
  at,
  bearer,
  get,
  json,
  seedWorkspaces,
  startSession,
  visitorRow,
  visitorToken,
  widgetEnv,
  widgetHeaders,
  type VisitorSession,
} from '../test/widget-fixtures';

// Conformance mode runs every write on both backends, each on a fresh copy.
vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ master: null as unknown, tenant: null as unknown }));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getMasterDb: () => conformanceMasterDb(holder.master),
  getTenantDbForWorkspace: async () => conformanceTenantDb(holder.tenant),
  getWorkspaceForOrg: async () => ({ id: 'ws_acme' }),
}));

import worker from '../index';

const { deskConversations, deskVisitors, deskWidgetSettings } = tenantSchema;

const VISITOR = '/api/visitor';
const CONVERSATIONS = '/api/conversations';
/** Identity verification on, anonymous visitors still welcome. */
const ID_WIDGET = 'wdg_identity';
/** Identity verification required. */
const REQUIRED = 'wdg_required';
/** "Required" without a secret: means nothing. */
const REQUIRED_NO_SECRET = 'wdg_required_nosecret';
/** Another widget of the main workspace. */
const OTHER = 'wdg_other';
/** A widget whose identity secret the tests rotate. */
const ROTATING = 'wdg_rotating';

const DAY = 24 * 60 * 60;
const VISITOR_ID = /^dvis_[0-9a-z]{12,}$/;

let tenantDb: Database;
let masterDb: Database;
// One cache and one bucket for the whole file: the harness serves each to Rust once.
const cache = createMemoryKv();
const storage = createMemoryR2();

function app(env: Record<string, unknown> = {}) {
  return createTestApp('/', worker as never, {
    context: { tenantDb, masterDb, orgId: null, clerkOrgId: null },
    env: widgetEnv({ STORAGE: storage, ...env }),
    rustBasePath: '/public/helpdesk-widget',
  });
}

const call = (path: string, init?: RequestInit, env?: Record<string, unknown>) => app(env).request(path, init);
/** With the workspace cache bound, as a deployed worker has it (the legacy swap needs it). */
const withCache = (path: string, init?: RequestInit) => call(path, init, { WORKSPACE_CACHE: cache });

const post = (body: Record<string, unknown>, widgetId: string = WIDGET) => call(VISITOR, json(body, { widgetId }));
const listAs = (token: string, widgetId: string = WIDGET) => call(CONVERSATIONS, get(widgetId, bearer(token)));

const now = () => Math.floor(Date.now() / 1000);

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

/** An HS256 JWT as any server would sign it; the header can be changed to test the refusals. */
function sign(secret: string, claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }) {
  const head = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}

/** An identity token the customer's server signs: an hour of validity unless the claims say otherwise. */
const identity = (claims: Record<string, unknown>, secret = IDENTITY_SECRET) => sign(secret, { exp: now() + 3600, ...claims });

/** `deriveSecret(secret, label)`: the key for one purpose. */
const derive = (secret: string, label: string) => createHmac('sha256', secret).update(label).digest('base64url');
const VISITOR_KEY = derive(TOKEN_SECRET, 'weldsuite:desk-visitor-token:v1');
const fingerprint = (secret: string) => derive(secret, 'weldsuite:desk-identity-fingerprint:v1').slice(0, 16);

/** A visitor token's claims, after checking it is signed with the visitor key. */
function claimsOf(token: string) {
  const [header = '', payload = '', signature = ''] = token.split('.');
  expect(createHmac('sha256', VISITOR_KEY).update(`${header}.${payload}`).digest('base64url')).toBe(signature);
  expect(decode(header)).toEqual({ alg: 'HS256', typ: 'JWT' });
  return decode(payload);
}

const refusal = (status: number, code: string, message: string) => ({ status, body: { success: false, error: { code, message } } });
const tokenRequired = refusal(401, 'VISITOR_TOKEN_REQUIRED', 'Missing visitor token');
const tokenInvalid = refusal(401, 'VISITOR_TOKEN_INVALID', 'Invalid visitor token');
const identityRequired = refusal(401, 'IDENTITY_REQUIRED', 'This chat is only open to signed-in users');
const identityInvalid = (reason: string) => refusal(401, 'IDENTITY_INVALID', `Identity token refused (${reason})`);

async function answer(res: Response) {
  return { status: res.status, body: (await res.json()) as unknown };
}

async function session(body: Record<string, unknown>, widgetId: string = WIDGET): Promise<VisitorSession> {
  return startSession(call, body, widgetId);
}

async function visitor(id: string) {
  const [row] = await tenantDb.select().from(deskVisitors).where(eq(deskVisitors.id, id));
  return row;
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  holder.master = masterDb;
  holder.tenant = tenantDb;
  await seedWorkspaces(masterDb);
  await addWidget(masterDb, tenantDb, WIDGET);
  await addWidget(masterDb, tenantDb, OTHER);
  await addWidget(masterDb, tenantDb, 'wdg_white', { workspaceId: 'ws_white' });
  await addWidget(masterDb, tenantDb, ID_WIDGET, { settings: { identitySecret: IDENTITY_SECRET } });
  await addWidget(masterDb, tenantDb, REQUIRED, { settings: { identitySecret: IDENTITY_SECRET, identityRequired: true } });
  await addWidget(masterDb, tenantDb, REQUIRED_NO_SECRET, { settings: { identityRequired: true } });
  await addWidget(masterDb, tenantDb, ROTATING, { settings: { identitySecret: IDENTITY_SECRET } });

  await tenantDb.insert(deskVisitors).values([
    visitorRow('vis_kept'),
    visitorRow('vis_nowidget', { widgetId: null }),
    visitorRow('vis_required_anon', { widgetId: REQUIRED }),
    visitorRow('vis_rotating_anon', { widgetId: ROTATING }),
    // Browser-made ids from before visitor tokens.
    visitorRow('vis_legacy'),
    visitorRow('vis_legacy_2'),
    visitorRow('vis_legacy_nowidget', { widgetId: null }),
    visitorRow('vis_legacy_elsewhere', { widgetId: OTHER }),
    visitorRow('vis_legacy_identified', { externalId: 'user-legacy' }),
    visitorRow('vis_legacy_verified', { widgetId: null, email: 'v@site.test', verifiedEmail: 'v@site.test', verifiedAt: at(0) }),
  ]);
}, 120_000);

describe('POST /api/visitor: anonymous visitors', () => {
  it('makes a new anonymous visitor of the widget, with a year-long token for it', async () => {
    const before = now();
    const res = await post({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: true; data: VisitorSession };
    expect(body).toEqual({
      success: true,
      data: {
        visitorToken: expect.any(String),
        visitor: { id: expect.stringMatching(VISITOR_ID), name: null, email: null, verified: false },
      },
    });
    const { id } = body.data.visitor;
    expect(await visitor(id)).toMatchObject({ widgetId: WIDGET, externalId: null, verifiedEmail: null, name: null, email: null });

    const claims = claimsOf(body.data.visitorToken);
    expect(claims).toEqual({ aud: 'desk-visitor', sub: id, ws: WORKSPACE, wid: WIDGET, iat: expect.any(Number), exp: expect.any(Number) });
    const { iat, exp } = claims as { iat: number; exp: number };
    expect(exp - iat).toBe(365 * DAY);
    // Issued during the request (a minute either way: Rust and TypeScript each take their turn).
    expect(iat).toBeGreaterThanOrEqual(before - 60);
    expect(iat).toBeLessThanOrEqual(now() + 60);

    // The token is what the visitor routes want.
    const list = await listAs(body.data.visitorToken);
    expect(await answer(list)).toEqual({ status: 200, body: { success: true, data: [] } });
  });

  it('keeps the visitor of the token it handed out, and moves its last-seen time on', async () => {
    const kept = await session({ visitorToken: await visitorToken('vis_kept') });
    expect(kept.visitor).toEqual({ id: 'vis_kept', name: null, email: null, verified: false });
    expect(claimsOf(kept.visitorToken)).toMatchObject({ sub: 'vis_kept', ws: WORKSPACE, wid: WIDGET });
    const row = await visitor('vis_kept');
    expect(row!.lastSeenAt.getTime()).toBeGreaterThan(at(0).getTime());
    expect(row!.updatedAt.getTime()).toBeGreaterThan(at(0).getTime());

    // A fresh session through the route keeps its visitor the same way.
    const first = await session({});
    const again = await session({ visitorToken: first.visitorToken });
    expect(again.visitor.id).toBe(first.visitor.id);
  });

  it('gives a visitor without a widget the one it came back through', async () => {
    const kept = await session({ visitorToken: await visitorToken('vis_nowidget') });
    expect(kept.visitor.id).toBe('vis_nowidget');
    expect((await visitor('vis_nowidget'))!.widgetId).toBe(WIDGET);
  });

  it('makes a new visitor for a token that is not one of ours, or not for this widget and workspace', async () => {
    const past = now() - 3 * DAY;
    const tokens = [
      'not.a.token',
      'garbage',
      await visitorToken('vis_kept', { secret: 'another-worker-secret' }),
      await visitorToken('vis_kept', { widgetId: OTHER }),
      await visitorToken('vis_kept', { workspaceId: 'ws_white' }),
      await visitorToken('vis_kept', { now: past, expiresAt: past + DAY }),
      await visitorToken('vis_gone'),
      // A realtime token is signed with the worker secret itself, not the visitor key.
      sign(TOKEN_SECRET, { aud: 'desk-visitor', sub: 'vis_kept', ws: WORKSPACE, wid: WIDGET, exp: now() + 60 }),
      // The visitor key, but not a visitor token.
      sign(VISITOR_KEY, { aud: 'something-else', sub: 'vis_kept', ws: WORKSPACE, wid: WIDGET, exp: now() + 60 }),
      sign(VISITOR_KEY, { aud: 'desk-visitor', sub: 'vis_kept', ws: WORKSPACE, wid: WIDGET }),
    ];
    const ids = new Set<string>();
    for (const token of tokens) {
      const result = await session({ visitorToken: token });
      expect(result.visitor.id, token).toMatch(VISITOR_ID);
      expect(result.visitor.verified, token).toBe(false);
      ids.add(result.visitor.id);
    }
    expect(ids.size).toBe(tokens.length);
  });

  it('refuses a body of the wrong shape, before anything else', async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [
        { visitorToken: '' },
        {
          code: 'too_small',
          minimum: 1,
          type: 'string',
          inclusive: true,
          exact: false,
          message: 'String must contain at least 1 character(s)',
          path: ['visitorToken'],
        },
      ],
      [
        { legacyVisitorId: 'a'.repeat(65) },
        {
          code: 'too_big',
          maximum: 64,
          type: 'string',
          inclusive: true,
          exact: false,
          message: 'String must contain at most 64 character(s)',
          path: ['legacyVisitorId'],
        },
      ],
      [
        { identityToken: 42 },
        { code: 'invalid_type', expected: 'string', received: 'number', path: ['identityToken'], message: 'Expected string, received number' },
      ],
    ];
    for (const [payload, issue] of cases) {
      for (const env of [{}, { WIDGET_TOKEN_SECRET: undefined }]) {
        const res = await call(VISITOR, json(payload), env);
        expect(res.status, JSON.stringify(payload)).toBe(400);
        expect(await res.json(), JSON.stringify(payload)).toEqual({ success: false, error: { issues: [issue], name: 'ZodError' } });
      }
    }
  });

  it('is a 500 when the worker has no token secret', async () => {
    const res = await call(VISITOR, json({}), { WIDGET_TOKEN_SECRET: undefined });
    expect(await answer(res)).toEqual(refusal(500, 'INTERNAL_ERROR', 'WIDGET_TOKEN_SECRET not configured'));
  });
});

describe('POST /api/visitor: verified visitors', () => {
  it('verifies a user the site vouched for: one visitor per user id, the email proven', async () => {
    const exp = now() + 3600;
    const ada = await session(
      { identityToken: identity({ sub: 'user-ada', email: '  Ada@Site.TEST ', name: '  Ada Lovelace  ', exp }) },
      ID_WIDGET,
    );
    expect(ada.visitor).toEqual({ id: expect.stringMatching(VISITOR_ID), name: 'Ada Lovelace', email: 'ada@site.test', verified: true });
    const row = await visitor(ada.visitor.id);
    expect(row).toMatchObject({
      widgetId: ID_WIDGET,
      externalId: 'user-ada',
      name: 'Ada Lovelace',
      email: 'ada@site.test',
      verifiedEmail: 'ada@site.test',
    });
    expect(row!.verifiedAt).toBeInstanceOf(Date);

    // The token ends with the identity token and names the secret it was issued under.
    expect(claimsOf(ada.visitorToken)).toEqual({
      aud: 'desk-visitor',
      sub: ada.visitor.id,
      ws: WORKSPACE,
      wid: ID_WIDGET,
      sfp: fingerprint(IDENTITY_SECRET),
      iat: expect.any(Number),
      exp,
    });

    // The same user again: the same visitor, with what the site says now.
    const again = await session({ identityToken: identity({ sub: 'user-ada', email: 'ada@new.test' }) }, ID_WIDGET);
    expect(again.visitor).toEqual({ id: ada.visitor.id, name: 'Ada Lovelace', email: 'ada@new.test', verified: true });
    const moved = await visitor(ada.visitor.id);
    expect(moved).toMatchObject({ email: 'ada@new.test', verifiedEmail: 'ada@new.test' });
    expect(moved!.verifiedAt!.getTime()).toBeGreaterThanOrEqual(row!.verifiedAt!.getTime());

    // Without an email the user is still theirs, just no longer verified.
    const plain = await session({ identityToken: identity({ sub: 'user-ada' }) }, ID_WIDGET);
    expect(plain.visitor).toEqual({ id: ada.visitor.id, name: 'Ada Lovelace', email: 'ada@new.test', verified: false });
    expect(await visitor(ada.visitor.id)).toMatchObject({ email: 'ada@new.test', verifiedEmail: null });
  });

  it('takes a numeric user id, and keeps users of two widgets apart', async () => {
    const numeric = await session({ identityToken: identity({ sub: 42, email: 'n@site.test' }) }, ID_WIDGET);
    expect((await visitor(numeric.visitor.id))!.externalId).toBe('42');
    const elsewhere = await session({ identityToken: identity({ sub: 42, email: 'n@site.test' }) }, ROTATING);
    expect(elsewhere.visitor.id).not.toBe(numeric.visitor.id);
    expect(await visitor(elsewhere.visitor.id)).toMatchObject({ widgetId: ROTATING, externalId: '42' });
  });

  it('trims the name and cuts it at 255 characters, and ignores one that is not text', async () => {
    const long = await session({ identityToken: identity({ sub: 'user-long', name: `  ${'n'.repeat(300)}` }) }, ID_WIDGET);
    expect(long.visitor.name).toBe('n'.repeat(255));
    const odd = await session({ identityToken: identity({ sub: 'user-odd', name: 42 }) }, ID_WIDGET);
    expect(odd.visitor.name).toBeNull();
  });

  it('refuses an identity token it cannot trust, naming why', async () => {
    const cases: Array<[string, string]> = [
      ['not-a-jwt', 'malformed'],
      ['a.b', 'malformed'],
      ['a!.b.c', 'malformed'],
      [sign(IDENTITY_SECRET, { sub: 'u', exp: now() + 60 }, { alg: 'none' }), 'algorithm'],
      [`${b64('[]')}.${b64('{}')}.xx`, 'algorithm'],
      [identity({ sub: 'u' }, 'another-site-secret'), 'signature'],
      [identity({ sub: 'u', exp: now() - 120 }), 'expired'],
      [identity({ sub: 'u', nbf: now() + 3600 }), 'not_yet_valid'],
      [sign(IDENTITY_SECRET, { sub: 'u' }), 'claims'],
      [identity({ email: 'a@site.test' }), 'claims'],
      [identity({ sub: '   ' }), 'claims'],
      [identity({ sub: 'x'.repeat(256) }), 'claims'],
      [identity({ sub: true }), 'claims'],
      [identity({ sub: 'u', exp: now() + 31 * DAY }), 'claims'],
      [identity({ sub: 'u', email: 'not-an-email' }), 'claims'],
      [identity({ sub: 'u', email: 'two@at@site.test' }), 'claims'],
      [identity({ sub: 'u', email: 'sp ace@site.test' }), 'claims'],
      [identity({ sub: 'u', email: 'a@site.' }), 'claims'],
      [identity({ sub: 'u', email: 'a@.site' }), 'claims'],
      [identity({ sub: 'u', email: 42 }), 'claims'],
    ];
    for (const [token, reason] of cases) {
      expect(await answer(await post({ identityToken: token }, ID_WIDGET)), token).toEqual(identityInvalid(reason));
    }
    expect(await tenantDb.select().from(deskVisitors).where(eq(deskVisitors.externalId, 'u'))).toEqual([]);
  });

  it('is a 400 for an identity token on a widget without identity verification', async () => {
    const res = await post({ identityToken: identity({ sub: 'user-ada' }) });
    expect(await answer(res)).toEqual(refusal(400, 'BAD_REQUEST', 'Identity verification is not set up for this widget'));
  });

  it('puts the proven contact on the conversations the user started before', async () => {
    const before = await session({ identityToken: identity({ sub: 'user-attach' }) }, ID_WIDGET);
    const started = await call(CONVERSATIONS, json({ body: 'Hi there' }, { widgetId: ID_WIDGET, token: before.visitorToken }));
    expect(started.status).toBe(201);
    const { id } = ((await started.json()) as { data: { conversation: { id: string } } }).data.conversation;
    expect((await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, id)))[0]).toMatchObject({
      name: null,
      email: null,
    });

    await session({ identityToken: identity({ sub: 'user-attach', email: 'Att@Site.test', name: 'Atti' }) }, ID_WIDGET);
    const [row] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, id));
    expect(row).toMatchObject({ name: 'Atti', email: 'att@site.test' });
  });
});

describe('POST /api/visitor: signing out, and ids from before visitor tokens', () => {
  it('treats the token of an identified visitor without its identity token as a user who signed out', async () => {
    const signedIn = await session({ identityToken: identity({ sub: 'user-out', email: 'out@site.test' }) }, ID_WIDGET);
    const out = await session({ visitorToken: signedIn.visitorToken }, ID_WIDGET);
    expect(out.visitor).toEqual({ id: expect.stringMatching(VISITOR_ID), name: null, email: null, verified: false });
    expect(out.visitor.id).not.toBe(signedIn.visitor.id);
    expect(claimsOf(out.visitorToken)).not.toHaveProperty('sfp');
  });

  it('swaps a browser-made id for a token once, for its existing anonymous visitor', async () => {
    const first = await withCache(VISITOR, json({ legacyVisitorId: 'vis_legacy' }));
    expect(first.status).toBe(200);
    const swapped = ((await first.json()) as { data: VisitorSession }).data;
    expect(swapped.visitor.id).toBe('vis_legacy');
    expect(claimsOf(swapped.visitorToken)).toMatchObject({ sub: 'vis_legacy', wid: WIDGET });
    expect(cache.store.get(`dvis:legacy:${WORKSPACE}:vis_legacy`)).toEqual(expect.any(String));

    // The id is spent: a second try gets a new visitor.
    const second = await withCache(VISITOR, json({ legacyVisitorId: 'vis_legacy' }));
    const replayed = ((await second.json()) as { data: VisitorSession }).data;
    expect(replayed.visitor.id).toMatch(VISITOR_ID);

    // A visitor that never had a widget takes this one.
    const bare = await withCache(VISITOR, json({ legacyVisitorId: 'vis_legacy_nowidget' }));
    expect(((await bare.json()) as { data: VisitorSession }).data.visitor.id).toBe('vis_legacy_nowidget');
    expect((await visitor('vis_legacy_nowidget'))!.widgetId).toBe(WIDGET);
  });

  it('never swaps the id of another widget’s, an identified, a verified or an unknown visitor', async () => {
    for (const id of ['vis_legacy_elsewhere', 'vis_legacy_identified', 'vis_legacy_verified', 'vis_unknown']) {
      const res = await withCache(VISITOR, json({ legacyVisitorId: id }));
      expect(res.status, id).toBe(200);
      const { visitor: given } = ((await res.json()) as { data: VisitorSession }).data;
      expect(given.id, id).toMatch(VISITOR_ID);
      expect(cache.store.has(`dvis:legacy:${WORKSPACE}:${id}`), id).toBe(false);
    }
  });

  it('keeps the visitor of a good token before it looks at a legacy id', async () => {
    const res = await withCache(VISITOR, json({ visitorToken: await visitorToken('vis_kept'), legacyVisitorId: 'vis_legacy_2' }));
    expect(((await res.json()) as { data: VisitorSession }).data.visitor.id).toBe('vis_kept');
    expect(cache.store.has(`dvis:legacy:${WORKSPACE}:vis_legacy_2`)).toBe(false);
  });
});

describe('identity required', () => {
  it('refuses a visitor the site did not vouch for, however they come', async () => {
    for (const body of [{}, { visitorToken: await visitorToken('vis_required_anon', { widgetId: REQUIRED }) }, { legacyVisitorId: 'vis_legacy_2' }]) {
      expect(await answer(await post(body, REQUIRED)), JSON.stringify(body)).toEqual(identityRequired);
    }
    // And an anonymous visitor's token no longer opens the visitor routes.
    const anon = await visitorToken('vis_required_anon', { widgetId: REQUIRED });
    expect(await answer(await listAs(anon, REQUIRED))).toEqual(identityRequired);
  });

  it('lets a verified user in', async () => {
    const signedIn = await session({ identityToken: identity({ sub: 'user-req', email: 'req@site.test' }) }, REQUIRED);
    expect(signedIn.visitor.verified).toBe(true);
    expect(await answer(await listAs(signedIn.visitorToken, REQUIRED))).toEqual({ status: 200, body: { success: true, data: [] } });
  });

  it('means nothing without an identity secret', async () => {
    const anon = await session({}, REQUIRED_NO_SECRET);
    expect(anon.visitor.verified).toBe(false);
    expect((await listAs(anon.visitorToken, REQUIRED_NO_SECRET)).status).toBe(200);
  });
});

describe('visitor auth', () => {
  it('needs a bearer token', async () => {
    for (const headers of [{}, { Authorization: 'Basic dmlzOnZpcw==' }, { Authorization: 'Bearer' }, { Authorization: 'Bearer a b' }] as Array<Record<string, string>>) {
      const res = await call(CONVERSATIONS, get(WIDGET, headers));
      expect(await answer(res), JSON.stringify(headers)).toEqual(tokenRequired);
    }
    // The scheme is case-insensitive.
    const ok = await call(CONVERSATIONS, get(WIDGET, { Authorization: `bearer ${await visitorToken('vis_kept')}` }));
    expect(ok.status).toBe(200);
  });

  it('refuses a token that is not ours, or is for another widget or workspace, or names no visitor', async () => {
    const tokens = [
      'not.a.token',
      await visitorToken('vis_kept', { secret: 'another-worker-secret' }),
      await visitorToken('vis_kept', { widgetId: OTHER }),
      await visitorToken('vis_kept', { workspaceId: 'ws_white' }),
      await visitorToken('vis_kept', { now: now() - 3 * DAY, expiresAt: now() - 2 * DAY }),
      await visitorToken('vis_gone'),
      sign(TOKEN_SECRET, { aud: 'desk-visitor', sub: 'vis_kept', ws: WORKSPACE, wid: WIDGET, exp: now() + 60 }),
      sign(VISITOR_KEY, { aud: 'something-else', sub: 'vis_kept', ws: WORKSPACE, wid: WIDGET, exp: now() + 60 }),
    ];
    for (const token of tokens) {
      expect(await answer(await listAs(token)), token).toEqual(tokenInvalid);
    }
    // A token for another workspace's widget, at that widget: the visitor is in another tenant.
    const white = await visitorToken('vis_kept', { workspaceId: 'ws_white', widgetId: 'wdg_white' });
    expect((await listAs(white, 'wdg_white')).status).toBe(200);
  });

  it('ends identified sessions when the identity secret is rotated or removed, and leaves anonymous ones alone', async () => {
    const signedIn = await session({ identityToken: identity({ sub: 'user-rot', email: 'rot@site.test' }) }, ROTATING);
    const anon = await visitorToken('vis_rotating_anon', { widgetId: ROTATING });
    expect((await listAs(signedIn.visitorToken, ROTATING)).status).toBe(200);
    try {
      for (const identitySecret of ['a-rotated-secret', null]) {
        await tenantDb.update(deskWidgetSettings).set({ identitySecret }).where(eq(deskWidgetSettings.widgetId, ROTATING));
        expect(await answer(await listAs(signedIn.visitorToken, ROTATING)), String(identitySecret)).toEqual(tokenInvalid);
        expect((await listAs(anon, ROTATING)).status, String(identitySecret)).toBe(200);
      }
    } finally {
      await tenantDb
        .update(deskWidgetSettings)
        .set({ identitySecret: IDENTITY_SECRET })
        .where(eq(deskWidgetSettings.widgetId, ROTATING));
    }
    expect((await listAs(signedIn.visitorToken, ROTATING)).status).toBe(200);
  });
});

describe('a verified visitor’s conversations', () => {
  /** Pat, signed in through the customer's site. */
  let pat: VisitorSession;
  /** Somebody who typed Pat's address into the widget. */
  let typed: string;

  beforeAll(async () => {
    const conversation = (id: string, number: number, values: Partial<typeof deskConversations.$inferInsert>) =>
      tenantDb.insert(deskConversations).values({
        id,
        conversationNumber: number,
        title: id,
        state: 'open',
        channel: 'messenger',
        waitingSince: at(1),
        createdAt: at(0),
        updatedAt: at(0),
        lastMessageAt: at(number - 900),
        lastMessagePreview: id,
        ...values,
      });
    await tenantDb.insert(deskVisitors).values([
      // Pat, signed in on the help center with an email code.
      visitorRow('vis_pat_portal', { widgetId: null, email: 'pat@site.test', verifiedEmail: 'pat@site.test', verifiedAt: at(0) }),
      // Somebody else who typed Pat's address into the widget.
      visitorRow('vis_pat_typed', { email: 'pat@site.test' }),
    ]);
    await conversation('dconv_pat_portal', 901, { visitorId: 'vis_pat_portal', channel: 'portal', email: 'pat@site.test' });
    await conversation('dconv_pat_closed', 902, { visitorId: 'vis_pat_portal', channel: 'portal', state: 'closed', waitingSince: null });
    await conversation('dconv_pat_email', 903, { visitorId: null, channel: 'email', email: 'Pat@Site.TEST' });
    await conversation('dconv_pat_other_email', 904, { visitorId: null, channel: 'email', email: 'someone@else.test' });
    await conversation('dconv_pat_typed', 905, { visitorId: 'vis_pat_typed', email: 'pat@site.test' });

    pat = await session({ identityToken: identity({ sub: 'user-pat', email: 'PAT@site.test', name: 'Pat' }) }, ID_WIDGET);
    typed = await visitorToken('vis_pat_typed');
  });

  const ids = async (res: Response) => ((await res.json()) as { data: Array<{ id: string }> }).data.map((c) => c.id);

  it('lists every conversation of the proven email, and none an address was merely typed into', async () => {
    const res = await listAs(pat.visitorToken, ID_WIDGET);
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual(['dconv_pat_email', 'dconv_pat_closed', 'dconv_pat_portal']);

    expect(await ids(await listAs(typed))).toEqual(['dconv_pat_typed']);
  });

  it('opens them, and only them', async () => {
    for (const id of ['dconv_pat_portal', 'dconv_pat_email']) {
      const res = await call(`${CONVERSATIONS}/${id}`, get(ID_WIDGET, bearer(pat.visitorToken)));
      expect(res.status, id).toBe(200);
      expect(((await res.json()) as { data: { conversation: { id: string } } }).data.conversation.id, id).toBe(id);
    }
    for (const id of ['dconv_pat_typed', 'dconv_pat_other_email']) {
      const res = await call(`${CONVERSATIONS}/${id}`, get(ID_WIDGET, bearer(pat.visitorToken)));
      expect(res.status, id).toBe(404);
    }
    // The visitor who typed the address sees none of Pat's.
    for (const id of ['dconv_pat_portal', 'dconv_pat_email']) {
      expect((await call(`${CONVERSATIONS}/${id}`, get(WIDGET, bearer(typed)))).status, id).toBe(404);
    }
  });

  it('writes into them: a message, a rating, the room token and a file', async () => {
    const asPat = { widgetId: ID_WIDGET, token: pat.visitorToken };
    const sent = await call(`${CONVERSATIONS}/dconv_pat_email/messages`, json({ body: 'Following up' }, asPat));
    expect(sent.status).toBe(201);
    expect(((await sent.json()) as { data: { message: { body: string } } }).data.message.body).toBe('Following up');

    const rated = await call(`${CONVERSATIONS}/dconv_pat_closed/rating`, json({ rating: 5 }, asPat));
    expect(rated.status).toBe(201);

    const room = await call('/api/realtime/token', json({ conversationId: 'dconv_pat_portal' }, asPat));
    expect(room.status).toBe(200);
    const { token } = ((await room.json()) as { data: { token: string } }).data;
    expect(decode(token.split('.')[1]!)).toMatchObject({
      sub: pat.visitor.id,
      customerId: pat.visitor.id,
      conversationId: 'dconv_pat_portal',
    });

    const form = new FormData();
    form.append('file', new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' }));
    form.append('conversationId', 'dconv_pat_portal');
    const uploaded = await call('/api/attachments/upload', {
      method: 'POST',
      headers: widgetHeaders(ID_WIDGET, bearer(pat.visitorToken)),
      body: form,
    });
    expect(uploaded.status).toBe(201);
  });

  it('refuses the same writes to the visitor who only typed the address', async () => {
    const asTyped = { token: typed };
    const notFound = (id: string) => refusal(404, 'NOT_FOUND', `Conversation with ID '${id}' not found`);
    expect(await answer(await call(`${CONVERSATIONS}/dconv_pat_email/messages`, json({ body: 'Me too' }, asTyped)))).toEqual(
      notFound('dconv_pat_email'),
    );
    expect(await answer(await call(`${CONVERSATIONS}/dconv_pat_closed/rating`, json({ rating: 1 }, asTyped)))).toEqual(
      notFound('dconv_pat_closed'),
    );
    expect(await answer(await call('/api/realtime/token', json({ conversationId: 'dconv_pat_portal' }, asTyped)))).toEqual(
      notFound('dconv_pat_portal'),
    );
    const form = new FormData();
    form.append('file', new File(['x'], 'x.txt', { type: 'text/plain' }));
    form.append('conversationId', 'dconv_pat_portal');
    const upload = await call('/api/attachments/upload', { method: 'POST', headers: widgetHeaders(WIDGET, bearer(typed)), body: form });
    expect(await answer(upload)).toEqual(notFound('dconv_pat_portal'));
  });

  it('never lets an address the visitor types replace the proven one', async () => {
    const asPat = { widgetId: ID_WIDGET, token: pat.visitorToken };
    const identified = await call(`${CONVERSATIONS}/identify`, json({ name: 'Patricia', email: 'other@else.test' }, asPat));
    expect(await answer(identified)).toEqual({
      status: 200,
      body: { success: true, data: { visitor: { id: pat.visitor.id, name: 'Patricia', email: 'pat@site.test', verified: true } } },
    });
    expect(await visitor(pat.visitor.id)).toMatchObject({ name: 'Patricia', email: 'pat@site.test', verifiedEmail: 'pat@site.test' });

    const started = await call(CONVERSATIONS, json({ email: 'typed@else.test', body: 'New question' }, asPat));
    expect(started.status).toBe(201);
    const { id } = ((await started.json()) as { data: { conversation: { id: string } } }).data.conversation;
    const [row] = await tenantDb.select().from(deskConversations).where(eq(deskConversations.id, id));
    expect(row).toMatchObject({ visitorId: pat.visitor.id, name: 'Patricia', email: 'pat@site.test' });
  });
});
