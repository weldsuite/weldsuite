/**
 * Reporting times through the inbox routes, against pglite (ADR DESK-011):
 * the first agent reply records the first response (counted from the
 * visitor's first message), a close records the resolution and a reopen
 * clears it. In conformance mode the responses are Rust's.
 *
 * The timelines are back-dated in the setup, so the measured spans are long
 * enough to assert while "now" differs per run.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { deskConversationsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { createDeskConversation } from '@weldsuite/db/lib/desk';
import { generateId } from '@weldsuite/worker-kit/id';

let db: Database;
const MINUTE = 60_000;
/** Slack for the time between the setup and the request. */
const SLACK_SECONDS = 120;

const app = () =>
  createTestApp('/api/desk/conversations', deskConversationsRoutes, {
    context: {
      permissions: permissions('conversations:read', 'conversations:update'),
      tenantDb: db,
      userId: 'user_report_agent',
    },
  });

const send = (method: string, path: string, body?: unknown) =>
  app().request(`/api/desk/conversations${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

interface Conversation {
  id: string;
  state: string;
  firstResponseAt: string | null;
  firstResponseSeconds: number | null;
  resolvedAt: string | null;
  resolutionSeconds: number | null;
}

async function conversationOf(res: Response): Promise<Conversation> {
  expect(res.status).toBeLessThan(300);
  const json = (await res.json()) as { data: { conversation: Conversation } };
  return json.data.conversation;
}

/** Moves a conversation and its whole timeline `minutes` into the past. */
async function backdate(id: string, minutes: number) {
  const shift = minutes * MINUTE;
  const messages = await db.select().from(schema.deskMessages).where(eq(schema.deskMessages.conversationId, id));
  for (const m of messages) {
    await db
      .update(schema.deskMessages)
      .set({ createdAt: new Date(m.createdAt.getTime() - shift) })
      .where(eq(schema.deskMessages.id, m.id));
  }
  const [c] = await db.select().from(schema.deskConversations).where(eq(schema.deskConversations.id, id));
  if (!c) throw new Error(`no conversation ${id}`);
  await db
    .update(schema.deskConversations)
    .set({ createdAt: new Date(c.createdAt.getTime() - shift) })
    .where(eq(schema.deskConversations.id, id));
}

async function start(visitorId: string, authorType: 'visitor' | 'agent' = 'visitor') {
  const { conversation } = await createDeskConversation(db, {
    generateId,
    visitorId,
    name: 'Rita',
    body: authorType === 'visitor' ? 'Nothing works' : 'We noticed your order is late',
    authorType,
    authorId: authorType === 'agent' ? 'user_report_agent' : visitorId,
  });
  return conversation.id;
}

/** When the conversation's opening message was written (a few ms after its row). */
async function openedAt(conversationId: string): Promise<Date> {
  const [first] = await db
    .select({ createdAt: schema.deskMessages.createdAt })
    .from(schema.deskMessages)
    .where(eq(schema.deskMessages.conversationId, conversationId))
    .orderBy(schema.deskMessages.createdAt)
    .limit(1);
  if (!first) throw new Error(`no messages on ${conversationId}`);
  return first.createdAt;
}

/** A message written straight to the timeline, as before the reporting columns existed. */
async function addOldMessage(conversationId: string, authorType: 'visitor' | 'agent', at: Date) {
  await db.insert(schema.deskMessages).values({
    id: generateId('dmsg'),
    createdAt: at,
    conversationId,
    kind: 'message',
    body: 'An earlier message',
    authorType,
    authorId: authorType === 'agent' ? 'user_report_agent' : 'v_old',
  });
}

const expectAbout = (actual: number | null, expected: number) => {
  expect(actual).not.toBeNull();
  expect(actual!).toBeGreaterThanOrEqual(expected);
  expect(actual!).toBeLessThan(expected + SLACK_SECONDS);
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(async () => {
  await db.delete(schema.deskSlaClocks);
  await db.delete(schema.deskMessages);
  await db.delete(schema.deskConversations);
});

describe('desk reporting times through the inbox routes', () => {
  it('records the first response on the first agent reply only', async () => {
    const id = await start('v_report_first');
    await backdate(id, 90);

    // An internal note is not a response.
    const noted = await conversationOf(await send('POST', `/${id}/reply`, { kind: 'note', body: 'Looking' }));
    expect(noted).toMatchObject({ firstResponseAt: null, firstResponseSeconds: null });

    const replied = await conversationOf(await send('POST', `/${id}/reply`, { body: 'On it!' }));
    expect(replied.firstResponseAt).not.toBeNull();
    expectAbout(replied.firstResponseSeconds, 90 * 60);

    const again = await conversationOf(await send('POST', `/${id}/reply`, { body: 'Still on it' }));
    expect(again.firstResponseAt).toBe(replied.firstResponseAt);
    expect(again.firstResponseSeconds).toBe(replied.firstResponseSeconds);
  });

  it('records the resolution on close, clears it on reopen and sets it again', async () => {
    const id = await start('v_report_close');
    await backdate(id, 240);

    const closed = await conversationOf(await send('POST', `/${id}/manage`, { action: 'close' }));
    expect(closed.state).toBe('closed');
    expect(closed.resolvedAt).not.toBeNull();
    expectAbout(closed.resolutionSeconds, 240 * 60);
    // Closed without a reply: no first response.
    expect(closed.firstResponseSeconds).toBeNull();

    const reopened = await conversationOf(await send('POST', `/${id}/manage`, { action: 'open' }));
    expect(reopened).toMatchObject({ state: 'open', resolvedAt: null, resolutionSeconds: null });

    const closedAgain = await conversationOf(await send('POST', `/${id}/manage`, { action: 'close' }));
    expectAbout(closedAgain.resolutionSeconds, 240 * 60);
  });

  it('takes the real first reply of a conversation answered before the columns existed', async () => {
    const id = await start('v_report_old');
    await backdate(id, 300);
    const firstReplyAt = new Date((await openedAt(id)).getTime() + 60 * MINUTE);
    await addOldMessage(id, 'agent', firstReplyAt);

    const replied = await conversationOf(await send('POST', `/${id}/reply`, { body: 'Following up' }));
    expect(replied.firstResponseAt).toBe(firstReplyAt.toISOString());
    expect(replied.firstResponseSeconds).toBe(60 * 60);
  });

  it('gives a conversation the team started no first response time', async () => {
    const id = await start('v_report_team', 'agent');
    await backdate(id, 60);
    const opened = await openedAt(id);
    // The opening reply was the team's; forget what creation recorded to make the reply below look again.
    await db
      .update(schema.deskConversations)
      .set({ firstResponseAt: null, firstResponseSeconds: null })
      .where(eq(schema.deskConversations.id, id));
    await addOldMessage(id, 'visitor', new Date(opened.getTime() + 10 * MINUTE));

    const replied = await conversationOf(await send('POST', `/${id}/reply`, { body: 'Thanks for getting back' }));
    expect(replied.firstResponseAt).toBe(opened.toISOString());
    expect(replied.firstResponseSeconds).toBeNull();
  });
});
