import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { handleSendEmail, handleSendNotification, handleSlackMessage } from './communication';
import { makeActionContext } from '../../test/ctx';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';
import { NonRetryableStepError } from '../errors';
import type { WorkflowDb } from '../types';

function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- send_notification: pglite ---------------------------------------------

describe('send_notification (pglite)', () => {
  let db: Database;
  beforeAll(async () => {
    db = (await createPgliteDb()).db;
  });

  it('inserts a notification row for an explicit user', async () => {
    const ctx = makeActionContext({ db });
    const res = (await handleSendNotification(
      { title: 'Build done', body: 'green', userId: 'user_target' },
      ctx,
    )) as { sent: boolean; notificationIds: string[]; count: number };

    expect(res.sent).toBe(true);
    expect(res.count).toBe(1);

    const [row] = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, res.notificationIds[0]));
    expect(row?.userId).toBe('user_target');
    expect(row?.title).toBe('Build done');
  });

  it('defaults the recipient to the run user when none is given', async () => {
    const ctx = makeActionContext({ db, tenant: { workspaceId: 'ws_test', userId: 'runner' } });
    const res = (await handleSendNotification({ title: 'Self' }, ctx)) as { notificationIds: string[] };
    const [row] = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, res.notificationIds[0]));
    expect(row?.userId).toBe('runner');
  });

  it('throws when the title is missing', async () => {
    await expect(handleSendNotification({ body: 'x' }, makeActionContext({ db }))).rejects.toThrow(/title/i);
  });
});

// --- send_email: fake db (account lookup) + stubbed internal endpoint -------

