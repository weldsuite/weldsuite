/**
 * The send_email action against app-api's guarded `/api/internal/send-email`:
 * the request names the workspace the run belongs to (the outbound mail guard
 * counts the email against it), and a refusal from the guard fails the step at
 * once and for good, with its code in the message, so a loop around the step
 * stops instead of hitting the limit once per item.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { handleSendEmail } from './communication';
import { internalApiFailure } from './helpers';
import { isNonRetryableError, NonRetryableStepError } from '../errors';
import { makeActionContext } from '../../test/ctx';
import type { WorkflowDb } from '../types';

const accounts = [{ id: 'mac_1', email: 'sender@test.com', isDefault: true }];

function dbReturningAccounts(rows: unknown[]): WorkflowDb {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  } as unknown as WorkflowDb;
}

function stubFetch(impl: () => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return impl();
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const denial = (code: string, message: string, details: Record<string, unknown> = { code }) =>
  JSON.stringify({ error: { code, message, details } });

describe('send_email: workspace on the request', () => {
  it("sends the run's workspace along, for the outbound guard to count the email against", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ success: true, messageId: 'm1' }), { status: 200 }));
    const ctx = makeActionContext({
      db: dbReturningAccounts(accounts),
      env: { INTERNAL_API_SECRET: 's' },
      tenant: { workspaceId: 'org_flow', userId: 'user_1' },
    });

    await handleSendEmail({ to: 'a@b.com', subject: 'Hi', body: 'x' }, ctx);

    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({
      workspaceId: 'org_flow',
      from: 'sender@test.com',
      to: ['a@b.com'],
    });
  });
});

describe('send_email: a refusal from the outbound guard', () => {
  const ctxFor = () =>
    makeActionContext({ db: dbReturningAccounts(accounts), env: { INTERNAL_API_SECRET: 's' } });

  it.each([
    ['SENDING_LIMITED', 429, 'Sending limit reached (150 recipients per day).', { code: 'SENDING_LIMITED', window: 'day', limit: 150 }],
    ['FIRST_CONTACT_LIMITED', 429, 'Limit reached for new recipients.', { code: 'FIRST_CONTACT_LIMITED' }],
    ['PLATFORM_LIMITED', 429, 'Mail to new recipients is paused for today.', { code: 'PLATFORM_LIMITED' }],
    ['SENDING_ON_HOLD', 403, 'New conversations are paused.', { code: 'SENDING_ON_HOLD' }],
    ['SENDING_SUSPENDED', 403, 'Sending is suspended for this workspace.', { code: 'SENDING_SUSPENDED' }],
    ['SENDER_NOT_OWNED', 403, 'This workspace cannot send from that address.', { code: 'SENDER_NOT_OWNED' }],
    ['RECIPIENT_SUPPRESSED', 422, 'A recipient reported earlier mail as spam.', { code: 'RECIPIENT_SUPPRESSED' }],
  ])('fails the step for good on %s (status %i), with the code in the message and the details', async (code, status, message, details) => {
    stubFetch(() => new Response(denial(code, message, details), { status }));

    const err = await handleSendEmail({ to: 'a@b.com', subject: 'Hi', body: 'x' }, ctxFor()).catch((e) => e);

    // 429 is retryable for any other failure; a guard refusal never is.
    expect(err).toBeInstanceOf(NonRetryableStepError);
    expect(isNonRetryableError(err)).toBe(true);
    expect((err as Error).message).toBe(`Email send blocked (${code}): ${message}`);
    expect((err as NonRetryableStepError).details).toMatchObject({ status, code });
  });

  it('leaves other 429s and 5xxs alone: a rate limit that is not the guard is still retryable', async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'slow down' } }), { status: 429 }));
    const err = await handleSendEmail({ to: 'a@b.com', subject: 'Hi', body: 'x' }, ctxFor()).catch((e) => e);
    expect(err).not.toBeInstanceOf(NonRetryableStepError);
    expect((err as Error).message).toBe('Email send failed: slow down');
  });
});

describe('internalApiFailure', () => {
  it('recognises the guard by the error code in the app-api envelope, whatever the label', () => {
    const err = internalApiFailure('Email send', 429, denial('SENDING_LIMITED', 'Sending limit reached.'));
    expect(isNonRetryableError(err)).toBe(true);
    expect(err.message).toBe('Email send blocked (SENDING_LIMITED): Sending limit reached.');
  });

  it('does not mistake an unrelated error body, or one that is not JSON, for a guard refusal', () => {
    expect(internalApiFailure('Email send', 500, '{"success":false,"error":"boom"}').message).toBe('Email send failed: boom');
    expect(internalApiFailure('Email send', 502, '<html>bad gateway</html>').message).toContain('502');
    expect(internalApiFailure('Email send', 503, denial('SOMETHING_ELSE', 'nope')).message).not.toContain('blocked');
  });
});
