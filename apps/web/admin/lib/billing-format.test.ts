import { describe, expect, it } from 'vitest';
import { isLiveSubscription, keepsRequestId } from './billing-format';

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

describe('isLiveSubscription', () => {
  it('matches the statuses the billing worker can still change', () => {
    for (const status of ['active', 'trialing', 'past_due', 'unpaid']) expect(isLiveSubscription(status)).toBe(true);
    for (const status of ['incomplete', 'incomplete_expired', 'canceled', null, undefined]) {
      expect(isLiveSubscription(status)).toBe(false);
    }
  });
});
