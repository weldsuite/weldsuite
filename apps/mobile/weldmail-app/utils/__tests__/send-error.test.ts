import { ApiError } from '@weldsuite/api-client/client';
import { describeRetryAfter, describeSendError, readApiError } from '../send-error';

const NOW = new Date('2026-10-13T12:00:00.000Z');

function inMinutes(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

function apiError(code: string, details?: unknown, status = 429): ApiError {
  return new ApiError(`${code} message`, status, { error: { code, message: `${code} message`, details } });
}

describe('readApiError', () => {
  it('reads code, message and details from an API error response', () => {
    expect(readApiError(apiError('SENDING_LIMITED', { window: 'day' }))).toEqual({
      code: 'SENDING_LIMITED',
      message: 'SENDING_LIMITED message',
      details: { window: 'day' },
    });
  });

  it('is null for anything else', () => {
    expect(readApiError(new Error('boom'))).toBeNull();
    expect(readApiError(null)).toBeNull();
    expect(readApiError(new ApiError('Request failed', 500, { error: 'plain string' }))).toBeNull();
    expect(readApiError(new ApiError('Request failed', 500, undefined))).toBeNull();
  });
});

describe('describeRetryAfter', () => {
  it('counts minutes, hours and days, rounding up', () => {
    expect(describeRetryAfter(inMinutes(0.2), NOW)).toBe('in 1 minute');
    expect(describeRetryAfter(inMinutes(25), NOW)).toBe('in 25 minutes');
    expect(describeRetryAfter(inMinutes(61), NOW)).toBe('in 2 hours');
    expect(describeRetryAfter(inMinutes(24 * 60), NOW)).toBe('tomorrow');
    expect(describeRetryAfter(inMinutes(3 * 24 * 60), NOW)).toBe('in 3 days');
  });

  it('says "in a moment" once the time has passed and null for junk', () => {
    expect(describeRetryAfter(inMinutes(-1), NOW)).toBe('in a moment');
    expect(describeRetryAfter('nope', NOW)).toBeNull();
    expect(describeRetryAfter(undefined, NOW)).toBeNull();
  });
});

describe('describeSendError', () => {
  it('names the limit and when to try again for SENDING_LIMITED', () => {
    const alert = describeSendError(
      apiError('SENDING_LIMITED', { window: 'hour', limit: 30, used: 30, retryAfter: inMinutes(25) }),
      NOW,
    );
    expect(alert?.title).toBe('Hourly limit reached');
    expect(alert?.message).toContain('Limit: 30 recipients per hour.');
    expect(alert?.message).toContain('You can send again in 25 minutes.');
    expect(alert?.message).not.toContain('WeldReach');
  });

  it('sends the reader to support when only staff can lift a limit', () => {
    const alert = describeSendError(apiError('SENDING_LIMITED', { window: 'day', limit: 150 }), NOW);
    expect(alert?.message).toContain('Contact support if you need a higher limit.');
  });

  it('points at WeldReach when the guard says so', () => {
    const alert = describeSendError(apiError('SENDING_LIMITED', { window: 'day', suggestWeldReach: true }), NOW);
    expect(alert?.message).toContain('WeldReach');
  });

  it('always points outreach at WeldReach for FIRST_CONTACT_LIMITED', () => {
    const alert = describeSendError(
      apiError('FIRST_CONTACT_LIMITED', { window: 'day', limit: 50, retryAfter: inMinutes(120), reason: 'workspace_first_contact' }),
      NOW,
    );
    expect(alert?.title).toBe('New contacts limit reached');
    expect(alert?.message).toContain('Limit: 50 new contacts per day.');
    expect(alert?.message).toContain('You can send again in 2 hours.');
    expect(alert?.message).toContain('Replies to people who wrote to you are not affected.');
    expect(alert?.message).toContain('WeldReach');
    expect(describeSendError(apiError('FIRST_CONTACT_LIMITED'), NOW)?.message).toContain('WeldReach');
  });

  it('explains the cold-outreach and shared-domain reasons', () => {
    expect(describeSendError(apiError('FIRST_CONTACT_LIMITED', { reason: 'cold_outreach_template' }), NOW)?.message).toContain(
      'Messages like this one are limited',
    );
    expect(describeSendError(apiError('FIRST_CONTACT_LIMITED', { reason: 'weldmail_shared_domain' }), NOW)?.message).toContain(
      'weldmail.com',
    );
  });

  it('says replies still work while on hold', () => {
    const alert = describeSendError(apiError('SENDING_ON_HOLD', undefined, 403), NOW);
    expect(alert?.title).toBe('New conversations paused');
    expect(alert?.message).toContain('still reply');
  });

  it('maps a suspension and a foreign sender address', () => {
    expect(describeSendError(apiError('SENDING_SUSPENDED', undefined, 403), NOW)?.title).toBe('Sending suspended');
    expect(describeSendError(apiError('SENDER_NOT_OWNED', undefined, 403), NOW)?.title).toBe("Can't send from this address");
  });

  it('shows the platform budget reset', () => {
    const alert = describeSendError(apiError('PLATFORM_LIMITED', { retryAfter: inMinutes(6 * 60) }), NOW);
    expect(alert?.message).toContain('You can send again in 6 hours.');
  });

  it('names suppressed and invalid recipients', () => {
    expect(describeSendError(apiError('RECIPIENT_SUPPRESSED', { recipients: ['a@x.com', 'b@x.com'] }, 422), NOW)?.message).toContain(
      'a@x.com, b@x.com',
    );
    expect(describeSendError(apiError('RECIPIENT_SUPPRESSED', undefined, 422), NOW)?.message).toContain('Remove them');
    expect(
      describeSendError(apiError('INVALID_RECIPIENTS', { invalidFormat: ['nope'], unreachableDomains: ['gone.invalid'] }, 400), NOW)
        ?.message,
    ).toBe('These recipient addresses cannot be used: nope, gone.invalid.');
  });

  it('says who got a partially sent message and who did not', () => {
    const alert = describeSendError(
      apiError('PARTIALLY_SENT', { sent: ['a@x.com'], failed: ['b@x.com', 'c@x.com'], messageId: 'msg_1' }, 502),
      NOW,
    );
    expect(alert?.title).toBe('Partly sent');
    expect(alert?.message).toContain('reached a@x.com but not b@x.com, c@x.com');
    expect(describeSendError(apiError('PARTIALLY_SENT', undefined, 502), NOW)).toBeNull();
  });

  it('maps the provider and pre-guard codes', () => {
    expect(describeSendError(apiError('PROVIDER_RATE_LIMITED'), NOW)?.title).toBe('Slow down for a moment');
    expect(describeSendError(apiError('PROVIDER_DAILY_LIMIT', undefined, 503), NOW)?.title).toBe('Mail temporarily unavailable');
    expect(describeSendError(apiError('DAILY_LIMIT_REACHED'), NOW)?.title).toBe('Daily limit reached');
    expect(describeSendError(apiError('SENDER_DOMAIN_NOT_VERIFIED', undefined, 422), NOW)?.title).toBe('Domain not verified');
    expect(describeSendError(apiError('EMAIL_TOO_LARGE', undefined, 400), NOW)?.title).toBe('Email too large');
  });

  it('is null for failures it has no words for, so the composer keeps its generic alert', () => {
    expect(describeSendError(apiError('SOMETHING_NEW'), NOW)).toBeNull();
    expect(describeSendError(new Error('Network request failed'), NOW)).toBeNull();
  });
});
