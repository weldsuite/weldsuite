import { describe, expect, it } from 'vitest';
import type { Form1099FilingLine, Form1099VendorRow } from '@/lib/api/domains/weldbooks-1099';
import {
  boxEntries,
  boxTag,
  boxesDiffer,
  checkAdjustmentDrafts,
  copyTargets,
  daysUntil,
  defaultTaxYear,
  filingStepIndex,
  hasOutputs,
  isEditableFiling,
  isForm1099Tab,
  lineAmounts,
  matchesReviewFilter,
  needsAttention,
  parseAmountInput,
  parseBoxInputs,
  reportedAmount,
  reviewFilterCounts,
  sortLines,
  sumAmounts,
  taxYearChoices,
  unresolvedLines,
  vendorFixes,
  vendorsForForm,
} from './form-1099-model';

function vendor(overrides: Partial<Form1099VendorRow> = {}): Form1099VendorRow {
  return {
    partyId: 'p1',
    name: 'Acme',
    legalName: 'Acme LLC',
    status: 'included',
    reasons: [],
    forms: ['nec'],
    boxes: { nec_1: 2500 },
    totals: { nec_1: 2500 },
    aboveThreshold: true,
    isCorporation: false,
    isAttorney: false,
    tinType: 'ein',
    tinLast4: '6789',
    tinMasked: '**-***6789',
    hasTin: true,
    tinMatchStatus: null,
    tinMatchedAt: null,
    backupWithholding: false,
    suggestBackupWithholding: false,
    addressComplete: true,
    address: null,
    hasW9: true,
    eDeliveryConsent: false,
    excluded: { cardOrNetwork: 0, creditCardAccount: 0, payroll: 0, omittedBox: 0 },
    unmappedAmount: 0,
    adjustmentCount: 0,
    paymentCount: 1,
    bankTransactionCount: 0,
    ...overrides,
  };
}

function line(overrides: Partial<Form1099FilingLine> = {}): Form1099FilingLine {
  return {
    id: 'l1',
    filingId: 'f1',
    partyId: 'p1',
    partyName: 'Acme',
    recipient: { name: 'Acme LLC', tinType: 'ein', tinLast4: '6789' },
    hasTin: true,
    boxes: { nec_1: 2500 },
    adjustments: null,
    federalWithheld: '0.00',
    stateCode: null,
    stateIdNumber: null,
    stateIncome: null,
    stateWithheld: null,
    status: 'included',
    excludedReason: null,
    isCorrected: false,
    correctionOfLineId: null,
    deliveryMethod: null,
    deliveredAt: null,
    superseded: false,
    pendingCorrection: false,
    stateHint: null,
    ...overrides,
  };
}

describe('amounts', () => {
  it('adds in cents', () => {
    expect(sumAmounts([0.1, 0.2])).toBe(0.3);
    expect(reportedAmount({ nec_1: 100.1, nec_4: 24 })).toBe(100.1);
    expect(reportedAmount({ nec_1: 100.1, nec_4: 24 }, true)).toBe(24);
    expect(lineAmounts({ boxes: { misc_1: 1000, misc_2: 20.5, misc_4: 240 } })).toEqual({ amount: 1020.5, withheld: 240 });
  });

  it('names boxes the way people say them and orders them NEC before MISC, by number', () => {
    expect(boxTag('nec_1')).toBe('NEC 1');
    expect(boxTag('misc_10')).toBe('MISC 10');
    expect(boxTag('other')).toBe('other');
    expect(boxEntries({ misc_10: 5, nec_4: 1, misc_2: 3, nec_1: 9, misc_1: 0 }).map((e) => e.code)).toEqual(['nec_1', 'nec_4', 'misc_2', 'misc_10']);
  });

  it('parses typed amounts strictly', () => {
    expect(parseAmountInput('1,234.50')).toBe(1234.5);
    expect(parseAmountInput('$12')).toBe(12);
    expect(parseAmountInput('12.345')).toBeNull();
    expect(parseAmountInput('-5')).toBeNull();
    expect(parseAmountInput('-5', { allowNegative: true })).toBe(-5);
    expect(parseAmountInput('abc')).toBeNull();
    expect(parseAmountInput('')).toBeNull();
  });
});

