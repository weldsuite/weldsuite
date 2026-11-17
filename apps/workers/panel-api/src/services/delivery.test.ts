/**
 * Delivery fan-out on a real tenant schema (pglite): every channel is tried
 * on its own, so a Slack webhook that fails leaves email, in-app and WeldChat
 * delivered; messages go out in each reader's language; the Slack URL is
 * sealed at rest and never shows up in a result or a DTO; a WeldChat post
 * cannot mention anyone.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { memoryTransport } from '@weldsuite/emails/transports/memory';

const state = vi.hoisted(() => ({ notifications: [] as Record<string, unknown>[], chat: [] as Record<string, unknown>[] }));

vi.mock('@weldsuite/notifications', () => ({
  createAndDeliverNotification: async (params: Record<string, unknown>) => {
    state.notifications.push(params);
    return 'notif_1';
  },
}));
vi.mock('@weldsuite/chat-domain/post-system-message', () => ({
  postSystemChatMessage: async (ctx: Record<string, unknown>, input: Record<string, unknown>) => {
    state.chat.push({ ...ctx, ...input });
    return { id: 'msg_1' };
  },
}));

import { deliver, deliveryError, slackPayload, storeChannels, toChannelsDto, weldchatContent, type DeliveryContext, type PanelMessage } from './delivery';
import { openSecret } from './secrets';

const { chatChannels, userPreferences, workspaceMembers } = schema;
const KEY = '0'.repeat(63) + '1';
const SLACK = 'https://hooks.slack.com/services/T000/B000/secretsecret';

let db: Database;

const message: PanelMessage = {
  kind: 'alert',
  entityId: 'pnal_1',
  path: '/weldpanel/alerts?alert=pnal_1',
  alert: {
    alertName: 'Signups <@everyone>',
    projectName: 'Shop',
    event: 'fired',
    metric: 'Signups',
    value: 150,
    bound: 100,
    condition: { type: 'threshold', operator: 'above', value: 100 },
    interval: 'daily',
    period: '2026-11-17',
  },
};

function ctx(overrides: Partial<DeliveryContext> = {}): DeliveryContext {
  return {
    env: { DATABASE_ENCRYPTION_KEY: KEY, PLATFORM_URL: 'https://app.weldsuite.org' } as never,
    db,
    workspaceId: 'ws_a',
    clerkOrgId: 'org_a',
    actorUserId: 'user_alice',
    transport: memoryTransport(),
    ...overrides,
  };
}

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

beforeEach(async () => {
  state.notifications = [];
  state.chat = [];
  await db.delete(workspaceMembers);
  await db.delete(userPreferences);
  await db.delete(chatChannels);
  await db.insert(workspaceMembers).values([
    { id: 'wm_1', userId: 'user_alice', email: 'alice@example.com', name: 'Alice', role: 'OWNER', status: 'ACTIVE' },
    { id: 'wm_2', userId: 'user_bram', email: 'bram@example.com', name: 'Bram', role: 'MEMBER', status: 'ACTIVE' },
    { id: 'wm_3', userId: 'user_gone', email: 'gone@example.com', name: 'Gone', role: 'MEMBER', status: 'ACTIVE', deletedAt: new Date() },
  ]);
  await db.insert(userPreferences).values({ id: 'up_1', userId: 'user_bram', language: 'nl' });
  await db.insert(chatChannels).values({ id: 'chc_1', name: 'growth', slug: 'growth' });
});

describe('storeChannels', () => {
  it('seals the Slack URL, keeps it on update unless replaced or removed, and never shows it', async () => {
    const env = { DATABASE_ENCRYPTION_KEY: KEY } as never;
    const stored = await storeChannels(env, { emailUserIds: ['user_alice'], inApp: true, slackWebhookUrl: SLACK, weldchatChannelId: null });
    expect(stored.channels).toEqual({ emailUserIds: ['user_alice'], inApp: true, slack: true, weldchatChannelId: null });
    expect(stored.slackWebhookCiphertext).not.toContain('hooks.slack.com');
    expect(await openSecret(env, stored.slackWebhookCiphertext!)).toBe(SLACK);
    expect(JSON.stringify(toChannelsDto(stored))).not.toContain('slack.com');

    const kept = await storeChannels(env, { emailUserIds: [], inApp: false }, stored);
    expect(kept.slackWebhookCiphertext).toBe(stored.slackWebhookCiphertext);
    const removed = await storeChannels(env, { emailUserIds: [], inApp: false, slackWebhookUrl: null }, stored);
    expect(removed).toMatchObject({ slackWebhookCiphertext: null, channels: { slack: false } });
  });
});

describe('deliver', () => {
  it('a failing Slack webhook does not stop email, in-app or WeldChat, and its error carries no URL', async () => {
    const env = { DATABASE_ENCRYPTION_KEY: KEY } as never;
    const stored = await storeChannels(env, { emailUserIds: ['user_alice', 'user_bram', 'user_gone'], inApp: true, slackWebhookUrl: SLACK, weldchatChannelId: 'chc_1' });
    const transport = memoryTransport();
    const slack = vi.fn(async () => new Response('invalid_token', { status: 403 }));
    const results = await deliver(ctx({ transport, fetch: slack as unknown as typeof fetch }), { ...stored, ownerUserId: 'user_alice' }, message);

    expect(results.map((r) => [r.channel, r.ok, r.recipients])).toEqual([
      ['email', true, 2],
      ['in_app', true, 2],
      ['slack', false, 0],
      ['weldchat', true, 1],
    ]);
    expect(results[2]!.error).toBe('Slack answered 403: invalid_token');
    expect(JSON.stringify(results)).not.toContain('hooks.slack.com');
    expect(deliveryError(results)).toBe('slack: Slack answered 403: invalid_token');

    // Each member in their own language; the removed member gets nothing.
    expect(transport.sent.flatMap((m) => m.to.map((to) => to.email))).toEqual(['alice@example.com', 'bram@example.com']);
    expect(transport.sent[0]!.subject).toBe('Alert: Signups <@everyone>');
    expect(transport.sent[1]!.subject).toBe('Melding: Signups <@everyone>');
    expect(transport.sent[0]!.html).toContain('https://app.weldsuite.org/w/org_a/weldpanel/alerts?alert=pnal_1');

    // In-app: never by email again, linked to the alert.
    expect(state.notifications).toHaveLength(2);
    expect(state.notifications[0]).toMatchObject({ category: 'weldpanel', notificationType: 'panel_alert', entityId: 'pnal_1', excludeChannels: ['email'], severity: 'warning' });

    // WeldChat: posted as WeldPanel, the alert's name cannot ping anyone.
    expect(state.chat[0]).toMatchObject({ channelId: 'chc_1', authorId: 'app:weldpanel', authorName: 'WeldPanel' });
    expect(String(state.chat[0]!.content)).not.toContain('<@everyone>');
  });

  it('reports a WeldChat channel that is gone, and tries only the channels set', async () => {
    const results = await deliver(ctx(), { channels: { emailUserIds: [], inApp: false, slack: false, weldchatChannelId: 'chc_gone' }, slackWebhookCiphertext: null, ownerUserId: 'user_alice' }, message);
    expect(results).toEqual([{ channel: 'weldchat', ok: false, recipients: 0, error: 'The WeldChat channel no longer exists' }]);
    expect(await deliver(ctx(), { channels: { emailUserIds: [], inApp: false, slack: false }, slackWebhookCiphertext: null, ownerUserId: 'user_alice' }, message)).toEqual([]);
  });

  it('says so when email is not configured', async () => {
    const results = await deliver(ctx({ transport: null }), { channels: { emailUserIds: ['user_alice'], inApp: false, slack: false }, slackWebhookCiphertext: null, ownerUserId: 'user_alice' }, message);
    expect(results[0]).toMatchObject({ channel: 'email', ok: false, error: 'Email is not configured here' });
  });
});

describe('message formats', () => {
  it('Slack: Block Kit with escaped text and a link', () => {
    const payload = slackPayload(ctx(), message, 'en') as { text: string; blocks: { type: string; text?: { text: string } }[] };
    expect(payload.text).toBe('Signups <@everyone> is firing');
    const section = payload.blocks.find((b) => b.type === 'section')!;
    expect(section.text!.text).toContain('Signups was 150 for November 17, 2026: above 100.');
    expect(JSON.stringify(payload)).toContain('<https://app.weldsuite.org/w/org_a/weldpanel/alerts?alert=pnal_1|Open alert>');
  });

  it('WeldChat: Markdown with the link, mentions neutralised', () => {
    const content = weldchatContent(ctx(), message, 'nl');
    expect(content).toContain('**Signups <​@everyone> gaat af**');
    expect(content).toContain('[Open melding](https://app.weldsuite.org/w/org_a/weldpanel/alerts?alert=pnal_1)');
  });

  it('a digest is written per locale, with every block', () => {
    const digest: PanelMessage = {
      kind: 'report',
      entityId: 'pnsb_1',
      path: '/weldpanel/dashboards/pnd_1',
      digest: (locale) => ({
        subscriptionName: 'Weekly',
        projectName: 'Shop',
        targetType: 'dashboard',
        targetName: 'Growth',
        blocks: [{ title: locale === 'nl' ? 'Bezoekers' : 'Visitors', headline: [{ label: 'Visitors', value: 120, previous: 100, format: 'number' }], rows: [], path: '/weldpanel?report=pnr_1' }],
      }),
    };
    const payload = JSON.stringify(slackPayload(ctx(), digest, 'en'));
    expect(payload).toContain('Weekly: Growth');
    expect(payload).toContain('Visitors: 120 (+20%)');
    expect(weldchatContent(ctx(), digest, 'nl')).toContain('Bezoekers');
  });
});
