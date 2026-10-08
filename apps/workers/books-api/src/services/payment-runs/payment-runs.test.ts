import { describe, expect, it } from 'vitest';
import { hasIndependentApprover } from './approval';
import { checkStatusOf, compareCheckNumbers } from './checks';
import {
  addBankingDays,
  decodeHold,
  encodeHold,
  heldPartyIds,
  prenoteState,
  releaseBlocker,
  vendorAchStatus,
  type RunHold,
} from './holds';
import { fileIdModifierFor, localDateTime } from './nacha';
import { runPaymentId } from './payments';
import { totalsOf } from './runs';
import {
  achPatchToStored,
  achReadiness,
  achSettingsSchema,
  checkReadiness,
  checkSettingsSchema,
  effectiveOriginator,
  mergeSection,
  readAchSettings,
  readCheckSettings,
  updateSettingsSchema,
} from './settings';

const DAY = 86_400_000;
const NOW = new Date('2026-10-08T15:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const hold = (overrides: Partial<RunHold> = {}): RunHold => ({
  partyId: 'pty_1',
  code: 'in_other_run',
  message: 'Another run',
  key: 'bil_1',
  released: null,
  ...overrides,
});

describe('holds', () => {
  it('survive a round trip through the stored shape, released or not', () => {
    const plain = hold();
    expect(decodeHold(encodeHold(plain))).toEqual(plain);
    const released = hold({ released: { by: 'user_1', at: '2026-10-08T10:00:00.000Z', reason: 'First run was a mistake' } });
    expect(decodeHold(encodeHold(released))).toEqual(released);
    expect(encodeHold(plain).partyId).toBe('pty_1');
  });

  it('read a plain-text reason from an older writer', () => {
    expect(decodeHold({ partyId: 'pty_2', reason: 'Bank details changed' })).toMatchObject({ partyId: 'pty_2', message: 'Bank details changed', released: null });
  });

  it('only keep a vendor out while unreleased', () => {
    const holds = [hold({ partyId: 'a' }), hold({ partyId: 'b', released: { by: 'u', at: 'x', reason: 'ok' } })];
    expect([...heldPartyIds(holds)]).toEqual(['a']);
  });

  it('say which holds the run can release', () => {
    expect(releaseBlocker(hold({ code: 'in_other_run' }))).toBeNull();
    expect(releaseBlocker(hold({ code: 'prenote_required' }))).toBeNull();
    expect(releaseBlocker(hold({ code: 'bank_details_changed' }))).toMatch(/verify/i);
    expect(releaseBlocker(hold({ code: 'no_bank_details' }))).toMatch(/fix/i);
    expect(releaseBlocker(hold({ code: 'invalid_bank_details' }))).toMatch(/fix/i);
    // Paying a vendor in full would skip the withholding: only a chart with a Backup Withholding Payable account clears it.
    expect(releaseBlocker(hold({ code: 'backup_withholding' }))).toMatch(/Backup Withholding Payable/);
  });

  it('total only what is paid: held vendors are left out', () => {
    const items = [
      { billId: 'b1', amount: 100.1, partyId: 'a' },
      { billId: 'b2', amount: 200.2, partyId: 'a' },
      { billId: 'b3', amount: 50, partyId: 'b' },
    ];
    expect(totalsOf(items, [])).toEqual({ totalAmount: '350.30', heldAmount: '0.00', paymentCount: 2 });
    expect(totalsOf(items, [hold({ partyId: 'b' })])).toEqual({ totalAmount: '300.30', heldAmount: '50.00', paymentCount: 1 });
    expect(totalsOf(items, [hold({ partyId: 'b', released: { by: 'u', at: 'x', reason: 'ok' } })])).toMatchObject({ totalAmount: '350.30', paymentCount: 2 });
  });
});

