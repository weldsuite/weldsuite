import { describe, expect, it } from 'vitest';
import {
  checkoutErrorMessage,
  normalizePurchaseStatus,
  pollMultipleRegistrationStatuses,
} from './domain-purchase-client';

describe('checkoutErrorMessage', () => {
  const fallback = 'Checkout failed';

  it('never surfaces the missing Stripe customer / billing-setup error', () => {
    expect(
      checkoutErrorMessage(
        new Error('Workspace has no Stripe customer — complete billing setup first'),
        fallback,
      ),
    ).toBe(fallback);
  });

  it('passes through other API errors', () => {
    expect(
      checkoutErrorMessage(
        new Error('Domain example.com is not available for registration'),
        fallback,
      ),
    ).toBe('Domain example.com is not available for registration');
  });

  it('uses the fallback when the error is not an Error', () => {
    expect(checkoutErrorMessage('nope', fallback)).toBe(fallback);
  });
});

describe('normalizePurchaseStatus', () => {
  it('treats raw host_domains rows from older workers as completed', () => {
    expect(normalizePurchaseStatus('active')).toBe('completed');
    expect(normalizePurchaseStatus('registered')).toBe('completed');
    expect(normalizePurchaseStatus('completed')).toBe('completed');
  });

  it('maps in-flight and failed registrar states', () => {
    expect(normalizePurchaseStatus('pending_workflow')).toBe('registering');
    expect(normalizePurchaseStatus('pending_registration')).toBe('registering');
    expect(normalizePurchaseStatus('registration_failed')).toBe('failed');
    expect(normalizePurchaseStatus('cancelled')).toBe('failed');
    expect(normalizePurchaseStatus('pending_payment')).toBe('pending');
  });
});

describe('pollMultipleRegistrationStatuses', () => {
  it('stops when every registration is completed', async () => {
    const statuses = await pollMultipleRegistrationStatuses(
      ['dom_1'],
      () => undefined,
      async () => ({ status: 'active', domainName: 'a.com', domainId: 'dom_1' }),
      3,
      1,
    );
    expect(statuses.get('dom_1')).toMatchObject({ status: 'completed', domainId: 'dom_1' });
  });

  it('returns last statuses instead of throwing when polling times out', async () => {
    const statuses = await pollMultipleRegistrationStatuses(
      ['dom_1'],
      () => undefined,
      async () => ({ status: 'registering', domainName: 'a.com' }),
      2,
      1,
    );
    expect(statuses.get('dom_1')?.status).toBe('registering');
  });
});

