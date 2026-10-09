import { describe, it, expect } from 'vitest';
import {
  compute1099Totals,
  isCorporationClassification,
  splitProRata,
  type Compute1099Bill,
  type Compute1099Input,
  type Compute1099Payment,
  type Compute1099Vendor,
} from './form-1099-compute';

const vendor = (partyId: string, overrides: Partial<Compute1099Vendor> = {}): Compute1099Vendor => ({
  partyId,
  name: partyId,
  is1099Vendor: true,
  defaultForm: 'nec',
  defaultBox: 'nec_1',
  tinType: 'ssn',
  tinLast4: '1234',
  federalTaxClassification: 'individual',
  addressComplete: true,
  ...overrides,
});

const payment = (id: string, partyId: string, amount: number, overrides: Partial<Compute1099Payment> = {}): Compute1099Payment => ({
  id,
  partyId,
  date: '2026-06-15',
  amount,
  paymentMethod: 'check',
  ...overrides,
});

const run = (overrides: Partial<Compute1099Input>) =>
  compute1099Totals({ taxYear: 2026, vendors: [], payments: [], ...overrides });

const byParty = (result: ReturnType<typeof compute1099Totals>, partyId: string) => {
  const found = result.vendors.find((entry) => entry.partyId === partyId);
  if (!found) throw new Error(`no result for ${partyId}`);
  return found;
};

describe('plan scenario 8: 1099 aggregation', () => {
  const vendors = [
    vendor('alice'),
    vendor('bob'),
    vendor('acme', { federalTaxClassification: 'c_corporation' }),
    vendor('lawfirm', { federalTaxClassification: 's_corporation', isAttorney: true }),
  ];
  const payments = [
    payment('p-alice-check', 'alice', 2500),
    payment('p-alice-card', 'alice', 3000, { paymentMethod: 'credit_card' }),
    payment('p-bob', 'bob', 1200),
    payment('p-acme', 'acme', 9000),
    payment('p-law', 'lawfirm', 5000),
  ];

  it('counts only the check for a vendor paid by check and credit card, and leaves out the rest', () => {
    const result = run({ vendors, payments });
    const alice = byParty(result, 'alice');
    expect(alice.status).toBe('included');
    expect(alice.boxes).toEqual({ nec_1: 2500 });
    expect(alice.exclusions).toEqual([
      { reason: 'card_or_network_method', paymentMethod: 'credit_card', amount: 3000, paymentId: 'p-alice-card' },
    ]);
    expect(alice.reasons.join(' ')).toContain('1099-K');

    expect(byParty(result, 'bob')).toMatchObject({ status: 'below_threshold', boxes: {} });
    expect(byParty(result, 'acme')).toMatchObject({ status: 'excluded_corporation', boxes: {}, isCorporation: true });
    expect(byParty(result, 'lawfirm')).toMatchObject({ status: 'included', boxes: { nec_1: 5000 } });
    expect(result.summary).toMatchObject({ included: 2, below_threshold: 1, excluded_corporation: 1 });
  });

  it('checks the same payments against $600 for 2025 and $2,000 for 2026', () => {
    const bob2025 = run({ taxYear: 2025, vendors: [vendor('bob')], payments: [payment('p', 'bob', 1200, { date: '2025-03-01' })] });
    const bob2026 = run({ taxYear: 2026, vendors: [vendor('bob')], payments: [payment('p', 'bob', 1200, { date: '2026-03-01' })] });
    expect(byParty(bob2025, 'bob')).toMatchObject({ status: 'included', boxes: { nec_1: 1200 } });
    expect(byParty(bob2026, 'bob').status).toBe('below_threshold');
    expect(byParty(bob2026, 'bob').reasons[0]).toContain('$2,000.00');
  });

  it('reports a vendor paid exactly the threshold', () => {
    const at = run({ vendors: [vendor('v')], payments: [payment('p', 'v', 2000)] });
    const under = run({ vendors: [vendor('v')], payments: [payment('p', 'v', 1999.99)] });
    expect(byParty(at, 'v').status).toBe('included');
    expect(byParty(under, 'v').status).toBe('below_threshold');
    const at600 = run({ taxYear: 2025, vendors: [vendor('v')], payments: [payment('p', 'v', 600, { date: '2025-05-05' })] });
    expect(byParty(at600, 'v').status).toBe('included');
  });
});

