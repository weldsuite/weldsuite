/**
 * POST /api/conversations/:id/messages: visitor messages with file attachments.
 *
 * A message may only reference files this worker uploaded for the same
 * workspace + conversation, and it needs text or at least one file.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../index';
import { conversationsRoutes } from './conversations';

const mocks = vi.hoisted(() => ({
  getDeskConversation: vi.fn(),
  appendDeskMessage: vi.fn(),
  autoAssignConversation: vi.fn(),
  notifyTeamOfVisitorMessage: vi.fn(),
}));

vi.mock('@weldsuite/db/lib/desk', () => ({
  appendDeskMessage: mocks.appendDeskMessage,
  getDeskConversation: mocks.getDeskConversation,
  attachDeskVisitorContact: vi.fn(),
  createDeskConversation: vi.fn(),
  listDeskConversationsForVisitor: vi.fn(),
  upsertDeskVisitor: vi.fn(),
  rateDeskConversation: vi.fn(),
  DESK_RATING_MIN: 1,
  DESK_RATING_MAX: 5,
  DeskConversationNotFoundError: class DeskConversationNotFoundError extends Error {},
  DeskRatingRejectedError: class DeskRatingRejectedError extends Error {},
}));

vi.mock('../lib/desk-live', () => ({
  autoAssignConversation: mocks.autoAssignConversation,
  isPublicMessage: () => true,
  notifyTeamOfVisitorMessage: mocks.notifyTeamOfVisitorMessage,
  publishConversationUpdated: vi.fn(() => Promise.resolve()),
  publishVisitorEvent: vi.fn(() => Promise.resolve()),
  publishVisitorMessage: vi.fn(() => Promise.resolve()),
  resolveAuthors: vi.fn(() => Promise.resolve(new Map())),
  toPublicConversation: (c: unknown) => c,
  toPublicMessage: (m: unknown) => m,
  visitorDisplayName: vi.fn(() => Promise.resolve('Visitor')),
}));

const WORKSPACE = 'ws_1';
const CONVERSATION = 'dconv_1';
const VISITOR = 'visitor_1';
const R2 = 'https://storage.example.org';
const FILE = '1700000000000_att_abc123xyz_screenshot.png';
const GOOD_URL = `${R2}/widgets/${WORKSPACE}/${CONVERSATION}/${FILE}`;

const head = vi.fn();
const env = { R2_PUBLIC_URL: R2, STORAGE: { head } } as unknown as Env;

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantDb', {} as Variables['tenantDb']);
    c.set('workspaceId', WORKSPACE);
    c.set('widgetId', 'wdg_1');
    await next();
  });
  app.route('/api/conversations', conversationsRoutes);
  return app;
}

function attachment(url: string) {
  return { name: 'screenshot.png', url, contentType: 'image/png', filesize: 123 };
}

async function send(body: Record<string, unknown>) {
  const res = await buildApp().request(
    `/api/conversations/${CONVERSATION}/messages`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitorId: VISITOR, ...body }),
    },
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
  return { status: res.status, json: (await res.json()) as { success?: boolean; error?: { message: string } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDeskConversation.mockResolvedValue({
    conversation: { id: CONVERSATION, visitorId: VISITOR, state: 'open', waitingSince: null, assigneeId: null },
  });
  mocks.appendDeskMessage.mockImplementation((_db: unknown, input: Record<string, unknown>) =>
    Promise.resolve({
      conversation: { id: CONVERSATION, assigneeId: null },
      message: { id: 'dmsg_1', ...input, attachments: input.attachments ?? null },
    }),
  );
  head.mockResolvedValue({ size: 4096, httpMetadata: { contentType: 'image/png' } });
  mocks.autoAssignConversation.mockImplementation((_env: unknown, _db: unknown, _org: unknown, c: unknown) =>
    Promise.resolve(c),
  );
  mocks.notifyTeamOfVisitorMessage.mockResolvedValue(undefined);
});

describe('POST /:id/messages auto-assignment', () => {
  it('assigns an unowned thread before telling anyone, and tells the new owner', async () => {
    mocks.autoAssignConversation.mockImplementation((_env: unknown, _db: unknown, _org: unknown, c: object) =>
      Promise.resolve({ ...c, assigneeId: 'user_ann' }),
    );
    const { status } = await send({ body: 'hello?' });
    expect(status).toBe(201);
    await vi.waitFor(() => expect(mocks.notifyTeamOfVisitorMessage).toHaveBeenCalled());
    expect(mocks.autoAssignConversation).toHaveBeenCalledWith(env, expect.anything(), WORKSPACE, expect.objectContaining({ id: CONVERSATION }));
    expect(mocks.notifyTeamOfVisitorMessage.mock.calls[0][0].conversation.assigneeId).toBe('user_ann');
  });

  it('a failed assignment still lets the message through', async () => {
    mocks.autoAssignConversation.mockImplementation((_env: unknown, _db: unknown, _org: unknown, c: unknown) =>
      Promise.resolve(c),
    );
    const { status } = await send({ body: 'hello?' });
    expect(status).toBe(201);
    await vi.waitFor(() => expect(mocks.notifyTeamOfVisitorMessage).toHaveBeenCalled());
    expect(mocks.notifyTeamOfVisitorMessage.mock.calls[0][0].conversation.assigneeId).toBeNull();
  });
});

describe('POST /:id/messages with attachments', () => {
  it('accepts an attachment URL issued for this conversation and stores it', async () => {
    const { status } = await send({ attachments: [attachment(GOOD_URL)] });
    expect(status).toBe(201);
    expect(head).toHaveBeenCalledWith(`widgets/${WORKSPACE}/${CONVERSATION}/${FILE}`);
    const input = mocks.appendDeskMessage.mock.calls[0][1];
    expect(input.body).toBeNull();
    // The stored object's size wins over the client's claim.
    expect(input.attachments).toEqual([
      { name: 'screenshot.png', url: GOOD_URL, contentType: 'image/png', filesize: 4096 },
    ]);
  });

  it('accepts text together with an attachment', async () => {
    const { status } = await send({ body: 'see this', attachments: [attachment(GOOD_URL)] });
    expect(status).toBe(201);
    expect(mocks.appendDeskMessage.mock.calls[0][1].body).toBe('see this');
  });

  it.each([
    ['another host', `https://evil.example.com/widgets/${WORKSPACE}/${CONVERSATION}/${FILE}`],
    ['another conversation', `${R2}/widgets/${WORKSPACE}/dconv_other/${FILE}`],
    ['another workspace', `${R2}/widgets/ws_other/${CONVERSATION}/${FILE}`],
    ['a path traversal', `${R2}/widgets/${WORKSPACE}/${CONVERSATION}/../dconv_other/${FILE}`],
    ['an unrelated object', `${R2}/widgets/${WORKSPACE}/${CONVERSATION}/secret.txt`],
    ['a query string', `${GOOD_URL}?x=1`],
  ])('rejects a URL on %s', async (_label, url) => {
    const { status } = await send({ attachments: [attachment(url)] });
    expect(status).toBe(400);
    expect(mocks.appendDeskMessage).not.toHaveBeenCalled();
  });

  it('rejects a URL for an object that was never uploaded', async () => {
    head.mockResolvedValue(null);
    const { status } = await send({ attachments: [attachment(GOOD_URL)] });
    expect(status).toBe(400);
    expect(mocks.appendDeskMessage).not.toHaveBeenCalled();
  });

  it('rejects one foreign URL among valid ones', async () => {
    const { status } = await send({
      attachments: [attachment(GOOD_URL), attachment('https://evil.example.com/x.png')],
    });
    expect(status).toBe(400);
    expect(mocks.appendDeskMessage).not.toHaveBeenCalled();
  });

  it('rejects an empty body without attachments', async () => {
    expect((await send({ body: '   ' })).status).toBe(400);
    expect((await send({ attachments: [] })).status).toBe(400);
    expect((await send({})).status).toBe(400);
    expect(mocks.appendDeskMessage).not.toHaveBeenCalled();
  });

  it('rejects more than 10 attachments', async () => {
    const { status } = await send({ attachments: Array.from({ length: 11 }, () => attachment(GOOD_URL)) });
    expect(status).toBe(400);
  });

  it('still accepts a plain text message', async () => {
    const { status } = await send({ body: 'hello' });
    expect(status).toBe(201);
    expect(mocks.appendDeskMessage.mock.calls[0][1].attachments).toBeUndefined();
    expect(head).not.toHaveBeenCalled();
  });
});
