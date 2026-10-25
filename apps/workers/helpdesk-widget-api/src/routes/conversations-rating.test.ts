/**
 * POST /api/conversations/:id/rating: the visitor's CSAT answer.
 *
 * Same ownership rule as every visitor route (someone else's conversation is
 * a 404), a 1–5 whole number, and a 409 when the conversation is still open
 * or was rated before.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../index';
import { conversationsRoutes } from './conversations';

const mocks = vi.hoisted(() => {
  class DeskRatingRejectedError extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  }
  return {
    getDeskConversation: vi.fn(),
    rateDeskConversation: vi.fn(),
    publishVisitorEvent: vi.fn(() => Promise.resolve()),
    resolveAuthors: vi.fn(() => Promise.resolve(new Map())),
    DeskRatingRejectedError,
  };
});

vi.mock('@weldsuite/db/lib/desk', () => ({
  appendDeskMessage: vi.fn(),
  getDeskConversation: mocks.getDeskConversation,
  attachDeskVisitorContact: vi.fn(),
  createDeskConversation: vi.fn(),
  listDeskConversationsForVisitor: vi.fn(),
  upsertDeskVisitor: vi.fn(),
  rateDeskConversation: mocks.rateDeskConversation,
  DESK_RATING_MIN: 1,
  DESK_RATING_MAX: 5,
  DeskConversationNotFoundError: class DeskConversationNotFoundError extends Error {},
  DeskRatingRejectedError: mocks.DeskRatingRejectedError,
}));

vi.mock('../lib/desk-live', () => ({
  autoAssignConversation: vi.fn((_env: unknown, _db: unknown, _org: unknown, c: unknown) => Promise.resolve(c)),
  isPublicMessage: () => true,
  notifyTeamOfVisitorMessage: vi.fn(() => Promise.resolve()),
  publishConversationUpdated: vi.fn(() => Promise.resolve()),
  publishVisitorEvent: mocks.publishVisitorEvent,
  publishVisitorMessage: vi.fn(() => Promise.resolve()),
  resolveAuthors: mocks.resolveAuthors,
  toPublicConversation: (c: unknown) => c,
  toPublicMessage: (m: unknown) => m,
  visitorDisplayName: vi.fn(() => Promise.resolve('Visitor')),
}));

const CONVERSATION = 'dconv_1';
const VISITOR = 'visitor_1';

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantDb', {} as Variables['tenantDb']);
    c.set('workspaceId', 'ws_1');
    c.set('widgetId', 'wdg_1');
    await next();
  });
  app.route('/api/conversations', conversationsRoutes);
  return app;
}

async function rate(body: Record<string, unknown>) {
  const res = await buildApp().request(
    `/api/conversations/${CONVERSATION}/rating`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitorId: VISITOR, ...body }),
    },
    {} as Env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext,
  );
  return { status: res.status, json: (await res.json()) as { data?: { conversation: { rating: number } } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDeskConversation.mockResolvedValue({
    conversation: { id: CONVERSATION, visitorId: VISITOR, state: 'closed', ratedAt: null },
  });
  mocks.rateDeskConversation.mockImplementation((_db: unknown, input: { rating: number }) =>
    Promise.resolve({
      conversation: { id: CONVERSATION, assigneeId: null, rating: input.rating },
      message: { id: 'dmsg_1', kind: 'event', metadata: { eventType: 'rated', rating: input.rating } },
    }),
  );
});

describe('POST /:id/rating', () => {
  it('stores the rating and comment and publishes it live', async () => {
    const { status, json } = await rate({ rating: 4, comment: '  Quick and friendly  ' });
    expect(status).toBe(201);
    expect(json.data?.conversation.rating).toBe(4);
    expect(mocks.rateDeskConversation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: CONVERSATION, authorId: VISITOR, rating: 4, comment: 'Quick and friendly' }),
    );
    expect(mocks.publishVisitorEvent).toHaveBeenCalledTimes(1);
  });

  it("publishes the conversation with its assignee, so the visitor's other tabs keep the name", async () => {
    const assignee = new Map([['user_1', { name: 'Ada', avatar: null }]]);
    mocks.resolveAuthors.mockResolvedValueOnce(assignee);
    mocks.rateDeskConversation.mockResolvedValueOnce({
      conversation: { id: CONVERSATION, assigneeId: 'user_1', rating: 5 },
      message: { id: 'dmsg_1', kind: 'event', metadata: { eventType: 'rated', rating: 5 } },
    });
    expect((await rate({ rating: 5 })).status).toBe(201);
    expect(mocks.resolveAuthors).toHaveBeenCalledWith(expect.anything(), ['user_1']);
    const call = mocks.publishVisitorEvent.mock.calls[0] as unknown[];
    expect(call[4]).toBe(assignee);
  });

  it('accepts a rating without a comment', async () => {
    expect((await rate({ rating: 1 })).status).toBe(201);
  });

  it("returns 404 for another visitor's conversation", async () => {
    mocks.getDeskConversation.mockResolvedValue({
      conversation: { id: CONVERSATION, visitorId: 'someone_else', state: 'closed', ratedAt: null },
    });
    expect((await rate({ rating: 5 })).status).toBe(404);
    expect(mocks.rateDeskConversation).not.toHaveBeenCalled();
  });

  it('returns 404 for a conversation that does not exist', async () => {
    mocks.getDeskConversation.mockResolvedValue(null);
    expect((await rate({ rating: 5 })).status).toBe(404);
  });

  it.each([[0], [6], [3.5], ['5'], [null]])('rejects rating %s', async (rating) => {
    expect((await rate({ rating })).status).toBe(400);
    expect(mocks.rateDeskConversation).not.toHaveBeenCalled();
  });

  it('rejects a comment over 2000 characters', async () => {
    expect((await rate({ rating: 3, comment: 'x'.repeat(2001) })).status).toBe(400);
  });

  it.each([['not_closed'], ['already_rated']])('returns 409 when the rating is refused (%s)', async (reason) => {
    mocks.rateDeskConversation.mockRejectedValue(new mocks.DeskRatingRejectedError(reason));
    expect((await rate({ rating: 2 })).status).toBe(409);
    expect(mocks.publishVisitorEvent).not.toHaveBeenCalled();
  });
});
