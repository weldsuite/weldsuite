import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { handleGmailSendEmail } from './gmail';
import { makeActionContext } from '../../../test/ctx';
import { createPgliteDb } from '../../../test/pglite';
import { schema, type Database } from '../../../db';
import { generateId } from '../../../lib/id';
import { NonRetryableStepError } from '../../errors';

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
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

/** Decode the base64url `raw` field of the last Gmail send call's body. */
function decodedRaw(body: string): string {
  const { raw } = JSON.parse(body) as { raw: string };
  const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

describe('gmail.send_email (pglite + stubbed Gmail API)', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(schema.workspaceMembers).values({ id: 'wm_owner_1', userId: 'owner_1' });
    await db.insert(schema.workflowIntegrations).values({
      id: generateId('win'),
      name: 'Gmail',
      type: 'gmail',
      status: 'connected',
      oauthTokens: { accessToken: 'ya29-test' },
    });
  });

  it('rejects without a valid "to", subject, or body before calling Gmail', async () => {
    const { mock } = stubFetch(() => new Response('{}'));
    await expect(
      handleGmailSendEmail({ subject: 's', body: 'b' }, makeActionContext({ db })),
    ).rejects.toThrow(NonRetryableStepError);
    await expect(
      handleGmailSendEmail({ to: 'not-an-email', subject: 's', body: 'b' }, makeActionContext({ db })),
    ).rejects.toThrow(/not valid/);
    await expect(
      handleGmailSendEmail({ to: 'jane@acme.com', body: 'b' }, makeActionContext({ db })),
    ).rejects.toThrow(/subject/i);
    await expect(
      handleGmailSendEmail({ to: 'jane@acme.com', subject: 's' }, makeActionContext({ db })),
    ).rejects.toThrow(/body/i);
    expect(mock).not.toHaveBeenCalled();
  });

  it('rejects an invalid cc/bcc address even when "to" is fine', async () => {
    await expect(
      handleGmailSendEmail(
        { to: 'jane@acme.com', cc: 'not-an-email', subject: 's', body: 'b' },
        makeActionContext({ db }),
      ),
    ).rejects.toThrow(/not valid \(Cc\)/);
  });

  it('sends HTML by default and returns { ok, id, threadId }', async () => {
    const { calls } = stubFetch(() =>
      new Response(JSON.stringify({ id: 'msg1', threadId: 'thread1' }), { status: 200 }),
    );
    const result = await handleGmailSendEmail(
      { to: 'jane@acme.com', subject: 'Hello', body: '<b>Hi</b>' },
      makeActionContext({ db }),
    );
    expect(result).toEqual({ ok: true, id: 'msg1', threadId: 'thread1' });
    expect(calls[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    const raw = decodedRaw(String(calls[0].init?.body));
    expect(raw).toContain('To: jane@acme.com');
    expect(raw).toContain('Subject: Hello');
    expect(raw).toContain('<b>Hi</b>');
  });

  it('escapes and line-breaks the body when isHtml is false', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({ id: 'm' }), { status: 200 }));
    await handleGmailSendEmail(
      { to: 'jane@acme.com', subject: 'Hi', body: 'line one\nline <two>', isHtml: false },
      makeActionContext({ db }),
    );
    const raw = decodedRaw(String(calls[0].init?.body));
    expect(raw).toContain('line one<br>line &lt;two&gt;');
  });

  it('joins multiple validated To/Cc/Bcc recipients', async () => {
    const { calls } = stubFetch(() => new Response(JSON.stringify({ id: 'm' }), { status: 200 }));
    await handleGmailSendEmail(
      { to: 'a@acme.com, b@acme.com', cc: 'c@acme.com', subject: 'Hi', body: 'hi' },
      makeActionContext({ db }),
    );
    const raw = decodedRaw(String(calls[0].init?.body));
    expect(raw).toContain('To: a@acme.com, b@acme.com');
    expect(raw).toContain('Cc: c@acme.com');
  });

  describe('error mapping (shared ./google-errors.ts)', () => {
    it('maps a 401 to a non-retryable reconnect error', async () => {
      stubFetch(() => new Response(JSON.stringify({ error: { message: 'Invalid Credentials' } }), { status: 401 }));
      await expect(
        handleGmailSendEmail({ to: 'jane@acme.com', subject: 's', body: 'b' }, makeActionContext({ db })),
      ).rejects.toThrow(/reconnect/i);
    });

    it('maps a 403 insufficient-scope error to a non-retryable reconnect error', async () => {
      stubFetch(
        () =>
          new Response(
            JSON.stringify({ error: { message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }),
            { status: 403 },
          ),
      );
      const promise = handleGmailSendEmail({ to: 'jane@acme.com', subject: 's', body: 'b' }, makeActionContext({ db }));
      await expect(promise).rejects.toThrow(NonRetryableStepError);
      await expect(promise).rejects.toThrow(/permission/i);
    });

    it('maps a 429 to a retryable error', async () => {
      stubFetch(() => new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 }));
      const promise = handleGmailSendEmail({ to: 'jane@acme.com', subject: 's', body: 'b' }, makeActionContext({ db }));
      await expect(promise).rejects.not.toThrow(NonRetryableStepError);
    });

    it('maps a 500 to a retryable error', async () => {
      stubFetch(() => new Response('oops', { status: 500 }));
      const promise = handleGmailSendEmail({ to: 'jane@acme.com', subject: 's', body: 'b' }, makeActionContext({ db }));
      await expect(promise).rejects.not.toThrow(NonRetryableStepError);
    });
  });
});
