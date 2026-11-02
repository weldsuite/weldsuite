/**
 * POST /api/realtime/token on pglite: the short-lived HS256 token a visitor
 * opens its ConversationRoom WebSocket with. It is minted only for a
 * conversation the visitor owns (the visitor its visitor token names, never
 * a field of the body), signed with `WIDGET_TOKEN_SECRET`, and
 * carries who the visitor is (by name), which workspace (its Clerk org id),
 * widget and conversation it is for, and an hour of validity.
 *
 * The token differs between two runs by construction (`iat`), so the
 * conformance harness masks `data.token` (conformance-volatile.ts) and these
 * tests check what it says instead: its signature and every claim.
 */

import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as tenantSchema from '@weldsuite/db/schema';
import { conformanceMasterDb, conformanceTenantDb, createTestApp } from '@weldsuite/worker-kit/testing';
import { createMasterPgliteDb, createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import {
  ORG,
  TOKEN_SECRET,
  WIDGET,
  addWidget,
  at,
  json,
  seedWorkspaces,
  visitorRow,
  visitorToken,
  widgetEnv,
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

const { deskConversations, deskVisitors } = tenantSchema;

const TOKEN = '/api/realtime/token';

let tenantDb: Database;
let masterDb: Database;

function app(env: Record<string, unknown> = {}) {
  return createTestApp('/', worker as never, {
    context: { tenantDb, masterDb, orgId: null, clerkOrgId: null },
    env: widgetEnv(env),
    rustBasePath: '/public/helpdesk-widget',
  });
}

/** Ask for a room token as `visitorId` (a seeded visitor), with a visitor token for `widgetId` signed with `secret`. */
async function mint(
  visitorId: string | null,
  body: Record<string, unknown>,
  options: { widgetId?: string; workspaceId?: string; secret?: string } = {},
  env?: Record<string, unknown>,
) {
  const token =
    visitorId === null
      ? undefined
      : await visitorToken(visitorId, { widgetId: options.widgetId, workspaceId: options.workspaceId, secret: options.secret });
  return app(env).request(TOKEN, json(body, { widgetId: options.widgetId, token }));
}

const notFound = (id: string) => ({
  success: false,
  error: { code: 'NOT_FOUND', message: `Conversation with ID '${id}' not found` },
});

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

/** Check an HS256 JWT against `secret` and return its header and claims. */
function verify(token: string, secret: string) {
  const parts = token.split('.');
  expect(parts).toHaveLength(3);
  const [header, payload, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return { valid: signature === expected, header: decode(header), claims: decode(payload) };
}

async function tokenOf(res: Response) {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: true; data: { token: string; expiresIn: number } };
  expect(body.success).toBe(true);
  expect(Object.keys(body.data).sort()).toEqual(['expiresIn', 'token']);
  expect(body.data.expiresIn).toBe(3600);
  return body.data.token;
}

async function seedConversation(id: string, visitorId: string, values: Partial<typeof deskConversations.$inferInsert> = {}) {
  await tenantDb.insert(deskConversations).values({
    id,
    conversationNumber: Number(id.replace(/\D/g, '')) || 1,
    visitorId,
    title: id,
    state: 'open',
    channel: 'messenger',
    createdAt: at(0),
    updatedAt: at(0),
    ...values,
  });
}

beforeAll(async () => {
  tenantDb = (await createPgliteDb()).db;
  masterDb = (await createMasterPgliteDb()).db;
  holder.master = masterDb;
  holder.tenant = tenantDb;
  await seedWorkspaces(masterDb);
  await addWidget(masterDb, tenantDb, WIDGET);
  await addWidget(masterDb, tenantDb, 'wdg_white', { workspaceId: 'ws_white' });

  await seedConversation('dconv_rt_1', 'vis_named', { name: 'Rita Realtime', email: 'rita@example.test' });
  await seedConversation('dconv_rt_2', 'vis_email', { name: null, email: 'only@example.test' });
  await seedConversation('dconv_rt_3', 'vis_row', { name: null, email: null });
  await seedConversation('dconv_rt_4', 'vis_none', { name: null, email: null });
  await seedConversation('dconv_rt_5', 'vis_spacey', { name: '  Spacey  ', email: null });
  await seedConversation('dconv_rt_6', 'vis_blank', { name: '   ', email: '   ' });
  await tenantDb.insert(deskVisitors).values([
    visitorRow('vis_row', { name: 'Row Name', email: 'row@example.test' }),
    visitorRow('vis_blank', { name: null, email: 'visitor@example.test' }),
    ...['vis_named', 'vis_email', 'vis_none', 'vis_spacey', 'vis_stranger'].map((id) => visitorRow(id)),
  ]);
}, 120_000);

describe('POST /api/realtime/token', () => {
  it('mints a token for the visitor’s conversation, signed with the widget token secret', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await tokenOf(await mint('vis_named', { conversationId: 'dconv_rt_1' }));
    const after = Math.floor(Date.now() / 1000);

    const { valid, header, claims } = verify(token, TOKEN_SECRET);
    expect(valid).toBe(true);
    expect(verify(token, 'another-secret').valid).toBe(false);
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(claims).toEqual({
      sub: 'vis_named',
      customerId: 'vis_named',
      customerName: 'Rita Realtime',
      workspaceId: ORG,
      widgetId: WIDGET,
      conversationId: 'dconv_rt_1',
      iat: expect.any(Number),
      exp: expect.any(Number),
    });
    const { iat, exp } = claims as { iat: number; exp: number };
    expect(exp - iat).toBe(3600);
    // Issued during the request (a minute either way: Rust and TypeScript each take their turn).
    expect(iat).toBeGreaterThanOrEqual(before - 60);
    expect(iat).toBeLessThanOrEqual(after + 60);
  });

  it('carries the Clerk org and widget of the workspace the widget belongs to', async () => {
    const token = await tokenOf(
      await mint('vis_named', { conversationId: 'dconv_rt_1' }, { widgetId: 'wdg_white', workspaceId: 'ws_white' }),
    );
    const { valid, claims } = verify(token, TOKEN_SECRET);
    expect(valid).toBe(true);
    expect(claims).toMatchObject({ workspaceId: 'org_white', widgetId: 'wdg_white', conversationId: 'dconv_rt_1' });
  });

  it('signs with whatever secret the worker holds', async () => {
    const env = { WIDGET_TOKEN_SECRET: 'rotated-secret' };
    const token = await tokenOf(await mint('vis_named', { conversationId: 'dconv_rt_1' }, { secret: 'rotated-secret' }, env));
    expect(verify(token, 'rotated-secret').valid).toBe(true);
    expect(verify(token, TOKEN_SECRET).valid).toBe(false);

    // The visitor token is under that secret too: one issued before the rotation no longer counts.
    const stale = await mint('vis_named', { conversationId: 'dconv_rt_1' }, {}, env);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({
      success: false,
      error: { code: 'VISITOR_TOKEN_INVALID', message: 'Invalid visitor token' },
    });
  });

  it('names the visitor by the conversation’s name, then its email, then the visitor row, else "Visitor"', async () => {
    const names: Array<[string, string, string]> = [
      ['vis_named', 'dconv_rt_1', 'Rita Realtime'],
      ['vis_email', 'dconv_rt_2', 'only@example.test'],
      ['vis_row', 'dconv_rt_3', 'Row Name'],
      ['vis_none', 'dconv_rt_4', 'Visitor'],
      ['vis_spacey', 'dconv_rt_5', 'Spacey'],
      // Blank on the conversation: the visitor row's email stands in for the missing name.
      ['vis_blank', 'dconv_rt_6', 'visitor@example.test'],
    ];
    for (const [visitorId, conversationId, name] of names) {
      const token = await tokenOf(await mint(visitorId, { conversationId }));
      const { claims } = verify(token, TOKEN_SECRET);
      expect(claims, conversationId).toMatchObject({ sub: visitorId, customerId: visitorId, customerName: name });
    }
  });

  it('is a 500 when the worker has no token secret, before anything else is looked at', async () => {
    for (const [visitorId, body] of [
      ['vis_named', { conversationId: 'dconv_rt_1' }],
      ['vis_stranger', { conversationId: 'dconv_rt_1' }],
      ['vis_named', { conversationId: 'dconv_nowhere' }],
      [null, {}],
    ] as const) {
      const res = await mint(visitorId, body, {}, { WIDGET_TOKEN_SECRET: undefined });
      expect(res.status, JSON.stringify(body)).toBe(500);
      expect(await res.json(), JSON.stringify(body)).toEqual({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'WIDGET_TOKEN_SECRET not configured' },
      });
    }
  });

  it('is a 404 for another visitor’s conversation, and for one that does not exist', async () => {
    for (const [visitorId, conversationId] of [
      ['vis_stranger', 'dconv_rt_1'],
      ['vis_named', 'dconv_rt_2'],
      ['vis_named', 'dconv_nowhere'],
    ] as const) {
      const res = await mint(visitorId, { conversationId });
      expect(res.status, `${visitorId} ${conversationId}`).toBe(404);
      expect(await res.json(), `${visitorId} ${conversationId}`).toEqual(notFound(conversationId));
    }
  });

  it('takes the visitor from the visitor token, never from the body', async () => {
    const res = await mint('vis_stranger', { visitorId: 'vis_named', conversationId: 'dconv_rt_1' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(notFound('dconv_rt_1'));
  });

  it('needs a visitor token, before the body is looked at', async () => {
    for (const body of [{ visitorId: 'vis_named', conversationId: 'dconv_rt_1' }, {}]) {
      const res = await mint(null, body);
      expect(res.status, JSON.stringify(body)).toBe(401);
      expect(await res.json(), JSON.stringify(body)).toEqual({
        success: false,
        error: { code: 'VISITOR_TOKEN_REQUIRED', message: 'Missing visitor token' },
      });
    }
  });

  it('refuses a body without a conversation', async () => {
    const missing = await mint('vis_named', { visitorId: 'vis_named' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      success: false,
      error: {
        issues: [{ code: 'invalid_type', expected: 'string', received: 'undefined', path: ['conversationId'], message: 'Required' }],
        name: 'ZodError',
      },
    });

    const empty = await mint('vis_named', { conversationId: '' });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({
      success: false,
      error: {
        issues: [
          {
            code: 'too_small',
            minimum: 1,
            type: 'string',
            inclusive: true,
            exact: false,
            message: 'String must contain at least 1 character(s)',
            path: ['conversationId'],
          },
        ],
        name: 'ZodError',
      },
    });
  });
});