describe('exclusions', () => {
  it('reads the payment method and the paying account, not the reference', () => {
    const result = run({
      vendors: [vendor('v')],
      payments: [
        payment('check', 'v', 1000),
        payment('debit', 'v', 100, { paymentMethod: 'debit_card' }),
        payment('network', 'v', 200, { paymentMethod: 'third_party_network' }),
        payment('cc-account', 'v', 300, { paymentMethod: 'ach', fromCreditCardAccount: true }),
        payment('cash', 'v', 1500, { paymentMethod: 'cash' }),
        payment('wire', 'v', 700, { paymentMethod: 'wire' }),
      ],
    });
    const v = byParty(result, 'v');
    expect(v.boxes).toEqual({ nec_1: 3200 });
    expect(v.exclusions.map((entry) => entry.reason)).toEqual([
      'card_or_network_method',
      'card_or_network_method',
      'credit_card_account',
    ]);
    expect(v.paymentIds).toEqual(['check', 'cash', 'wire']);
  });

  it('leaves out payments run through payroll, voided payments and payments from other years', () => {
    const result = run({
      vendors: [vendor('v')],
      payments: [
        payment('payroll', 'v', 5000, { paidThroughPayroll: true }),
        payment('void', 'v', 5000, { voided: true }),
        payment('last-year', 'v', 5000, { date: '2025-12-31' }),
        payment('next-year', 'v', 5000, { date: '2027-01-01' }),
        payment('ok', 'v', 2500),
      ],
    });
    const v = byParty(result, 'v');
    expect(v.boxes).toEqual({ nec_1: 2500 });
    expect(v.exclusions).toEqual([{ reason: 'paid_through_payroll', amount: 5000, paymentId: 'payroll' }]);
  });

  it('warns about payments to parties that are not in the vendor list', () => {
    const result = run({ vendors: [], payments: [payment('p', 'ghost', 5000)] });
    expect(result.vendors).toEqual([]);
    expect(result.warnings[0]).toContain('p');
  });
});