describe('the yearly review', () => {
  it('counts every vendor under each filter', () => {
    const rows = [
      vendor({ partyId: 'a' }),
      vendor({ partyId: 'b', status: 'needs_tin', hasTin: false, tinMasked: null }),
      vendor({ partyId: 'c', status: 'needs_address', addressComplete: false }),
      vendor({ partyId: 'd', status: 'below_threshold', boxes: {}, totals: { nec_1: 100 } }),
      vendor({ partyId: 'e', status: 'excluded_corporation', boxes: {}, isCorporation: true }),
      vendor({ partyId: 'f', status: 'not_1099_vendor', boxes: {}, aboveThreshold: true }),
      vendor({ partyId: 'g', status: 'not_1099_vendor', boxes: {}, aboveThreshold: false }),
    ];
    expect(reviewFilterCounts(rows)).toEqual({
      all: 7,
      to_file: 3,
      attention: 3,
      below_threshold: 1,
      corporation: 1,
      not_vendor: 2,
    });
  });

  it('needs attention for a missing TIN or address, unmapped money, a failed match, or an unflagged vendor over the threshold', () => {
    expect(needsAttention(vendor())).toBe(false);
    expect(needsAttention(vendor({ status: 'needs_tin' }))).toBe(true);
    expect(needsAttention(vendor({ status: 'needs_address' }))).toBe(true);
    expect(needsAttention(vendor({ unmappedAmount: 10 }))).toBe(true);
    expect(needsAttention(vendor({ suggestBackupWithholding: true }))).toBe(true);
    expect(needsAttention(vendor({ status: 'not_1099_vendor', aboveThreshold: true }))).toBe(true);
    expect(needsAttention(vendor({ status: 'not_1099_vendor', aboveThreshold: false }))).toBe(false);
    expect(matchesReviewFilter(vendor({ status: 'needs_tin' }), 'to_file')).toBe(true);
    expect(matchesReviewFilter(vendor({ status: 'below_threshold' }), 'to_file')).toBe(false);
  });

  it('points each problem at its fix', () => {
    expect(vendorFixes(vendor())).toEqual([]);
    expect(vendorFixes(vendor({ status: 'needs_tin' }))).toEqual(['tin']);
    expect(vendorFixes(vendor({ status: 'needs_address' }))).toEqual(['address']);
    expect(vendorFixes(vendor({ status: 'not_1099_vendor', aboveThreshold: true }))).toEqual(['mark_vendor']);
    expect(vendorFixes(vendor({ status: 'needs_tin', unmappedAmount: 5, suggestBackupWithholding: true }))).toEqual(['tin', 'box', 'backup_withholding']);
  });

  it('lists the vendors that go on a form, whatever else is missing', () => {
    const rows = [
      vendor({ partyId: 'nec', forms: ['nec'] }),
      vendor({ partyId: 'misc', forms: ['misc'] }),
      vendor({ partyId: 'both', forms: ['nec', 'misc'], status: 'needs_tin' }),
      vendor({ partyId: 'below', status: 'below_threshold', forms: [] }),
    ];
    expect(vendorsForForm({ vendors: rows }, 'nec').map((r) => r.partyId)).toEqual(['nec', 'both']);
    expect(vendorsForForm({ vendors: rows }, 'misc').map((r) => r.partyId)).toEqual(['misc', 'both']);
  });
});

describe('filings and their lines', () => {
  it('places a filing in its life', () => {
    expect(filingStepIndex('draft')).toBe(0);
    expect(filingStepIndex('reviewed')).toBe(1);
    expect(filingStepIndex('generated')).toBe(2);
    expect(filingStepIndex('filed')).toBe(3);
    expect(filingStepIndex('corrected')).toBe(3);
    expect(isEditableFiling('draft')).toBe(true);
    expect(isEditableFiling('reviewed')).toBe(true);
    expect(isEditableFiling('generated')).toBe(false);
    expect(hasOutputs('draft')).toBe(false);
    expect(hasOutputs('generated')).toBe(true);
    expect(hasOutputs('corrected')).toBe(true);
  });

  it('finds the lines that block generating', () => {
    const lines = [line({ id: 'a' }), line({ id: 'b', status: 'needs_tin' }), line({ id: 'c', status: 'needs_address' })];
    expect(unresolvedLines(lines).map((l) => l.id)).toEqual(['b', 'c']);
  });

  it('puts current lines first and replaced ones last', () => {
    const sorted = sortLines([line({ id: 'old', superseded: true }), line({ id: 'off', status: 'excluded' }), line({ id: 'on' })]);
    expect(sorted.map((l) => l.id)).toEqual(['on', 'off', 'old']);
  });

  it('prints copies for the lines on the form; a corrected filing prints only its pending corrections', () => {
    const lines = [
      line({ id: 'filed', status: 'filed', superseded: true }),
      line({ id: 'other', status: 'filed' }),
      line({ id: 'fix', status: 'included', isCorrected: true, pendingCorrection: true }),
      line({ id: 'off', status: 'excluded' }),
    ];
    expect(copyTargets({ status: 'filed' }, lines).map((l) => l.id)).toEqual(['other', 'fix']);
    expect(copyTargets({ status: 'corrected' }, lines).map((l) => l.id)).toEqual(['fix']);
    expect(copyTargets({ status: 'generated' }, [line({ id: 'a' }), line({ id: 'b', status: 'excluded' })]).map((l) => l.id)).toEqual(['a']);
  });
});

