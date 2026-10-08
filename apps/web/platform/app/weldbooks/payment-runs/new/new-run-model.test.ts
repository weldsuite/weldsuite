import { describe, expect, it } from 'vitest';
import {
  amountProblem,
  blockOf,
  buildCreateInput,
  buildItems,
  defaultApprovals,
  dropBlockedPicks,
  emptyPicks,
  isPaymentBankAccount,
  parseAmount,
  reconcilePicks,
  reviewVendors,
  setAmount,
  setPicked,
  setVendorPicked,
  vendorBlock,
  vendorWarnings,
  withholdingPreview,
} from './new-run-model';
import { makeAch, makeBill, makeVendor, makeVendors } from './new-run-fixtures';

const withholding = (amount: string, net: string, reason: 'no_tin' | 'flagged' = 'no_tin') =>
  ({ applies: true, reason, rate: 0.24, amount, net }) as const;

const vendors = makeVendors();
const [acme, bright, cobalt, delta] = vendors as [(typeof vendors)[number], (typeof vendors)[number], (typeof vendors)[number], (typeof vendors)[number]];

describe('parseAmount', () => {
  it('reads positive amounts with at most two decimals', () => {
    expect(parseAmount('12.5')).toBe(12.5);
    expect(parseAmount(' 1,234.56 ')).toBe(1234.56);
    expect(parseAmount('7')).toBe(7);
  });

  it('rejects anything else', () => {
    for (const bad of ['', '0', '0.00', '-5', '1.234', 'abc', '1e3', '.5', '5.']) expect(parseAmount(bad), bad).toBeNull();
  });
});

describe('blocks', () => {
  it('blocks ACH vendors whose bank details are missing, invalid or changed and unverified', () => {
    expect(vendorBlock(acme, 'ach')).toBeNull();
    expect(vendorBlock(bright, 'ach')).toBe('bank_details_changed');
    expect(vendorBlock(cobalt, 'ach')).toBe('no_bank_details');
    expect(vendorBlock({ ach: makeAch({ routingValid: false, ready: false }) }, 'ach')).toBe('invalid_bank_details');
    expect(vendorBlock({ ach: null }, 'ach')).toBe('no_bank_details');
  });

  it('does not look at bank details for a check run', () => {
    expect(vendorBlock(bright, 'check')).toBeNull();
    expect(vendorBlock(cobalt, 'check')).toBeNull();
  });

  it('blocks a bill that is already in another open run, whatever the method', () => {
    const inRun = delta.bills[0]!;
    expect(blockOf(delta, inRun, 'check')).toBe('in_open_run');
    expect(blockOf(delta, delta.bills[1]!, 'check')).toBeNull();
  });
});

describe('vendorWarnings', () => {
  it('does not warn about backup withholding: the run takes it out of the payment, it holds nobody', () => {
    const vendor = makeVendor('p', 'V', [makeBill('x', '10.00')], { backupWithholding: withholding('2.40', '7.60') });
    expect(vendorWarnings(vendor, 'check', { requirePrenotes: false })).toEqual([]);
    expect(vendorWarnings(vendor, 'ach', { requirePrenotes: true })).toEqual([]);
    expect(vendorBlock(vendor, 'ach')).toBeNull();
  });

  it('warns about prenotes only when they are required and the vendor is not blocked', () => {
    const needed = makeVendor('p', 'V', [], { ach: makeAch({ prenote: 'needed' }) });
    const pending = makeVendor('p', 'V', [], { ach: makeAch({ prenote: 'pending' }) });
    expect(vendorWarnings(needed, 'ach', { requirePrenotes: true })).toEqual(['prenote_needed']);
    expect(vendorWarnings(pending, 'ach', { requirePrenotes: true })).toEqual(['prenote_pending']);
    expect(vendorWarnings(needed, 'ach', { requirePrenotes: false })).toEqual([]);
    expect(vendorWarnings(needed, 'check', { requirePrenotes: true })).toEqual([]);
    expect(vendorWarnings(makeVendor('p', 'V', [], { ach: makeAch({ prenote: 'needed', held: true }) }), 'ach', { requirePrenotes: true })).toEqual([]);
  });
});

describe('withholdingPreview', () => {
  const vendor = makeVendor('p', 'V', [makeBill('x', '5000.00')], { backupWithholding: withholding('1200.00', '3800.00') });

  it('takes 24% of what is picked, not of what the vendor is owed', () => {
    expect(withholdingPreview(vendor, 500_000)).toMatchObject({ withheld: 1200, net: 3800, reason: 'no_tin', rate: 0.24 });
    expect(withholdingPreview(vendor, 100_000)).toMatchObject({ withheld: 240, net: 760 });
  });

  it('rounds to whole cents the way the server does, half a cent up', () => {
    // 24% of $0.02 is 0.48 cents: rounds to 0; 24% of $0.05 is 1.2 cents: 1; of $1.03 is 24.72 cents: 25.
    expect(withholdingPreview(vendor, 2)).toBeNull();
    expect(withholdingPreview(vendor, 5)).toMatchObject({ withheld: 0.01, net: 0.04 });
    expect(withholdingPreview(vendor, 103)).toMatchObject({ withheld: 0.25, net: 0.78 });
  });

  it('has nothing for a vendor it does not apply to, or when nothing is picked', () => {
    expect(withholdingPreview(acme, 10_000)).toBeNull();
    expect(withholdingPreview(vendor, 0)).toBeNull();
  });
});