describe('allocation over bill lines', () => {
  const bill: Compute1099Bill = {
    id: 'bill-1',
    lines: [
      { id: 'l1', amount: 800, accountId: 'acc-labor' },
      { id: 'l2', amount: 200, accountId: 'acc-rent' },
    ],
  };
  const accountBoxes = { 'acc-labor': 'nec_1', 'acc-rent': 'misc_1', 'acc-meals': 'omit' };

  it('splits a partial payment pro rata over the lines and maps each to its box', () => {
    const result = run({
      vendors: [vendor('v', { defaultBox: null, defaultForm: null })],
      bills: [bill],
      accountBoxes,
      payments: [payment('p', 'v', 500, { allocations: [{ billId: 'bill-1', amount: 500 }] })],
    });
    const v = byParty(result, 'v');
    expect(v.totals).toEqual({ nec_1: 400, misc_1: 100 });
    expect(v.contributions).toEqual([
      { box: 'nec_1', amount: 400, paymentId: 'p', billId: 'bill-1', billLineId: 'l1', boxSource: 'account', unapplied: undefined },
      { box: 'misc_1', amount: 100, paymentId: 'p', billId: 'bill-1', billLineId: 'l2', boxSource: 'account', unapplied: undefined },
    ]);
  });

  it('keeps each line sales tax in the box of its own line', () => {
    const taxed: Compute1099Bill = {
      id: 'bill-t',
      lines: [
        { id: 't1', amount: 100, taxAmount: 10, accountId: 'acc-labor' },
        { id: 't2', amount: 100, taxAmount: 0, accountId: 'acc-rent' },
      ],
    };
    const result = run({
      vendors: [vendor('v')],
      bills: [taxed],
      accountBoxes,
      payments: [payment('p', 'v', 210, { allocations: [{ billId: 'bill-t', amount: 210 }] })],
    });
    expect(byParty(result, 'v').totals).toEqual({ nec_1: 110, misc_1: 100 });
  });

  it('splits cents so the parts add up to the payment', () => {
    const thirds: Compute1099Bill = {
      id: 'bill-3',
      lines: [
        { id: 'a', amount: 100, accountId: 'acc-labor' },
        { id: 'b', amount: 100, accountId: 'acc-labor' },
        { id: 'c', amount: 100, accountId: 'acc-rent' },
      ],
    };
    const result = run({
      vendors: [vendor('v')],
      bills: [thirds],
      accountBoxes,
      payments: [payment('p', 'v', 100, { allocations: [{ billId: 'bill-3', amount: 100 }] })],
    });
    const v = byParty(result, 'v');
    expect((v.totals.nec_1 ?? 0) + (v.totals.misc_1 ?? 0)).toBeCloseTo(100, 10);
    expect(v.contributions.map((entry) => entry.amount)).toEqual([33.34, 33.33, 33.33]);
  });

  it('resolves line override, then account default, then vendor default, and honours omit', () => {
    const mixed: Compute1099Bill = {
      id: 'bill-m',
      lines: [
        { id: 'line-override', amount: 100, accountId: 'acc-labor', form1099Box: 'misc_3' },
        { id: 'account', amount: 100, accountId: 'acc-rent' },
        { id: 'vendor', amount: 100, accountId: 'acc-unmapped' },
        { id: 'account-omit', amount: 100, accountId: 'acc-meals' },
        { id: 'line-omit', amount: 100, accountId: 'acc-labor', form1099Box: 'omit' },
      ],
    };
    const result = run({
      thresholdOverrides: { general: 1 },
      vendors: [vendor('v')],
      bills: [mixed],
      accountBoxes,
      payments: [payment('p', 'v', 500, { allocations: [{ billId: 'bill-m', amount: 500 }] })],
    });
    const v = byParty(result, 'v');
    expect(v.totals).toEqual({ misc_3: 100, misc_1: 100, nec_1: 100 });
    expect(v.contributions.map((entry) => [entry.billLineId, entry.boxSource])).toEqual([
      ['line-override', 'line'],
      ['account', 'account'],
      ['vendor', 'vendor'],
    ]);
    expect(v.exclusions.map((entry) => entry.billLineId)).toEqual(['account-omit', 'line-omit']);
  });

  it('puts the unapplied part of a payment on the vendor default box', () => {
    const result = run({
      vendors: [vendor('v')],
      bills: [bill],
      accountBoxes,
      payments: [payment('p', 'v', 3000, { allocations: [{ billId: 'bill-1', amount: 1000 }] })],
    });
    const v = byParty(result, 'v');
    expect(v.totals).toEqual({ nec_1: 2800, misc_1: 200 });
    expect(v.contributions.some((entry) => entry.unapplied && entry.amount === 2000)).toBe(true);
  });

  it('reports money without any box as unmapped instead of guessing', () => {
    const result = run({
      vendors: [vendor('v', { defaultBox: null, defaultForm: 'misc' })],
      payments: [payment('p', 'v', 5000)],
    });
    const v = byParty(result, 'v');
    expect(v.unmapped).toEqual([{ amount: 5000, paymentId: 'p', reason: 'no_box' }]);
    expect(v.status).toBe('below_threshold');
    expect(v.reasons.join(' ')).toContain('no 1099 box');
  });

  it('treats a bare default box number together with the default form', () => {
    const result = run({
      vendors: [vendor('v', { defaultForm: 'misc', defaultBox: '1' })],
      payments: [payment('p', 'v', 3000)],
    });
    expect(byParty(result, 'v').boxes).toEqual({ misc_1: 3000 });
  });
});