describe('a vendor\'s ACH status', () => {
  const base = {
    achRoutingNumber: '021000021',
    achAccountLast4: '6789',
    achAccountType: 'checking',
    bankDetailsChangedAt: null as Date | null,
    bankDetailsVerifiedAt: null as Date | null,
  };

  it('is ready with valid details and no recent change', () => {
    expect(vendorAchStatus(base, 10, NOW)).toMatchObject({ ready: true, verified: true, holdActive: false, last4: '6789' });
  });

  it('holds a change inside the window until it is verified afterwards', () => {
    expect(vendorAchStatus({ ...base, bankDetailsChangedAt: ago(1) }, 10, NOW)).toMatchObject({ verified: false, holdActive: true });
    expect(vendorAchStatus({ ...base, bankDetailsChangedAt: ago(9.5) }, 10, NOW).holdActive).toBe(true);
    // Past the window the hold lapses.
    expect(vendorAchStatus({ ...base, bankDetailsChangedAt: ago(11) }, 10, NOW)).toMatchObject({ verified: false, holdActive: false });
    // A longer window keeps it.
    expect(vendorAchStatus({ ...base, bankDetailsChangedAt: ago(11) }, 30, NOW).holdActive).toBe(true);
    // Verified after the change.
    expect(vendorAchStatus({ ...base, bankDetailsChangedAt: ago(2), bankDetailsVerifiedAt: ago(1) }, 10, NOW)).toMatchObject({ verified: true, holdActive: false });
    // Verified before a newer change does not count.
    expect(vendorAchStatus({ ...base, bankDetailsChangedAt: ago(1), bankDetailsVerifiedAt: ago(3) }, 10, NOW).holdActive).toBe(true);
  });

  it('is not ready without every detail or with a bad routing number', () => {
    expect(vendorAchStatus({ ...base, achRoutingNumber: null }, 10, NOW)).toMatchObject({ ready: false, hasRouting: false });
    expect(vendorAchStatus({ ...base, achAccountLast4: null }, 10, NOW)).toMatchObject({ ready: false, hasAccount: false });
    expect(vendorAchStatus({ ...base, achAccountType: null }, 10, NOW)).toMatchObject({ ready: false, hasAccountType: false });
    expect(vendorAchStatus({ ...base, achRoutingNumber: '021000022' }, 10, NOW)).toMatchObject({ ready: false, routingValid: false });
  });
});

describe('prenotes', () => {
  const party = { bankDetailsChangedAt: ago(30) };

  it('count banking days, not calendar days', () => {
    // Thursday 8 October 2026; Monday 12 October is Columbus Day.
    expect(addBankingDays('2026-10-08', 3)).toBe('2026-10-14');
    expect(addBankingDays('2026-10-09', 1)).toBe('2026-10-13');
    expect(addBankingDays('2026-10-08', 0)).toBe('2026-10-08');
  });

  it('are needed until the account has been paid or prenoted', () => {
    expect(prenoteState(party, { livePayments: [], prenotes: [] }, NOW)).toBe('needed');
  });

  it('are proven by an ACH payment sent since the details last changed', () => {
    expect(prenoteState(party, { livePayments: [ago(5)], prenotes: [] }, NOW)).toBe('proven');
    // A payment to the old account says nothing about the new one.
    expect(prenoteState(party, { livePayments: [ago(40)], prenotes: [] }, NOW)).toBe('needed');
    expect(prenoteState({ bankDetailsChangedAt: null }, { livePayments: [ago(400)], prenotes: [] }, NOW)).toBe('proven');
  });

  it('wait three banking days after the prenote', () => {
    expect(prenoteState(party, { livePayments: [], prenotes: [ago(0)] }, NOW)).toBe('pending');
    expect(prenoteState(party, { livePayments: [], prenotes: [ago(2)] }, NOW)).toBe('pending');
    expect(prenoteState(party, { livePayments: [], prenotes: [ago(7)] }, NOW)).toBe('proven');
    expect(prenoteState(party, { livePayments: [], prenotes: [ago(40)] }, NOW)).toBe('needed');
  });
});

describe('approvals', () => {
  it('need someone other than the creator among two approvers', () => {
    const run = { createdBy: 'maker', requiredApprovals: 2 };
    expect(hasIndependentApprover(run, ['maker'])).toBe(false);
    expect(hasIndependentApprover(run, ['maker', 'other'])).toBe(true);
    expect(hasIndependentApprover(run, ['one', 'two'])).toBe(true);
    // A single approval may be the creator's.
    expect(hasIndependentApprover({ createdBy: 'maker', requiredApprovals: 1 }, ['maker'])).toBe(true);
  });
});

