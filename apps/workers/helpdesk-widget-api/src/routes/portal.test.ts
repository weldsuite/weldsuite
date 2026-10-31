/**
 * The signed-in help center (/api/portal/*) on pglite: sign-in with an email
 * code, the request form from the customer ticket types, my requests, a
 * request's public thread and replies. The help center's tenant is set by a
 * stand-in for helpcenterDomainMiddleware; mail, realtime and team
 * notifications are captured instead of sent.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import * as schema from '@weldsuite/db/schema';
import { syncTicketTypeDefinitions } from '@weldsuite/db/lib/custom-field-ticket-types';
import { appendDeskMessage } from '@weldsuite/db/lib/desk';
import { upsertIdentifiedDeskVisitor, listDeskConversationsForPrincipal, deskPrincipalOf } from '@weldsuite/db/lib/desk-portal';
import { RateLimitCounter, type RateLimitNamespace, type RateLimitState } from '@weldsuite/commerce-domain/portal-tokens';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createMemoryKv } from '@weldsuite/worker-kit/testing/d1';
import type { TicketTypeField } from '@weldsuite/db/schema';
import type { Env, Variables } from '../index';
import { generateId } from '../lib/id';

vi.setConfig({ testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  tenant: null as unknown,
  workspaceId: 'ws_portal',
  sent: [] as Array<{ to: string; code: string }>,
}));

vi.mock('../middleware/helpcenter-domain', () => ({
  helpcenterDomainMiddleware: () => async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('tenantDb', holder.tenant);
    c.set('workspaceId', holder.workspaceId);
    c.set('clerkOrgId', 'org_portal');
    await next();
  },
}));

vi.mock('../lib/portal-mail', () => ({
  sendPortalCodeEmail: vi.fn(async (_env: unknown, params: { to: string; code: string }) => {
    holder.sent.push({ to: params.to, code: params.code });
    return true;
  }),
}));

vi.mock('../lib/desk-live', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/desk-live')>()),
  publishVisitorMessage: vi.fn(() => Promise.resolve()),
  autoAssignConversation: vi.fn((_env: unknown, _db: unknown, _org: unknown, c: unknown) => Promise.resolve(c)),
  notifyTeamOfVisitorMessage: vi.fn(() => Promise.resolve()),
}));

import { portalRoutes } from './portal';

/** In-memory stand-in for the PortalRateLimiter namespace. */
function memoryLimiter(): RateLimitNamespace {
  const counters = new Map<string, RateLimitCounter>();
  return {
    idFromName: (name: string) => name as unknown as DurableObjectId,
    get: (id: DurableObjectId) => {
      const key = id as unknown as string;
      let counter = counters.get(key);
      if (!counter) {
        let state: RateLimitState | undefined;
        counter = new RateLimitCounter({
          load: async () => state,
          save: async (next) => {
            state = next;
          },
          setAlarm: async () => {},
          clear: async () => {
            state = undefined;
          },
        });
        counters.set(key, counter);
      }
      const c = counter;
      return { hit: (max, window) => c.hit(max, window), release: () => c.release() };
    },
  };
}

type Db = Awaited<ReturnType<typeof createPgliteDb>>['db'];
let db: Db;
let env: Env;

function app() {
  const root = new Hono<{ Bindings: Env; Variables: Variables }>();
  root.route('/api/portal', portalRoutes);
  return root;
}

async function call(path: string, init: RequestInit & { session?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (init.session) headers.set('x-portal-session', init.session);
  const res = await app().request(
    `/api/portal${path}${path.includes('?') ? '&' : '?'}domain=help.acme.test`,
    { ...init, headers },
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as { success: boolean; data?: any; error?: any }) : null };
}

const post = (path: string, body: unknown, session?: string) =>
  call(path, { method: 'POST', body: JSON.stringify(body), session });

async function signIn(email: string): Promise<string> {
  holder.sent.length = 0;
  expect((await post('/auth/request', { email })).status).toBe(200);
  const code = holder.sent.at(-1)?.code;
  expect(code).toMatch(/^\d{6}$/);
  const verified = await post('/auth/verify', { email, code });
  expect(verified.status).toBe(200);
  return verified.body!.data.session as string;
}

const FIELDS: TicketTypeField[] = [
  { key: 'title', label: 'Subject', type: 'text', required: true, order: 0, isDefault: true, customerVisible: true },
  { key: 'description', label: 'What happened?', type: 'textarea', required: true, order: 1, isDefault: true, customerVisible: true },
  {
    key: 'order_number',
    label: 'Order number',
    type: 'text',
    required: true,
    order: 2,
    customerVisible: true,
  },
  {
    key: 'area',
    label: 'Area',
    type: 'select',
    required: false,
    order: 3,
    customerVisible: true,
    options: [
      { label: 'Billing', value: 'billing' },
      { label: 'Shipping', value: 'shipping' },
    ],
  },
  {
    key: 'tracking',
    label: 'Tracking code',
    type: 'text',
    required: true,
    order: 4,
    customerVisible: true,
    conditions: [{ field: 'area', operator: 'equals', value: 'shipping' }],
  },
  { key: 'internal_score', label: 'Internal score', type: 'number', required: false, order: 5, customerVisible: false },
];