describe('picks', () => {
  it('starts with nothing picked and every bill at its open balance', () => {
    const picks = emptyPicks(vendors);
    expect(Object.keys(picks)).toHaveLength(6);
    expect(picks.b2).toEqual({ selected: false, amount: '250.50' });
  });

  it('picks every pickable bill of a vendor and leaves the blocked ones', () => {
    const picks = setVendorPicked(emptyPicks(vendors), delta, 'check', true);
    expect(picks.b5?.selected).toBe(false);
    expect(picks.b6?.selected).toBe(true);
    expect(setVendorPicked(picks, delta, 'check', false).b6?.selected).toBe(false);
  });

  it('never picks the bills of a blocked ACH vendor', () => {
    const picks = setVendorPicked(emptyPicks(vendors), bright, 'ach', true);
    expect(picks.b3?.selected).toBe(false);
  });

  it('drops picks that a switch to ACH blocks', () => {
    let picks = setPicked(emptyPicks(vendors), 'b3', true);
    picks = setPicked(picks, 'b1', true);
    const next = dropBlockedPicks(picks, vendors, 'ach');
    expect(next.b3?.selected).toBe(false);
    expect(next.b1?.selected).toBe(true);
  });

  it('keeps picks when the list reloads and adds new bills unpicked', () => {
    const picks = setAmount(setPicked(emptyPicks(vendors), 'b1', true), 'b1', '40.00');
    const reloaded = [...vendors, makeVendor('par_new', 'New Vendor', [makeBill('b9', '9.00')])];
    const next = reconcilePicks(reloaded, picks);
    expect(next.b1).toEqual({ selected: true, amount: '40.00' });
    expect(next.b9).toEqual({ selected: false, amount: '9.00' });
    expect(reconcilePicks([acme], picks).b3).toBeUndefined();
  });
});

describe('amountProblem', () => {
  const bill = makeBill('x', '100.00');

  it('accepts anything up to the open balance', () => {
    expect(amountProblem(bill, '100.00')).toBeNull();
    expect(amountProblem(bill, '0.01')).toBeNull();
  });

  it('flags unusable amounts and amounts over the balance', () => {
    expect(amountProblem(bill, 'abc')).toBe('invalid');
    expect(amountProblem(bill, '0')).toBe('invalid');
    expect(amountProblem(bill, '100.01')).toBe('exceeds_balance');
  });
});

