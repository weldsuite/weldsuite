import { describe, expect, it } from 'vitest';
import { ApiError } from '@weldsuite/api-client';
import {
  appAccessRequiredStatus,
  isAppAccessRequiredError,
  isDomainHasMailboxesError,
  isPaymentMethodRequiredError,
  reachErrorMessage,
} from './errors';

const t = (path: string) => path;

function apiError(status: number, code: string, message = 'server said so', details?: unknown) {
  return new ApiError(message, status, { error: { code, message, details } });
}

describe('WeldReach API errors', () => {
  it('reads the status behind APP_ACCESS_REQUIRED', () => {
    const err = apiError(403, 'APP_ACCESS_REQUIRED', 'no access', { appCode: 'weldreach', status: 'suspended' });
    expect(isAppAccessRequiredError(err)).toBe(true);
    expect(appAccessRequiredStatus(err)).toBe('suspended');
  });

  it('treats an unknown or missing status as "never requested"', () => {
    expect(appAccessRequiredStatus(apiError(403, 'APP_ACCESS_REQUIRED', 'x', { status: 'weird' }))).toBe('none');
    expect(appAccessRequiredStatus(apiError(403, 'APP_ACCESS_REQUIRED'))).toBe('none');
    expect(appAccessRequiredStatus(apiError(403, 'APP_ACCESS_REQUIRED', 'x', { status: 'none' }))).toBe('none');
  });

  it('returns null for other failures', () => {
    expect(appAccessRequiredStatus(apiError(404, 'NOT_FOUND'))).toBeNull();
    expect(appAccessRequiredStatus(new Error('boom'))).toBeNull();
    expect(isAppAccessRequiredError(undefined)).toBe(false);
  });

  it('recognises the payment and domain guards', () => {
    expect(isPaymentMethodRequiredError(apiError(402, 'PAYMENT_METHOD_REQUIRED'))).toBe(true);
    expect(isPaymentMethodRequiredError(apiError(402, 'SOMETHING_ELSE'))).toBe(true);
    expect(isPaymentMethodRequiredError(apiError(400, 'VALIDATION'))).toBe(false);
    expect(isDomainHasMailboxesError(apiError(409, 'DOMAIN_HAS_MAILBOXES'))).toBe(true);
  });

  it('explains known codes in the UI language and falls back to the server message', () => {
    expect(reachErrorMessage(apiError(402, 'PAYMENT_METHOD_REQUIRED'), t)).toBe('reach.errors.paymentMethodRequired');
    expect(reachErrorMessage(apiError(409, 'DOMAIN_HAS_MAILBOXES'), t)).toBe('reach.errors.domainHasMailboxes');
    expect(reachErrorMessage(apiError(403, 'FORBIDDEN'), t)).toBe('reach.errors.forbidden');
    expect(reachErrorMessage(apiError(422, 'LIMIT', 'Mailbox limit reached'), t)).toBe('Mailbox limit reached');
    expect(reachErrorMessage(new Error('boom'), t)).toBe('reach.errors.generic');
  });
});