const TYPE_ID = 'tt_portal_order';

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  holder.tenant = db;
  env = {
    ENVIRONMENT: 'test',
    WORKSPACE_CACHE: createMemoryKv(),
    PORTAL_RATE_LIMITER: memoryLimiter(),
  } as unknown as Env;

  await db.delete(schema.helpcenterSettings);
  await db.insert(schema.helpcenterSettings).values({ id: 'hcs_1', isEnabled: 1, portalEnabled: 1, siteName: 'Acme help' });
  await db.insert(schema.helpdeskTicketTypes).values([
    {
      id: TYPE_ID,
      name: 'Order problem',
      category: 'customer',
      fields: FIELDS,
      defaultPriority: 'high',
      states: [
        { groupKey: 'submitted', groupLabel: 'Submitted', customerGroupLabel: 'Received', states: [] },
      ],
      sortOrder: 1,
    },
    { id: 'tt_portal_backoffice', name: 'Internal task', category: 'back-office', fields: [], sortOrder: 2 },
    { id: 'tt_portal_inactive', name: 'Old type', category: 'customer', fields: [], isActive: false },
  ]);
  await syncTicketTypeDefinitions(db, generateId, TYPE_ID, FIELDS);
});

beforeEach(() => {
  env.PORTAL_RATE_LIMITER = memoryLimiter();
});

describe('sign-in', () => {
  it('says whether sign-in is on', async () => {
    expect((await call('/config')).body?.data).toEqual({ enabled: true });
  });

  it('emails a code and turns it into a session', async () => {
    const session = await signIn('reader@acme.test');
    expect(session).toMatch(/^[0-9a-f]{64}$/);
    const me = await call('/me', { session });
    expect(me.body?.data).toEqual({ email: 'reader@acme.test', name: null });
  });

  it('refuses a wrong code, and the code after too many wrong ones', async () => {
    holder.sent.length = 0;
    await post('/auth/request', { email: 'guess@acme.test' });
    const right = holder.sent.at(-1)!.code;
    const wrong = right === '000000' ? '111111' : '000000';
    const first = await post('/auth/verify', { email: 'guess@acme.test', code: wrong });
    expect(first.status).toBe(400);
    expect(first.body?.error.code).toBe('INVALID_CODE');
    for (let i = 0; i < 7; i++) await post('/auth/verify', { email: 'guess@acme.test', code: wrong });
    const after = await post('/auth/verify', { email: 'guess@acme.test', code: right });
    expect(after.body?.error.code).toBe('CODE_EXPIRED');
  });

  it('limits code emails per address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post('/auth/request', { email: 'spam@acme.test' })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('refuses the signed-in routes without a live session', async () => {
    expect((await call('/requests')).status).toBe(401);
    expect((await call('/requests', { session: 'f'.repeat(64) })).status).toBe(401);
  });

  it('signs out', async () => {
    const session = await signIn('leaving@acme.test');
    expect((await post('/auth/sign-out', {}, session)).status).toBe(204);
    expect((await call('/me', { session })).status).toBe(401);
  });

  it('is closed while the switch is off', async () => {
    const session = await signIn('switch@acme.test');
    await db.update(schema.helpcenterSettings).set({ portalEnabled: 0 });
    try {
      expect((await call('/config')).body?.data).toEqual({ enabled: false });
      expect((await post('/auth/request', { email: 'x@acme.test' })).status).toBe(404);
      expect((await call('/requests', { session })).status).toBe(404);
    } finally {
      await db.update(schema.helpcenterSettings).set({ portalEnabled: 1 });
    }
  });
});

