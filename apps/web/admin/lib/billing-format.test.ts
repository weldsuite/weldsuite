import { describe, expect, it } from 'vitest';
import { actionLabel, isLiveSubscription, keepsRequestId } from './billing-format';
import { adminCopy } from './i18n';

describe('keepsRequestId', () => {
  it('keeps the idempotency key when the write may have happened', () => {
    for (const code of ['UNREACHABLE', 'UPSTREAM', 'INTERNAL', 'STRIPE_UNAVAILABLE']) {
      expect(keepsRequestId(code)).toBe(true);
    }
  });

  it('renews it after a definite rejection', () => {
    for (const code of ['BAD_REQUEST', 'NOT_FOUND', 'CONFLICT', 'NOT_CONFIGURED', 'STRIPE_REJECTED', undefined]) {
      expect(keepsRequestId(code)).toBe(false);
    }
  });
});

describe('actionLabel', () => {
  it('labels the Mollie card’s seat price change in the activity log', () => {
    expect(actionLabel(adminCopy(), 'workspace.billing.seat_price')).toBe('Seat price changed');
  });

  it('leaves an action it doesn’t know as it is', () => {
    expect(actionLabel(adminCopy(), 'workspace.billing.unknown')).toBe('workspace.billing.unknown');
  });
});

describe('isLiveSubscription', () => {
  it('matches the statuses the billing worker can still change', () => {
    for (const status of ['active', 'trialing', 'past_due', 'unpaid']) expect(isLiveSubscription(status)).toBe(true);
    for (const status of ['incomplete', 'incomplete_expired', 'canceled', null, undefined]) {
      expect(isLiveSubscription(status)).toBe(false);
    }
  });
});