describe('bank transactions and adjustments', () => {
  it('adds bank lines categorized to the vendor and skips ones matched to a payment', () => {
    const result = run({
      vendors: [vendor('v')],
      accountBoxes: { 'acc-labor': 'nec_1' },
      payments: [payment('p', 'v', 1000)],
      bankTransactions: [
        { id: 't1', partyId: 'v', date: '2026-02-01', amount: 1500, accountId: 'acc-labor' },
        { id: 't2', partyId: 'v', date: '2026-02-02', amount: 1000, accountId: 'acc-labor', matchedPaymentId: 'p' },
        { id: 't3', partyId: 'v', date: '2026-02-03', amount: 400, accountId: 'acc-labor', fromCreditCardAccount: true },
        { id: 't4', partyId: 'v', date: '2025-12-31', amount: 400, accountId: 'acc-labor' },
      ],
    });
    const v = byParty(result, 'v');
    expect(v.boxes).toEqual({ nec_1: 2500 });
    expect(v.bankTransactionIds).toEqual(['t1']);
    expect(v.exclusions).toEqual([{ reason: 'credit_card_account', amount: 400, bankTransactionId: 't3' }]);
  });

  it('applies manual adjustments with a reason and ignores ones without', () => {
    const result = run({
      vendors: [vendor('v')],
      payments: [payment('p', 'v', 1500)],
      adjustments: [
        { partyId: 'v', box: 'nec_1', amount: 700, reason: 'Cash paid outside the books' },
        { partyId: 'v', box: 'nec_1', amount: 9999, reason: '  ' },
        { partyId: 'v', box: 'nec_2', amount: 5, reason: 'checkbox' },
      ],
    });
    const v = byParty(result, 'v');
    expect(v.boxes).toEqual({ nec_1: 2200 });
    expect(v.adjustments).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
  });

  it('shows a vendor that only has an adjustment', () => {
    const result = run({
      vendors: [vendor('v')],
      adjustments: [{ partyId: 'v', box: 'misc_1', amount: 2400, reason: 'Rent paid in cash' }],
    });
    expect(byParty(result, 'v').boxes).toEqual({ misc_1: 2400 });
  });
});

describe('corporations and attorneys', () => {
  it('keeps legal, medical and attorney proceeds payments to corporations', () => {
    const result = run({
      vendors: [
        vendor('clinic', { federalTaxClassification: 'c_corporation', defaultForm: 'misc', defaultBox: 'misc_6' }),
        vendor('law-misc', { federalTaxClassification: 'c_corporation', defaultForm: 'misc', defaultBox: 'misc_10' }),
        vendor('llc-s', { federalTaxClassification: 'llc', llcTaxClassification: 'S' }),
        vendor('llc-p', { federalTaxClassification: 'llc', llcTaxClassification: 'P' }),
      ],
      payments: [
        payment('p1', 'clinic', 2500),
        payment('p2', 'law-misc', 700),
        payment('p3', 'llc-s', 5000),
        payment('p4', 'llc-p', 5000),
      ],
    });
    expect(byParty(result, 'clinic')).toMatchObject({ status: 'included', boxes: { misc_6: 2500 } });
    expect(byParty(result, 'law-misc')).toMatchObject({ status: 'included', boxes: { misc_10: 700 } });
    expect(byParty(result, 'llc-s').status).toBe('excluded_corporation');
    expect(byParty(result, 'llc-p').status).toBe('included');
  });

  it('leaves out an incorporated vendor that is not an attorney even for legal-looking boxes', () => {
    const result = run({
      vendors: [vendor('corp', { federalTaxClassification: 'c_corporation' })],
      payments: [payment('p', 'corp', 50000)],
    });
    expect(byParty(result, 'corp').status).toBe('excluded_corporation');
    expect(byParty(result, 'corp').aboveThreshold).toBe(true);
  });

  it('classifies W-9 labels', () => {
    expect(isCorporationClassification('C Corporation')).toBe(true);
    expect(isCorporationClassification('s_corp')).toBe(true);
    expect(isCorporationClassification('LLC', 'C')).toBe(true);
    expect(isCorporationClassification('llc', 'P')).toBe(false);
    expect(isCorporationClassification('Individual/sole proprietor')).toBe(false);
    expect(isCorporationClassification('Partnership')).toBe(false);
    expect(isCorporationClassification(null)).toBe(false);
  });
});