describe('send_email', () => {
  function dbReturningAccounts(accounts: unknown[]): WorkflowDb {
    return {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => accounts }) }) }),
    } as unknown as WorkflowDb;
  }

  it('sends through the internal endpoint with the bearer secret', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({ success: true, messageId: 'm1' }), { status: 200 }));
    const ctx = makeActionContext({
      db: dbReturningAccounts([{ id: 'mac_1', email: 'sender@test.com', isDefault: true }]),
      env: { INTERNAL_API_SECRET: 'secret', APP_API_URL: 'https://app-api-test.weldsuite.org' },
    });

    const res = (await handleSendEmail(
      { to: 'a@b.com', subject: 'Hi', body: '<p>hi</p>' },
      ctx,
    )) as { success: boolean; messageId: string };

    expect(res.success).toBe(true);
    expect(res.messageId).toBe('m1');
    expect(calls[0].url).toBe('https://app-api-test.weldsuite.org/api/internal/send-email');
    const auth = new Headers(calls[0].init?.headers).get('authorization');
    expect(auth).toBe('Bearer secret');
    expect(String(calls[0].init?.body)).toContain('a@b.com');
  });

  it('sends through the AppApiInternal entrypoint without a secret when it is bound', async () => {
    const { calls } = stubFetch(() => new Response('{}', { status: 200 }));
    const entrypoint = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, messageId: 'm5' }), { status: 200 }),
    );
    const ctx = makeActionContext({
      db: dbReturningAccounts([{ id: 'mac_1', email: 'sender@test.com', isDefault: true }]),
      env: { APP_API_INTERNAL: { fetch: entrypoint } as never },
    });

    const res = (await handleSendEmail({ to: 'a@b.com', subject: 'Hi', body: 'x' }, ctx)) as { messageId: string };

    expect(res.messageId).toBe('m5');
    expect(calls).toHaveLength(0);
    const [url, init] = entrypoint.mock.calls[0];
    expect(url).toBe('https://internal/api/internal/send-email');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(String(init?.body)).toContain('a@b.com');
  });

  it('does not resend over HTTP when the entrypoint call fails for another reason', async () => {
    const { calls } = stubFetch(() => new Response('{}', { status: 200 }));
    const entrypoint = vi.fn(async () => {
      throw new Error('network lost');
    });
    const ctx = makeActionContext({
      db: dbReturningAccounts([{ id: 'mac_1', email: 'sender@test.com', isDefault: true }]),
      env: { APP_API_INTERNAL: { fetch: entrypoint } as never, INTERNAL_API_SECRET: 'secret' },
    });

    await expect(handleSendEmail({ to: 'a@b.com', subject: 'Hi', body: 'x' }, ctx)).rejects.toThrow('network lost');
    expect(calls).toHaveLength(0);
  });

  it('trims a trailing slash off APP_API_URL', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({ success: true, messageId: 'm2' }), { status: 200 }));
    const ctx = makeActionContext({
      db: dbReturningAccounts([{ id: 'mac_1', email: 'sender@test.com', isDefault: true }]),
      env: { INTERNAL_API_SECRET: 'secret', APP_API_URL: 'http://localhost:8789/' },
    });

    await handleSendEmail({ to: 'a@b.com', subject: 'Hi', body: 'x' }, ctx);
    expect(calls[0].url).toBe('http://localhost:8789/api/internal/send-email');
  });

  it('falls back to the production app-api host when APP_API_URL is unset', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({ success: true, messageId: 'm3' }), { status: 200 }));
    const ctx = makeActionContext({
      db: dbReturningAccounts([{ id: 'mac_1', email: 'sender@test.com', isDefault: true }]),
      env: { INTERNAL_API_SECRET: 'secret' },
    });

    await handleSendEmail({ to: 'a@b.com', subject: 'Hi', body: 'x' }, ctx);
    expect(calls[0].url).toBe('https://app-api.weldsuite.org/api/internal/send-email');
  });

  it('keeps plain-text line breaks and escapes the text for the HTML part', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({ success: true, messageId: 'm4' }), { status: 200 }));
    const ctx = makeActionContext({
      db: dbReturningAccounts([{ id: 'mac_1', email: 'sender@test.com', isDefault: true }]),
      env: { INTERNAL_API_SECRET: 'secret' },
    });

    await handleSendEmail({ to: 'a@b.com', subject: 'Hi', body: 'Line 1\nA < B', isHtml: false }, ctx);
    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent.html).toBe('Line 1<br>A &lt; B');
    expect(sent.text).toBe('Line 1\nA < B');
  });

  describe('recipient validation', () => {
    const acct = [{ id: 'mac_1', email: 'sender@test.com', isDefault: true }];

    it('fails at once, non-retryably, on an invalid To address without calling the mail service', async () => {
      const { calls } = stubFetch(() => new Response('{}', { status: 200 }));
      const ctx = makeActionContext({ db: dbReturningAccounts(acct), env: { INTERNAL_API_SECRET: 's' } });

      const err = await handleSendEmail({ to: 'not-an-email', subject: 'Hi' }, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(NonRetryableStepError);
      expect((err as Error).message).toBe('Recipient address "not-an-email" is not valid');
      expect(calls).toHaveLength(0);
    });

    it('names the first invalid address in a list and in cc/bcc', async () => {
      const ctx = makeActionContext({ db: dbReturningAccounts(acct), env: { INTERNAL_API_SECRET: 's' } });
      await expect(handleSendEmail({ to: 'a@b.com, oops', subject: 'Hi' }, ctx)).rejects.toThrow(
        'Recipient address "oops" is not valid',
      );
      await expect(handleSendEmail({ to: ['a@b.com'], cc: 'bad', subject: 'Hi' }, ctx)).rejects.toThrow(
        'Recipient address "bad" is not valid (Cc)',
      );
      await expect(handleSendEmail({ to: 'a@b.com', bcc: ['x@y.zz', 'bad'], subject: 'Hi' }, ctx)).rejects.toThrow(
        '(Bcc)',
      );
    });

    it('explains an empty To after variable resolution', async () => {
      const ctx = makeActionContext({ db: dbReturningAccounts(acct), env: { INTERNAL_API_SECRET: 's' } });
      const err = await handleSendEmail({ to: '  ', subject: 'Hi' }, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(NonRetryableStepError);
      expect((err as Error).message).toBe('No recipient address: "To" resolved to an empty value');
    });

    it('accepts "Name <addr>" recipients and comma lists, and sends cc/bcc as arrays', async () => {
      const { calls } = stubFetch(() => new Response(JSON.stringify({ success: true, messageId: 'm9' }), { status: 200 }));
      const ctx = makeActionContext({ db: dbReturningAccounts(acct), env: { INTERNAL_API_SECRET: 's' } });
      await handleSendEmail({ to: 'Ada <ada@b.com>, c@d.nl', cc: 'e@f.com, g@h.com', subject: 'Hi' }, ctx);
      const sent = JSON.parse(String(calls[0].init?.body));
      expect(sent.to).toEqual(['Ada <ada@b.com>', 'c@d.nl']);
      expect(sent.cc).toEqual(['e@f.com', 'g@h.com']);
      expect(sent.bcc).toBeUndefined();
    });

    it('turns the mail service validation 500 into a readable, non-retryable failure with the raw payload kept', async () => {
      const raw =
        '{"success":false,"error":"send_email failed for x@y.zz: Error (E_VALIDATION_ERROR) invalid mail from email address (x@y.zz): Invalid input"}';
      stubFetch(() => new Response(raw, { status: 500 }));
      const ctx = makeActionContext({ db: dbReturningAccounts(acct), env: { INTERNAL_API_SECRET: 's' } });

      const err = await handleSendEmail({ to: 'x@y.zz', subject: 'Hi' }, ctx).catch((e) => e);
      expect(err).toBeInstanceOf(NonRetryableStepError);
      expect((err as Error).message).toBe(
        'Email send failed: invalid mail from email address (x@y.zz): Invalid input',
      );
      expect((err as NonRetryableStepError).details).toEqual({ status: 500, body: raw });
    });

    it('treats a 4xx from the mail service as non-retryable but a plain 500 as retryable', async () => {
      const ctx = makeActionContext({ db: dbReturningAccounts(acct), env: { INTERNAL_API_SECRET: 's' } });
      stubFetch(() => new Response('{"error":"bad payload"}', { status: 400 }));
      expect(await handleSendEmail({ to: 'a@b.com', subject: 'Hi' }, ctx).catch((e) => e)).toBeInstanceOf(
        NonRetryableStepError,
      );
      stubFetch(() => new Response('{"error":"upstream down"}', { status: 503 }));
      const err = await handleSendEmail({ to: 'a@b.com', subject: 'Hi' }, ctx).catch((e) => e);
      expect(err).not.toBeInstanceOf(NonRetryableStepError);
      expect((err as Error).message).toBe('Email send failed: upstream down');
    });
  });

  it('throws when the subject is empty', async () => {
    const ctx = makeActionContext({
      db: dbReturningAccounts([{ id: 'mac_1', email: 'sender@test.com', isDefault: true }]),
      env: { INTERNAL_API_SECRET: 's' },
    });
    await expect(handleSendEmail({ to: 'a@b.com', subject: '  ' }, ctx)).rejects.toThrow(/subject/i);
  });

  it('throws when there are no recipients', async () => {
    const ctx = makeActionContext({ db: dbReturningAccounts([]) });
    await expect(handleSendEmail({ to: '' }, ctx)).rejects.toThrow(/recipient/i);
  });

  it('throws when no mail account is configured', async () => {
    const ctx = makeActionContext({ db: dbReturningAccounts([]), env: { INTERNAL_API_SECRET: 's' } });
    await expect(handleSendEmail({ to: 'a@b.com', subject: 'x' }, ctx)).rejects.toThrow(/account/i);
  });
});

// --- slack_message: integration (pglite) + stubbed Slack API ----------------

describe('slack_message (pglite + integration)', () => {
  let db: Database;
  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(schema.workflowIntegrations).values({
      id: generateId('win'),
      name: 'Team Slack',
      type: 'slack',
      status: 'connected',
      oauthTokens: { accessToken: 'xoxb-test' },
    });
  });

  it('posts to chat.postMessage with the integration bearer token', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({ ok: true, ts: '1.2' }), { status: 200 }));
    const res = (await handleSlackMessage(
      { channel: '#general', text: 'hello' },
      makeActionContext({ db }),
    )) as { sent: boolean };

    expect(res.sent).toBe(true);
    expect(calls[0].url).toContain('slack.com/api/chat.postMessage');
    const auth = new Headers(calls[0].init?.headers).get('authorization');
    expect(auth).toBe('Bearer xoxb-test');
    expect(String(calls[0].init?.body)).toContain('#general');
  });

  it('throws when Slack responds ok:false', async () => {
    stubFetch(() => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }));
    await expect(
      handleSlackMessage({ channel: '#nope', text: 'x' }, makeActionContext({ db })),
    ).rejects.toThrow(/channel_not_found|slack/i);
  });
});