describe('the id of a run payment', () => {
  it('is the same for the same run and vendor, and fits a payment id', async () => {
    const id = await runPaymentId('prn_mf3k2x9a1b2c3d4e', 'pty_mf3k2x9a1b2c3d4e');
    expect(id).toBe(await runPaymentId('prn_mf3k2x9a1b2c3d4e', 'pty_mf3k2x9a1b2c3d4e'));
    expect(id).toMatch(/^pay_[0-9a-f]{24}$/);
    expect(id.length).toBeLessThanOrEqual(30);
  });

  it('differs per run, per vendor and per attempt after a void', async () => {
    const base = await runPaymentId('prn_1', 'pty_1');
    const ids = new Set([base, await runPaymentId('prn_2', 'pty_1'), await runPaymentId('prn_1', 'pty_2'), await runPaymentId('prn_1', 'pty_1', 1), await runPaymentId('prn_1', 'pty_1', 2)]);
    expect(ids.size).toBe(5);
    expect(await runPaymentId('prn_1', 'pty_1', 0)).toBe(base);
  });
});

describe('checks', () => {
  it('order numbers as numbers', () => {
    expect(['1010', '999', '1001', '1002'].sort(compareCheckNumbers)).toEqual(['999', '1001', '1002', '1010']);
    expect(compareCheckNumbers(null, '1')).toBeLessThan(0);
  });

  it('call a deleted check voided', () => {
    expect(checkStatusOf({ deletedAt: new Date(), checkStatus: 'printed' })).toBe('voided');
    expect(checkStatusOf({ deletedAt: null, checkStatus: 'voided' })).toBe('voided');
    expect(checkStatusOf({ deletedAt: null, checkStatus: 'to_print' })).toBe('to_print');
    expect(checkStatusOf({ deletedAt: null, checkStatus: 'cleared' })).toBe('cleared');
    expect(checkStatusOf({ deletedAt: null, checkStatus: null })).toBe('printed');
  });
});

describe('NACHA file details', () => {
  it('take the date and time of the originator\'s time zone', () => {
    // 03:30 UTC is still the evening before in Chicago.
    expect(localDateTime(new Date('2026-10-08T03:30:00Z'), 'America/Chicago')).toEqual({ date: '2026-10-07', time: '2230' });
    expect(localDateTime(new Date('2026-12-01T17:05:00Z'), 'America/New_York')).toEqual({ date: '2026-12-01', time: '1205' });
    // An unknown zone falls back to Eastern time.
    expect(localDateTime(new Date('2026-12-01T17:05:00Z'), 'Mars/Olympus')).toEqual({ date: '2026-12-01', time: '1205' });
    expect(localDateTime(new Date('2026-12-01T05:00:00Z'), null)).toEqual({ date: '2026-12-01', time: '0000' });
  });

  it('give each file of a day its own modifier', () => {
    expect([0, 1, 25, 26, 35].map(fileIdModifierFor)).toEqual(['A', 'B', 'Z', '0', '9']);
  });
});