describe('thresholds per box', () => {
  it('reports royalties from $10 and attorney gross proceeds from $600 in 2026', () => {
    const result = run({
      vendors: [
        vendor('royalty', { defaultForm: 'misc', defaultBox: 'misc_2' }),
        vendor('proceeds', { defaultForm: 'misc', defaultBox: 'misc_10' }),
        vendor('rent', { defaultForm: 'misc', defaultBox: 'misc_1' }),
      ],
      payments: [payment('p1', 'royalty', 10), payment('p2', 'proceeds', 600), payment('p3', 'rent', 600)],
    });
    expect(byParty(result, 'royalty').status).toBe('included');
    expect(byParty(result, 'proceeds').status).toBe('included');
    expect(byParty(result, 'rent').status).toBe('below_threshold');
  });

  it('measures each box on its own and reports only the boxes over their threshold', () => {
    const result = run({
      vendors: [vendor('v', { defaultForm: 'misc', defaultBox: 'misc_1' })],
      accountBoxes: { a1: 'misc_3' },
      bills: [{ id: 'b', lines: [{ id: 'l', amount: 1000, accountId: 'a1' }] }],
      payments: [
        payment('p1', 'v', 2500),
        payment('p2', 'v', 1000, { allocations: [{ billId: 'b', amount: 1000 }] }),
      ],
    });
    const v = byParty(result, 'v');
    expect(v.totals).toEqual({ misc_1: 2500, misc_3: 1000 });
    expect(v.boxes).toEqual({ misc_1: 2500 });
    expect(v.forms).toEqual(['misc']);
  });

  it('takes an indexed amount for later years as an override', () => {
    const base = { taxYear: 2027, vendors: [vendor('v')], payments: [payment('p', 'v', 2050, { date: '2027-04-01' })] };
    expect(byParty(run(base), 'v').status).toBe('included');
    expect(byParty(run({ ...base, thresholdOverrides: { general: 2100 } }), 'v').status).toBe('below_threshold');
    expect(run(base).thresholds.published).toBe(false);
  });
});

describe('backup withholding', () => {
  it('reports withheld tax in box 4 and waives the threshold of that form', () => {
    const result = run({
      vendors: [vendor('v', { backupWithholding: true })],
      payments: [payment('p', 'v', 1000, { backupWithholdingAmount: 240 })],
    });
    const v = byParty(result, 'v');
    expect(v.status).toBe('included');
    expect(v.boxes).toEqual({ nec_1: 1000, nec_4: 240 });
    expect(v.contributions.find((entry) => entry.box === 'nec_4')).toMatchObject({ amount: 240, paymentId: 'p', boxSource: 'withholding' });
  });

  it('sends the withholding of a MISC payment to MISC box 4', () => {
    const result = run({
      vendors: [vendor('v', { defaultForm: 'misc', defaultBox: 'misc_1' })],
      payments: [payment('p', 'v', 3000, { backupWithholdingAmount: 720 })],
    });
    expect(byParty(result, 'v').boxes).toEqual({ misc_1: 3000, misc_4: 720 });
  });

  it('splits the withholding over the forms a payment landed in', () => {
    const result = run({
      vendors: [vendor('v')],
      bills: [{ id: 'b', lines: [{ id: 'l1', amount: 500, accountId: 'a-nec' }, { id: 'l2', amount: 500, accountId: 'a-misc' }] }],
      accountBoxes: { 'a-nec': 'nec_1', 'a-misc': 'misc_1' },
      payments: [payment('p', 'v', 1000, { allocations: [{ billId: 'b', amount: 1000 }], backupWithholdingAmount: 240 })],
    });
    expect(byParty(result, 'v').boxes).toEqual({ nec_1: 500, nec_4: 120, misc_1: 500, misc_4: 120 });
  });

  it('flags a vendor under backup withholding whose payments had none withheld', () => {
    const result = run({
      vendors: [vendor('v', { backupWithholding: true })],
      payments: [payment('p', 'v', 5000)],
    });
    expect(byParty(result, 'v').reasons.join(' ')).toContain('backup withholding');
  });
});