describe('requests', () => {
  it('offers the active customer types with their customer-visible fields', async () => {
    const session = await signIn('form@acme.test');
    const types = (await call('/request-types', { session })).body?.data as Array<{ id: string; fields: Array<{ key: string }> }>;
    expect(types.map((t) => t.id)).toEqual([TYPE_ID]);
    expect(types[0]).toMatchObject({ titleLabel: 'Subject', descriptionLabel: 'What happened?', descriptionRequired: true });
    expect(types[0]!.fields.map((f) => f.key)).toEqual(['order_number', 'area', 'tracking']);
  });

  it('enforces required fields, including ones a condition shows', async () => {
    const session = await signIn('required@acme.test');
    const base = { ticketTypeId: TYPE_ID, title: 'Broken', description: 'It broke' };
    const missing = await post('/requests', { ...base, fields: {} }, session);
    expect(missing.status).toBe(400);
    expect(missing.body?.error.details).toEqual({ field: 'order_number' });
    const conditional = await post('/requests', { ...base, fields: { order_number: 'A1', area: 'shipping' } }, session);
    expect(conditional.body?.error.details).toEqual({ field: 'tracking' });
    const hidden = await post('/requests', { ...base, fields: { order_number: 'A1', internal_score: 5 } }, session);
    expect(hidden.body?.error.details).toEqual({ field: 'internal_score' });
    const otherType = await post('/requests', { ...base, ticketTypeId: 'tt_portal_backoffice' }, session);
    expect(otherType.body?.error.details).toEqual({ field: 'ticketTypeId' });
  });

  it('submits a request onto the portal channel with its type, priority and fields', async () => {
    const session = await signIn('Customer@Acme.test');
    const created = await post(
      '/requests',
      {
        ticketTypeId: TYPE_ID,
        title: 'Parcel never arrived',
        description: 'Ordered last week.',
        fields: { order_number: 'A-1001', area: 'shipping', tracking: 'TRK9' },
      },
      session,
    );
    expect(created.status).toBe(201);
    const detail = created.body!.data;
    expect(detail).toMatchObject({
      title: 'Parcel never arrived',
      status: 'submitted',
      statusLabel: 'Received',
      typeName: 'Order problem',
      fields: [
        { key: 'order_number', label: 'Order number', value: 'A-1001' },
        { key: 'area', label: 'Area', value: 'Shipping' },
        { key: 'tracking', label: 'Tracking code', value: 'TRK9' },
      ],
    });
    expect(detail.messages).toHaveLength(1);
    expect(detail.messages[0]).toMatchObject({ body: 'Ordered last week.', authorType: 'visitor' });

    const [row] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, detail.id));
    expect(row).toMatchObject({ channel: 'portal', ticketTypeId: TYPE_ID, priority: 'high', email: 'customer@acme.test' });

    const list = await call('/requests', { session });
    expect(list.body?.data.requests.map((r: { id: string }) => r.id)).toContain(detail.id);
  });

  it("never shows someone else's request", async () => {
    const owner = await signIn('owner@acme.test');
    const created = await post('/requests', { ticketTypeId: TYPE_ID, title: 'Mine', description: 'x', fields: { order_number: '1' } }, owner);
    const id = created.body!.data.id as string;
    const stranger = await signIn('stranger@acme.test');
    expect((await call(`/requests/${id}`, { session: stranger })).status).toBe(404);
    expect((await post(`/requests/${id}/messages`, { body: 'hi' }, stranger)).status).toBe(404);
    expect((await call('/requests', { session: stranger })).body?.data.requests).toEqual([]);
  });

  it('shows the public thread only, and a reply reopens a resolved request', async () => {
    const session = await signIn('thread@acme.test');
    const created = await post('/requests', { ticketTypeId: TYPE_ID, title: 'Thread', description: 'first', fields: { order_number: '2' } }, session);
    const id = created.body!.data.id as string;
    await appendDeskMessage(db, { generateId, conversationId: id, kind: 'note', authorType: 'agent', authorId: 'user_1', body: 'internal only' });
    await appendDeskMessage(db, { generateId, conversationId: id, kind: 'message', authorType: 'agent', authorId: 'user_1', body: 'We are on it' });
    let detail = (await call(`/requests/${id}`, { session })).body!.data;
    expect(detail.status).toBe('waiting_on_customer');
    expect(detail.messages.map((m: { body: string }) => m.body)).toEqual(['first', 'We are on it']);

    await appendDeskMessage(db, { generateId, conversationId: id, kind: 'event', authorType: 'agent', authorId: 'user_1', metadata: { eventType: 'closed' } });
    expect((await call(`/requests/${id}`, { session })).body!.data.status).toBe('resolved');

    const reply = await post(`/requests/${id}/messages`, { body: 'Still broken' }, session);
    expect(reply.status).toBe(201);
    detail = (await call(`/requests/${id}`, { session })).body!.data;
    expect(detail.status).toBe('submitted');
    expect(detail.messages.at(-1)).toMatchObject({ body: 'Still broken', authorType: 'visitor' });
  });
});

describe('one person across the widget and the help center', () => {
  it('a widget user the site vouched for sees the requests of the same verified email', async () => {
    const session = await signIn('shared@acme.test');
    const created = await post('/requests', { ticketTypeId: TYPE_ID, title: 'From the help center', description: 'x', fields: { order_number: '3' } }, session);
    const identified = await upsertIdentifiedDeskVisitor(db, generateId, {
      widgetId: 'widget_portal',
      externalId: 'site-user-1',
      email: 'SHARED@acme.test',
    });
    const { rows } = await listDeskConversationsForPrincipal(db, deskPrincipalOf(identified));
    expect(rows.map((r) => r.id)).toContain(created.body!.data.id);

    // An anonymous visitor who merely typed that address sees nothing.
    const { rows: none } = await listDeskConversationsForPrincipal(db, { visitorId: 'dvis_typed', verifiedEmail: null });
    expect(none).toEqual([]);
  });
});
