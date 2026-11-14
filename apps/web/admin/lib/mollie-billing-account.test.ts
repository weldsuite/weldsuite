import { describe, expect, it } from 'vitest';
import { toMollieBillingAccount, type MollieAccountRow } from './mollie-billing-account';

const row = (account: Partial<MollieAccountRow['account']> = {}, rest: Partial<MollieAccountRow> = {}): MollieAccountRow => ({
  account: {
    customerId: 'cst_1',
    mandateId: 'mdt_1',
    mandateMethod: 'creditcard',
    mandateLabel: 'Visa •••• 4242',
    unitAmount: 4900,
    currency: 'EUR',
    anchorDay: 14,
    nextChargeAt: new Date('2026-12-14T10:00:00.000Z'),
    scheduledPlanId: null,
    scheduledSeats: null,
    scheduledCycle: null,
    pastDueSince: null,
    pastDuePaymentId: null,
    dunningRemindedAt: null,
    ...account,
  },
  scheduledPlanName: null,
  chargeId: null,
  chargeProviderPaymentId: null,
  chargeAmount: null,
  chargeCurrency: null,
  chargeStatus: null,
  chargeFailureMessage: null,
  ...rest,
});

describe('toMollieBillingAccount', () => {
  it('reads a paid-up account', () => {
    expect(toMollieBillingAccount(row())).toEqual({
      customerId: 'cst_1',
      mandateId: 'mdt_1',
      mandateMethod: 'creditcard',
      mandateLabel: 'Visa •••• 4242',
      unitAmount: 4900,
      currency: 'EUR',
      anchorDay: 14,
      nextChargeAt: '2026-12-14T10:00:00.000Z',
      scheduled: null,
      pastDue: null,
    });
  });

  it('names what is scheduled for the period end, any part of it', () => {
    expect(toMollieBillingAccount(row({ scheduledPlanId: 'plan_team' }, { scheduledPlanName: 'Team' })).scheduled).toEqual({
      planId: 'plan_team',
      planName: 'Team',
      seats: null,
      cycle: null,
    });
    expect(toMollieBillingAccount(row({ scheduledSeats: 3 })).scheduled?.seats).toBe(3);
    expect(toMollieBillingAccount(row({ scheduledCycle: 'yearly' })).scheduled?.cycle).toBe('yearly');
  });

  it('spells out a past-due account with its open charge', () => {
    const account = toMollieBillingAccount(
      row(
        {
          nextChargeAt: null,
          pastDueSince: new Date('2027-01-14T10:30:00.000Z'),
          pastDuePaymentId: 'bpy_1',
          dunningRemindedAt: new Date('2027-01-21T10:30:00.000Z'),
        },
        {
          chargeId: 'bpy_1',
          chargeProviderPaymentId: 'tr_1',
          chargeAmount: 12100,
          chargeCurrency: 'EUR',
          chargeStatus: 'failed',
          chargeFailureMessage: 'insufficient funds',
        },
      ),
    );
    expect(account.nextChargeAt).toBeNull();
    expect(account.pastDue).toEqual({
      since: '2027-01-14T10:30:00.000Z',
      remindedAt: '2027-01-21T10:30:00.000Z',
      charge: {
        id: 'bpy_1',
        providerPaymentId: 'tr_1',
        amount: 12100,
        currency: 'EUR',
        status: 'failed',
        failureMessage: 'insufficient funds',
      },
    });
  });

  it('keeps the id of an open charge whose row is gone, and none when there is none', () => {
    const gone = toMollieBillingAccount(row({ pastDueSince: new Date('2027-01-14T10:30:00.000Z'), pastDuePaymentId: 'bpy_9' }));
    expect(gone.pastDue?.charge).toEqual({
      id: 'bpy_9',
      providerPaymentId: null,
      amount: null,
      currency: null,
      status: null,
      failureMessage: null,
    });
    expect(gone.pastDue?.remindedAt).toBeNull();
    const none = toMollieBillingAccount(row({ pastDueSince: new Date('2027-01-14T10:30:00.000Z') }));
    expect(none.pastDue?.charge).toBeNull();
  });
});