describe('buildItems', () => {
  it('builds one item per picked bill with the parsed amount, in the order shown', () => {
    let picks = emptyPicks(vendors);
    picks = setPicked(picks, 'b2', true);
    picks = setPicked(picks, 'b1', true);
    picks = setAmount(picks, 'b1', '60');
    const built = buildItems(vendors, picks, 'check');
    expect(built.items).toEqual([
      { billId: 'b1', amount: 60 },
      { billId: 'b2', amount: 250.5 },
    ]);
    expect(built.total).toBe(310.5);
    expect(built.vendorCount).toBe(1);
    expect(built.problems).toEqual([]);
  });

  it('leaves out bills of held vendors on an ACH run, even when they are picked', () => {
    let picks = emptyPicks(vendors);
    for (const id of ['b1', 'b3', 'b4', 'b6']) picks = setPicked(picks, id, true);
    const ach = buildItems(vendors, picks, 'ach');
    expect(ach.items.map((i) => i.billId)).toEqual(['b1', 'b6']);
    expect(ach.vendorCount).toBe(2);

    // The same picks on a check run: only the bill in another run is out.
    const check = buildItems(vendors, picks, 'check');
    expect(check.items.map((i) => i.billId)).toEqual(['b1', 'b3', 'b4', 'b6']);
  });

  it('never includes a bill that is in another open run', () => {
    const picks = setPicked(emptyPicks(vendors), 'b5', true);
    expect(buildItems(vendors, picks, 'check').items).toEqual([]);
  });

  it('reports picked bills whose amount is wrong instead of sending them', () => {
    let picks = setPicked(emptyPicks(vendors), 'b1', true);
    picks = setAmount(picks, 'b1', '500');
    picks = setPicked(picks, 'b2', true);
    picks = setAmount(picks, 'b2', 'x');
    const built = buildItems(vendors, picks, 'check');
    expect(built.items).toEqual([]);
    expect(built.problems).toEqual([
      { billId: 'b1', problem: 'exceeds_balance' },
      { billId: 'b2', problem: 'invalid' },
    ]);
  });

  it('adds up the backup withholding of the vendors it applies to, and what leaves the bank', () => {
    const echo = makeVendor('par_echo', 'Echo Freelance', [makeBill('e1', '5000.00'), makeBill('e2', '100.00')], {
      backupWithholding: withholding('1224.00', '3876.00'),
    });
    const all = [acme, echo];
    let picks = emptyPicks(all);
    picks = setPicked(setPicked(setPicked(picks, 'b1', true), 'e1', true), 'e2', true);
    picks = setAmount(picks, 'e1', '4000.00');
    const built = buildItems(all, picks, 'check');
    expect(built.total).toBe(4200);
    // 24% of the 4,100 picked of Echo, not of the 5,100 it is owed.
    expect(built.withheld).toBe(984);
    expect(built.net).toBe(3216);
    expect(built.byVendor.par_echo).toMatchObject({ grossCents: 410_000, withholding: { withheld: 984, net: 3116 } });
    expect(built.byVendor.par_acme).toMatchObject({ grossCents: 10_000, withholding: null });
  });

  it('has no withholding when nothing it applies to is picked', () => {
    const built = buildItems(vendors, setPicked(emptyPicks(vendors), 'b1', true), 'check');
    expect(built.withheld).toBe(0);
    expect(built.net).toBe(built.total);
  });

  it('adds up in cents so amounts do not drift', () => {
    const odd = makeVendor('p', 'V', [makeBill('x', '0.10'), makeBill('y', '0.20')]);
    const picks = setPicked(setPicked(emptyPicks([odd]), 'x', true), 'y', true);
    expect(buildItems([odd], picks, 'check').total).toBe(0.3);
  });
});

describe('buildCreateInput', () => {
  const items = [{ billId: 'b1', amount: 100 }];
  const options = {
    bankAccountId: 'bnk_1',
    paymentDate: '2026-10-09',
    secCode: 'auto' as const,
    sameDay: false,
    requiredApprovals: 1 as const,
    notes: '  October vendors  ',
  };

  it('makes a check run without any ACH options', () => {
    expect(buildCreateInput({ ...options, method: 'check' }, items)).toEqual({
      bankAccountId: 'bnk_1',
      method: 'check',
      paymentDate: '2026-10-09',
      items,
      requiredApprovals: 1,
      notes: 'October vendors',
    });
  });

  it('makes an ACH run that leaves the SEC code to the server when it is automatic', () => {
    expect(buildCreateInput({ ...options, method: 'ach', requiredApprovals: 2, sameDay: true, notes: '' }, items)).toEqual({
      bankAccountId: 'bnk_1',
      method: 'ach',
      paymentDate: '2026-10-09',
      items,
      requiredApprovals: 2,
      secCode: null,
      sameDay: true,
    });
  });

  it('sends the SEC code that was chosen', () => {
    expect(buildCreateInput({ ...options, method: 'ach', secCode: 'CCD+' }, items)).toMatchObject({ secCode: 'CCD+', sameDay: false });
  });
});

describe('defaults and review', () => {
  it('asks two approvals for ACH and one for checks', () => {
    expect(defaultApprovals('ach')).toBe(2);
    expect(defaultApprovals('check')).toBe(1);
  });

  it('only offers accounts that are not cards or credit lines', () => {
    expect(isPaymentBankAccount({ isActive: true, accountType: 'checking' })).toBe(true);
    expect(isPaymentBankAccount({ isActive: false, accountType: 'checking' })).toBe(false);
    expect(isPaymentBankAccount({ isActive: true, accountType: 'credit_card' })).toBe(false);
    expect(isPaymentBankAccount({ isActive: null, accountType: undefined })).toBe(true);
  });

  it('reviews the vendors with something picked: gross, what is withheld and what the vendor is paid', () => {
    const held = makeVendor('par_w', 'Withheld Inc', [makeBill('w1', '50.00')], { backupWithholding: withholding('12.00', '38.00', 'flagged') });
    const all = [acme, held];
    let picks = emptyPicks(all);
    picks = setPicked(setPicked(setPicked(picks, 'b1', true), 'b2', true), 'w1', true);
    expect(reviewVendors(all, picks, 'check', { requirePrenotes: false })).toEqual([
      { partyId: 'par_acme', name: 'Acme Supplies', billCount: 2, amount: 350.5, withholding: null, net: 350.5, warnings: [] },
      {
        partyId: 'par_w',
        name: 'Withheld Inc',
        billCount: 1,
        amount: 50,
        withholding: { withheld: 12, net: 38, reason: 'flagged', rate: 0.24 },
        net: 38,
        warnings: [],
      },
    ]);
  });
});