describe('typing adjustments and corrections', () => {
  it('turns drafts into the request body, listing what is wrong with each row', () => {
    const ok = checkAdjustmentDrafts([{ box: 'nec_1', amount: '-125.50', reason: ' Refund ' }]);
    expect(ok.problems).toEqual([]);
    expect(ok.adjustments).toEqual([{ box: 'nec_1', amount: -125.5, reason: 'Refund' }]);

    const bad = checkAdjustmentDrafts([
      { box: '', amount: '5', reason: 'x' },
      { box: 'nec_1', amount: 'abc', reason: 'x' },
      { box: 'nec_1', amount: '0', reason: 'x' },
      { box: 'nec_1', amount: '5', reason: '  ' },
    ]);
    expect(bad.adjustments).toEqual([]);
    expect(bad.problems).toEqual([
      { index: 0, problem: 'box' },
      { index: 1, problem: 'amount' },
      { index: 2, problem: 'zero' },
      { index: 3, problem: 'reason' },
    ]);
  });

  it('reads the boxes of a correction: empty is zero, a bad entry is reported by its box', () => {
    expect(parseBoxInputs({ nec_1: '1,000.00', nec_4: '', misc_1: '0' })).toEqual({ boxes: { nec_1: 1000 }, invalid: [] });
    expect(parseBoxInputs({ nec_1: 'lots', nec_3: '5' })).toEqual({ boxes: { nec_3: 5 }, invalid: ['nec_1'] });
  });

  it('tells whether two box sets differ, in cents', () => {
    expect(boxesDiffer({ nec_1: 100 }, { nec_1: 100 })).toBe(false);
    expect(boxesDiffer({ nec_1: 100 }, { nec_1: 100.01 })).toBe(true);
    expect(boxesDiffer({ nec_1: 100 }, { nec_1: 100, nec_3: 0 })).toBe(false);
    expect(boxesDiffer({}, { nec_1: 5 })).toBe(true);
  });
});

describe('years and dates', () => {
  it('opens on last year until March, then this year', () => {
    expect(defaultTaxYear(new Date(2027, 0, 15))).toBe(2026);
    expect(defaultTaxYear(new Date(2027, 2, 31))).toBe(2026);
    expect(defaultTaxYear(new Date(2027, 3, 1))).toBe(2027);
    expect(defaultTaxYear(new Date(2026, 9, 8))).toBe(2026);
  });

  it('offers six years, newest first', () => {
    expect(taxYearChoices(new Date(2026, 9, 8))).toEqual([2026, 2025, 2024, 2023, 2022, 2021]);
  });

  it('counts days to a deadline, negative once past', () => {
    expect(daysUntil('2027-02-01', new Date(2027, 0, 25))).toBe(7);
    expect(daysUntil('2027-02-01', new Date(2027, 1, 1))).toBe(0);
    expect(daysUntil('2027-02-01', new Date(2027, 1, 3))).toBe(-2);
    expect(daysUntil('nonsense', new Date())).toBeNaN();
  });

  it('knows the tabs of the Center', () => {
    expect(isForm1099Tab('filings')).toBe(true);
    expect(isForm1099Tab('tin-matching')).toBe(true);
    expect(isForm1099Tab('nope')).toBe(false);
    expect(isForm1099Tab(undefined)).toBe(false);
  });
});
