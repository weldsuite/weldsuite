/** Fixtures of the new-run tests: vendors with bills, in the shape of `GET /api/payment-runs/payable-bills`. Not a test file. */
import type { PayableBill, PayableVendor, VendorAchReadiness } from '@/lib/api/domains/weldbooks-payment-runs';

export function makeAch(overrides: Partial<VendorAchReadiness> = {}): VendorAchReadiness {
  return {
    hasRouting: true,
    hasAccount: true,
    hasAccountType: true,
    routingValid: true,
    last4: '6789',
    accountType: 'checking',
    bankDetailsChangedAt: null,
    bankDetailsVerifiedAt: null,
    verified: true,
    holdActive: false,
    ready: true,
    prenote: 'proven',
    held: false,
    ...overrides,
  };
}

export function makeBill(id: string, balanceDue: string, overrides: Partial<PayableBill> = {}): PayableBill {
  return {
    id,
    billNumber: `INV-${id}`,
    reference: null,
    status: 'approved',
    issueDate: '2026-09-01T00:00:00.000Z',
    dueDate: '2026-10-01T00:00:00.000Z',
    daysOverdue: 0,
    currency: 'USD',
    total: balanceDue,
    balanceDue,
    inOpenRunId: null,
    ...overrides,
  };
}

export function makeVendor(partyId: string, name: string, bills: PayableBill[], overrides: Partial<PayableVendor> = {}): PayableVendor {
  const total = bills.reduce((sum, bill) => sum + Number.parseFloat(bill.balanceDue ?? '0'), 0);
  return {
    partyId,
    name,
    addressLines: [],
    totalDue: total.toFixed(2),
    ach: makeAch(),
    backupWithholding: { applies: false },
    bills,
    ...overrides,
  };
}

/** Acme: fine to pay. Brightline: bank details changed and unverified. Cobalt: no bank details. Delta: bill already in another run. */
export function makeVendors(): PayableVendor[] {
  return [
    makeVendor('par_acme', 'Acme Supplies', [makeBill('b1', '100.00'), makeBill('b2', '250.50')]),
    makeVendor('par_bright', 'Brightline LLC', [makeBill('b3', '80.00')], {
      ach: makeAch({ held: true, holdActive: true, verified: false, bankDetailsChangedAt: '2026-10-05T00:00:00.000Z' }),
    }),
    makeVendor('par_cobalt', 'Cobalt Co', [makeBill('b4', '40.00')], {
      ach: makeAch({ hasRouting: false, hasAccount: false, hasAccountType: false, ready: false, last4: null, accountType: null }),
    }),
    makeVendor('par_delta', 'Delta Freight', [makeBill('b5', '60.00', { inOpenRunId: 'prn_other' }), makeBill('b6', '15.25')]),
  ];
}