describe('review statuses', () => {
  it('asks for a TIN before an address and reports both', () => {
    const result = run({
      vendors: [vendor('no-tin', { tinLast4: null, addressComplete: false }), vendor('no-address', { addressComplete: false })],
      payments: [payment('p1', 'no-tin', 5000), payment('p2', 'no-address', 5000)],
    });
    expect(byParty(result, 'no-tin')).toMatchObject({ status: 'needs_tin', boxes: { nec_1: 5000 } });
    expect(byParty(result, 'no-tin').reasons).toContain('The address is incomplete.');
    expect(byParty(result, 'no-address')).toMatchObject({ status: 'needs_address' });
  });

  it('still lists vendors not marked as 1099 vendors that crossed the threshold', () => {
    const result = run({ vendors: [vendor('v', { is1099Vendor: false })], payments: [payment('p', 'v', 9000)] });
    const v = byParty(result, 'v');
    expect(v.status).toBe('not_1099_vendor');
    expect(v.aboveThreshold).toBe(true);
    expect(v.boxes).toEqual({});
    expect(v.totals).toEqual({ nec_1: 9000 });
  });

  it('shows a vendor paid only by card with the 1099-K explanation', () => {
    const result = run({
      vendors: [vendor('v')],
      payments: [payment('p', 'v', 9000, { paymentMethod: 'credit_card' })],
    });
    const v = byParty(result, 'v');
    expect(v.status).toBe('below_threshold');
    expect(v.reasons.join(' ')).toContain('1099-K');
  });

  it('lists vendors with activity in the order of the vendor list', () => {
    const result = run({
      vendors: [vendor('b'), vendor('quiet'), vendor('a')],
      payments: [payment('p1', 'a', 5000), payment('p2', 'b', 5000)],
    });
    expect(result.vendors.map((entry) => entry.partyId)).toEqual(['b', 'a']);
  });

  it('gives the drill-down of the payments behind a vendor', () => {
    const result = run({
      vendors: [vendor('v')],
      payments: [payment('p1', 'v', 1000), payment('p2', 'v', 1500)],
    });
    expect(byParty(result, 'v').paymentIds).toEqual(['p1', 'p2']);
  });
});

describe('splitProRata', () => {
  it('adds up to the total and favours the largest remainder', () => {
    expect(splitProRata(10_000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(splitProRata(100, [3, 1])).toEqual([75, 25]);
    expect(splitProRata(1, [1, 1])).toEqual([1, 0]);
  });

  it('handles negative totals, negative weights and zero sums', () => {
    expect(splitProRata(-10_000, [1, 1, 1])).toEqual([-3333, -3333, -3334]);
    const parts = splitProRata(5000, [6000, -1000]);
    expect(parts).toEqual([6000, -1000]);
    expect(splitProRata(100, [5, -5])).toBeNull();
    expect(splitProRata(100, [])).toBeNull();
    expect(splitProRata(100, [-1, -3])).toEqual([25, 75]);
  });

  it('is exact for large amounts', () => {
    const parts = splitProRata(123_456_789_012, [333_333_333, 333_333_333, 333_333_334]);
    expect(parts?.reduce((sum, part) => sum + part, 0)).toBe(123_456_789_012);
  });
});
