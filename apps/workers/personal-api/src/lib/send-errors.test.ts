/**
 * Personal send errors → responses.
 *
 * Every refusal a send can end in has a status, the `{ error: { code, message,
 * details? } }` body the other API workers use, and `Retry-After` where a retry
 * can succeed: guard denials follow `outboundDenialStatus`, Cloudflare's own
 * refusals are 429 / 503 / 502. docs/plans/weldmail-outbound-abuse.md.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { OUTBOUND_DENIAL_CODES, type OutboundDenialDetails } from '@weldsuite/app-api-client/schemas/outbound-mail';
import { PersonalMailSendError } from '../services/mail-send';
import { mapSendError } from './send-errors';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** Run `err` through the mapper the way a route's catch block does. */
async function respond(err: PersonalMailSendError) {
  const app = new Hono();
  app.get('/', (c) => mapSendError(c, err));
  const res = await app.request('/');
  return { res, body: (await res.json()) as ErrorBody };
}

const inFiveMinutes = () => new Date(Date.now() + 5 * 60_000).toISOString();

describe('guard denials', () => {
  const cases: Array<{ code: (typeof OUTBOUND_DENIAL_CODES)[number]; details: () => OutboundDenialDetails; status: number; retryAfter: boolean }> = [
    {
      code: 'SENDING_LIMITED',
      details: () => ({ code: 'SENDING_LIMITED', window: 'day', limit: 50, used: 50, retryAfter: inFiveMinutes() }),
      status: 429,
      retryAfter: true,
    },
    {
      code: 'FIRST_CONTACT_LIMITED',
      details: () => ({ code: 'FIRST_CONTACT_LIMITED', window: 'day', limit: 50, retryAfter: inFiveMinutes(), suggestWeldReach: true }),
      status: 429,
      retryAfter: true,
    },
    {
      code: 'PLATFORM_LIMITED',
      details: () => ({ code: 'PLATFORM_LIMITED', retryAfter: inFiveMinutes() }),
      status: 429,
      retryAfter: true,
    },
    { code: 'SENDING_ON_HOLD', details: () => ({ code: 'SENDING_ON_HOLD', reason: 'under_review' }), status: 403, retryAfter: false },
    { code: 'SENDING_SUSPENDED', details: () => ({ code: 'SENDING_SUSPENDED', reason: 'staff_suspension' }), status: 403, retryAfter: false },
    {
      code: 'TOO_MANY_RECIPIENTS',
      details: () => ({ code: 'TOO_MANY_RECIPIENTS', window: 'message', limit: 20, used: 30 }),
      status: 422,
      retryAfter: false,
    },
    {
      code: 'RECIPIENT_SUPPRESSED',
      details: () => ({ code: 'RECIPIENT_SUPPRESSED', recipients: ['rcpt@example.com'] }),
      status: 422,
      retryAfter: false,
    },
  ];

  it.each(cases)('$code answers $status', async ({ code, details, status, retryAfter }) => {
    const expected = details();
    const { res, body } = await respond(new PersonalMailSendError(code, 'Refused.', expected));

    expect(res.status).toBe(status);
    expect(body.error.code).toBe(code);
    expect(body.error.message).toBe('Refused.');
    expect(body.error.details).toMatchObject(expected as Record<string, unknown>);
    if (retryAfter) {
      const seconds = Number(res.headers.get('Retry-After'));
      expect(seconds).toBeGreaterThan(290);
      expect(seconds).toBeLessThanOrEqual(301);
    } else {
      expect(res.headers.get('Retry-After')).toBeNull();
    }
  });

  it('SENDER_NOT_OWNED is a 403 that does not say whose address it is', async () => {
    const { res, body } = await respond(
      new PersonalMailSendError('SENDER_NOT_OWNED', 'This workspace cannot send from that address.', {
        code: 'SENDER_NOT_OWNED',
        reason: 'address_registered_elsewhere',
      }),
    );
    expect(res.status).toBe(403);
    expect(body.error.code).toBe('SENDER_NOT_OWNED');
    expect(body.error.details).toBeUndefined();
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  it('covers every denial code in the contract', () => {
    // The table plus SENDER_NOT_OWNED is the whole set: a code added to the
    // contract needs a mapping test here.
    expect([...cases.map((c) => c.code), 'SENDER_NOT_OWNED'].sort()).toEqual([...OUTBOUND_DENIAL_CODES].sort());
  });

  it('without a retryAfter there is no Retry-After header', async () => {
    const { res } = await respond(new PersonalMailSendError('SENDING_LIMITED', 'Full.', { code: 'SENDING_LIMITED' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeNull();
  });
});

describe('Cloudflare refusals', () => {
  it('its rate limit is 429 with Retry-After: 60', async () => {
    const { res, body } = await respond(new PersonalMailSendError('PROVIDER_RATE_LIMITED', 'Slow down.'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(body.error.code).toBe('PROVIDER_RATE_LIMITED');
  });

  it('its daily quota is 503', async () => {
    const { res, body } = await respond(new PersonalMailSendError('PROVIDER_DAILY_LIMIT', 'Unavailable today.'));
    expect(res.status).toBe(503);
    expect(body.error.code).toBe('PROVIDER_DAILY_LIMIT');
  });

  it('a partial send is 502 with who got it and who did not', async () => {
    const details = { sent: ['a@example.com'], failed: ['b@example.com'] };
    const { res, body } = await respond(new PersonalMailSendError('PARTIALLY_SENT', 'Sent to 1 of 2.', details));
    expect(res.status).toBe(502);
    expect(body.error.code).toBe('PARTIALLY_SENT');
    expect(body.error.details).toEqual(details);
  });
});

describe('the errors that were already there', () => {
  it.each([
    ['ACCOUNT_NOT_FOUND', 404, 'NOT_FOUND'],
    ['MESSAGE_NOT_FOUND', 404, 'NOT_FOUND'],
    ['DAILY_LIMIT_REACHED', 403, 'PLAN_LIMIT_REACHED'],
    ['NO_RECIPIENTS', 400, 'BAD_REQUEST'],
    ['DELIVERY_FAILED', 503, 'SERVICE_UNAVAILABLE'],
  ] as const)('%s keeps its %i', async (code, status, bodyCode) => {
    const { res, body } = await respond(new PersonalMailSendError(code, 'Nope.'));
    expect(res.status).toBe(status);
    expect(body.error.code).toBe(bodyCode);
  });
});
