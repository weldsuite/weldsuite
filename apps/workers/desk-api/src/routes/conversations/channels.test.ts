/**
 * Agent replies and closes on the outside channels, on pglite: Discord (the
 * reply, and the ticket thread archived on close), Slack (`chat.postMessage`
 * with the integration's bot token) and email (through the outbound guard,
 * `SEND_EMAIL` stubbed). Third-party calls go to a `fetch` stub that answers
 * by URL, so the conformance harness compares both backends' calls.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { createSendEmailStub } from '@weldsuite/worker-kit/testing/send-email';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { conversationsRoutes } from './index';

let db: Database;
// Anything else (the conformance harness's own calls) goes to the real fetch.
const realFetch = globalThis.fetch;
const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/channels/thread_bad')) return new Response('nope', { status: 403 });
  if (url.startsWith('https://discord.com/api/v10/channels/')) {
    return Response.json({ id: 'dm_1', channel_id: 'c', content: 'x', timestamp: '2026-01-01T00:00:00Z' });
  }
  if (url === 'https://slack.com/api/chat.postMessage') return Response.json({ ok: true, ts: '1.2' });
  return realFetch(input, init);
});

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function app(env: Record<string, unknown> = {}) {
  return createTestApp('/api/conversations', conversationsRoutes, {
    context: { permissions: permissions('conversations:update'), tenantDb: db },
    env: { DISCORD_BOT_TOKEN: 'bot-token', ...env } as never,
  });
}

async function seed(id: string, channel: string, metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  await db.insert(schema.helpdeskConversations).values({
    id,
    conversationNumber: `CONV-${id}`,
    customerName: 'Customer',
    subject: `Thread ${id}`,
    channel,
    metadata,
    ...extra,
  } as never);
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub);
  db = (await createPgliteDb()).db;
  await seed('conv_discord', 'discord', { discordChannelId: 'thread_1', isTicket: true });
  await seed('conv_discord_bad', 'discord', { discordChannelId: 'thread_bad', isTicket: true });
  await seed('conv_discord_plain', 'discord', { discordChannelId: 'thread_2' });
  await seed('conv_discord_none', 'discord', {});
  await seed('conv_slack', 'slack', { slackChannelId: 'C1', slackThreadTs: '9.9' });
  await seed('conv_slack_none', 'slack', {});
  await seed(
    'conv_email',
    'email',
    { helpdeskEmailAddress: 'support@desk.test', lastEmailMessageId: '<m1@x>', emailReferences: ['<m0@x>', '<m1@x>'] },
    { customerEmail: 'customer@x.test', subject: 'Printer' },
  );
  await seed('conv_email_none', 'email', {}, { customerEmail: 'customer@x.test' });
  await seed('conv_other', 'sms', {});
  await db.insert(schema.helpdeskChannelIntegrations).values({
    id: 'hci_slack',
    provider: 'slack',
    name: 'Slack',
    status: 'connected',
    config: { botToken: 'xoxb-1' },
  } as never);
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('/api/conversations · channel dispatch', () => {
  it('replies on Discord, and archives the ticket thread on close', async () => {
    const { request } = app();
    expect((await request('/api/conversations/conv_discord/messages', json({ content: 'On it' }))).status).toBe(201);
    expect((await request('/api/conversations/conv_discord_none/messages', json({ content: 'No thread' }))).status).toBe(201);
    expect((await request('/api/conversations/conv_discord/close', { method: 'POST' })).status).toBe(200);
    expect((await request('/api/conversations/conv_discord_bad/status', json({ status: 'resolved' }, 'PATCH'))).status).toBe(200);
    expect((await request('/api/conversations/conv_discord_plain/close', { method: 'POST' })).status).toBe(200);
    const noToken = app({ DISCORD_BOT_TOKEN: undefined });
    expect((await noToken.request('/api/conversations/conv_discord_plain/messages', json({ content: 'x' }))).status).toBe(201);
  });

  it('replies on Slack in the thread', async () => {
    const { request } = app();
    expect((await request('/api/conversations/conv_slack/messages', json({ content: 'Hi from Slack' }))).status).toBe(201);
    expect((await request('/api/conversations/conv_slack_none/messages', json({ content: 'No channel' }))).status).toBe(201);
  });

  it('replies by email through the outbound guard', async () => {
    const stub = createSendEmailStub();
    const { request } = app({ SEND_EMAIL: stub });
    const res = await request(
      '/api/conversations/conv_email/messages',
      json({ content: 'Fixed it', contentHtml: '<p>Fixed it</p>', authorName: 'Ann' }),
    );
    expect(res.status).toBe(201);
    expect((await request('/api/conversations/conv_email_none/messages', json({ content: 'No address' }))).status).toBe(201);
    expect((await request('/api/conversations/conv_other/messages', json({ content: 'Unknown channel' }))).status).toBe(201);
  });

  it('fails an email reply without a transport, and the reply stands', async () => {
    const { request } = app();
    expect((await request('/api/conversations/conv_email/messages', json({ content: 'No SEND_EMAIL' }))).status).toBe(201);
  });
});