describe('settings', () => {
  it('fill the defaults in for an empty bank account', () => {
    expect(readCheckSettings(null)).toMatchObject({ layout: 'voucher_top', printMicr: false, micrLayout: 'business', checkNumberWidth: 6, bankAddressLines: [] });
    expect(readAchSettings(null)).toMatchObject({ balanced: false, sameDayAllowed: false, defaultSecCode: 'CCD', holdWindowDays: 10, requirePrenotes: false });
  });

  it('ignore stored values that are not valid any more', () => {
    expect(readCheckSettings({ layout: 'bogus', alignment: { dx: 'a', dy: 3 }, fractionalNumerator: 'x', checkNumberWidth: 99 })).toMatchObject({
      layout: 'voucher_top',
      alignment: { dy: 3 },
      fractionalNumerator: null,
      checkNumberWidth: 6,
    });
    expect(readAchSettings({ defaultSecCode: 'WEB', holdWindowDays: 0 })).toMatchObject({ defaultSecCode: 'CCD', holdWindowDays: 10 });
  });

  it('merge a section key by key and clear a key with null', () => {
    expect(mergeSection({ a: 1, b: 2 }, { b: 3, c: 4, a: null })).toEqual({ b: 3, c: 4 });
    expect(mergeSection(null, { a: 1 })).toEqual({ a: 1 });
    expect(mergeSection({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });

  it('turn an EIN into the company identification', () => {
    expect(achPatchToStored({ ein: '12-3456789'.replace('-', ''), balanced: true })).toEqual({ balanced: true, companyIdentification: '1123456789' });
    expect(() => achPatchToStored({ ein: '123' })).toThrow(/9 digits/);
  });

  it('validate what is sent', () => {
    expect(checkSettingsSchema.safeParse({ fractionalNumerator: '90-7162', layout: 'three_per_page' }).success).toBe(true);
    expect(checkSettingsSchema.safeParse({ fractionalNumerator: '907162' }).success).toBe(false);
    expect(checkSettingsSchema.safeParse({ alignment: { dx: 500 } }).success).toBe(false);
    expect(checkSettingsSchema.safeParse({ bankAddressLines: ['a', 'b', 'c', 'd'] }).success).toBe(false);
    expect(achSettingsSchema.safeParse({ immediateDestination: '021000021', defaultSecCode: 'CCD+' }).success).toBe(true);
    expect(achSettingsSchema.safeParse({ immediateDestination: '021000022' }).success).toBe(false);
    expect(achSettingsSchema.safeParse({ defaultSecCode: 'WEB' }).success).toBe(false);
    expect(achSettingsSchema.safeParse({ entryDescription: 'purchase' }).success).toBe(false);
    expect(achSettingsSchema.safeParse({ holdWindowDays: 0 }).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ nextCheckNumber: 0 }).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ nextCheckNumber: null, positivePayFormat: 'chase' }).success).toBe(true);
    expect(updateSettingsSchema.safeParse({ positivePayFormat: 'nope' }).success).toBe(false);
    expect(updateSettingsSchema.safeParse({ positivePayConfig: { kind: 'fixed', columns: [{ field: 'amount', width: 12 }] } }).success).toBe(true);
    expect(updateSettingsSchema.safeParse({ positivePayConfig: { columns: [] } }).success).toBe(false);
  });

  it('take what a NACHA file says from the bank account and the entity when the settings are silent', () => {
    const bank = { routingNumber: '021000021', bankName: 'JPMorgan Chase', name: 'Operating' };
    const entity = { name: 'Runs Studio', legalName: 'Runs Studio, LLC', dba: null, taxIdentifiers: { einOrSsn: '12-3456789' } };
    const effective = effectiveOriginator(bank, entity, readAchSettings(null));
    expect(effective).toEqual({
      immediateDestination: '021000021',
      immediateDestinationName: 'JPMorgan Chase',
      immediateOrigin: '1123456789',
      immediateOriginName: 'Runs Studio, LLC',
      companyName: 'Runs Studio, LLC',
      companyIdentification: '1123456789',
      odfiRoutingNumber: '021000021',
    });
    expect(achReadiness(effective, readAchSettings(null), false)).toEqual({ ready: true, missing: [] });

    const own = effectiveOriginator(bank, entity, readAchSettings({ companyName: 'Studio', companyIdentification: '9999999999', immediateDestination: '121000248' }));
    expect(own).toMatchObject({ companyName: 'Studio', companyIdentification: '9999999999', immediateOrigin: '9999999999', immediateDestination: '121000248', odfiRoutingNumber: '121000248' });

    // No EIN, no routing number: the file can't be made.
    const bare = effectiveOriginator({ routingNumber: null, bankName: null, name: 'Cash' }, { name: 'X', legalName: null, dba: null, taxIdentifiers: null }, readAchSettings(null));
    expect(achReadiness(bare, readAchSettings(null), false)).toEqual({ ready: false, missing: ['immediateDestination', 'companyIdentification', 'immediateOrigin'] });
    // A balanced file needs the account to debit.
    expect(achReadiness(effective, readAchSettings({ balanced: true }), false).missing).toEqual(['offsetBankAccount']);
  });

  it('say what checks need', () => {
    const bank = { nextCheckNumber: null, routingNumber: null, accountNumberLast4: null };
    expect(checkReadiness(bank, readCheckSettings(null))).toEqual({ ready: false, missing: ['nextCheckNumber'] });
    expect(checkReadiness({ ...bank, nextCheckNumber: 1001 }, readCheckSettings(null))).toEqual({ ready: true, missing: [] });
    expect(checkReadiness({ ...bank, nextCheckNumber: 1001 }, readCheckSettings({ printMicr: true })).missing).toEqual(['routingNumber', 'accountNumber']);
  });
});
