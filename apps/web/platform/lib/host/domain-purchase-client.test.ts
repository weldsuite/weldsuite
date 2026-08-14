import { describe, expect, it, vi } from 'vitest';
import {
  checkoutErrorMessage,
  normalizePurchaseStatus,
  pollMultipleRegistrationStatuses,
  type CheckStatusFn,
  type RawDomainPurchaseStatus,
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
    const checkStatus: CheckStatusFn = async () => ({
      status: 'active',
      domainName: 'a.com',
      domainId: 'dom_1',
    });
    const statuses = await pollMultipleRegistrationStatuses(
      ['dom_1'],
      () => undefined,
      checkStatus,
      3,
      1,
    );
    expect(statuses.get('dom_1')).toMatchObject({ status: 'completed', domainId: 'dom_1' });
  });

  it('marks unresolved registrations as timeout when polling is exhausted', async () => {
    const checkStatus: CheckStatusFn = async () => ({
      status: 'registering',
      domainName: 'a.com',
    });
    const statuses = await pollMultipleRegistrationStatuses(
      ['dom_1'],
      () => undefined,
      checkStatus,
      2,
      1,
    );
    expect(statuses.get('dom_1')?.status).toBe('timeout');
    expect(statuses.get('dom_1')?.error).toMatch(/timed out/i);
  });

  it('records a rejected check as failed without aborting sibling registrations', async () => {
    const checkStatus: CheckStatusFn = async (id) => {
      if (id === 'dom_fail') {
        throw new Error('registrar unreachable');
      }
      const payload: RawDomainPurchaseStatus = {
        status: 'registered',
        domainName: 'ok.com',
        domainId: id,
      };
      return payload;
    };

    const onStatusUpdate = vi.fn();
    const statuses = await pollMultipleRegistrationStatuses(
      ['dom_ok', 'dom_fail'],
      onStatusUpdate,
      checkStatus,
      3,
      1,
    );

    expect(statuses.get('dom_ok')).toMatchObject({ status: 'completed', domainName: 'ok.com' });
    expect(statuses.get('dom_fail')).toMatchObject({
      status: 'failed',
      error: 'registrar unreachable',
    });
    expect(onStatusUpdate).toHaveBeenCalled();
  });
});
