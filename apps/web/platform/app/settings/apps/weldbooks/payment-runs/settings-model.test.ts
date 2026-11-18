import { describe, expect, it } from 'vitest';
import type { BankPaymentSettings } from '@/lib/api/domains/weldbooks-payment-runs';
import { alignmentOf, createSettingsSchema, maskedCompanyId, toFormValues, toUpdateInput } from './settings-model';
import { en } from '@weldsuite/i18n/locales/en';

const loaded: BankPaymentSettings = {
  bankAccountId: 'bnk_1',
  bankAccountName: 'Operating',
  bankName: 'First Bank',
  routingNumber: '021000021',
  accountNumberLast4: '6789',
  hasAccountNumber: true,
  nextCheckNumber: 1001,
  highestCheckNumberUsed: 1000,
  checkSettings: {
    layout: 'voucher_top',
    alignment: { dx: 2 },
    printMicr: false,
    micrLayout: 'business',
    checkNumberWidth: 6,
    bankName: null,
    bankAddressLines: [],
    fractionalNumerator: null,
    signatureLineText: null,
  },
  achSettings: {
    immediateDestination: null,
    immediateDestinationName: null,
    immediateOrigin: null,
    immediateOriginName: null,
    companyName: 'Acme',
    companyIdentification: '1123456789',
    odfiRoutingNumber: null,
    balanced: false,
    offsetBankAccountId: null,
    defaultSecCode: 'CCD',
    sameDayAllowed: false,
    entryDescription: null,
    holdWindowDays: 10,
    requirePrenotes: false,
  },
  effectiveAch: {
    immediateDestination: '021000021',
    immediateDestinationName: 'First Bank',
    immediateOrigin: '1123456789',
    immediateOriginName: 'Acme Holdings LLC',
    companyName: 'Acme',
    companyIdentification: '1123456789',
    odfiRoutingNumber: '021000021',
  },
  positivePayFormat: 'generic_csv',
  readiness: {
    checks: { ready: true, missing: [] },
    ach: { ready: true, missing: [] },
    positivePay: { ready: true, missing: [] },
  },
  layouts: [],
  positivePayFormats: [],
};

describe('toFormValues', () => {
  it('fills the form from the stored settings, leaving the write-only EIN empty', () => {
    const values = toFormValues(loaded);
    expect(values).toMatchObject({
      nextCheckNumber: '1001',
      layout: 'voucher_top',
      printMicr: false,
      checkNumberWidth: '6',
      dx: '2',
      dy: '',
      companyName: 'Acme',
      ein: '',
      holdWindowDays: '10',
      defaultSecCode: 'CCD',
      positivePayFormat: 'generic_csv',
    });
  });
});

describe('toUpdateInput', () => {
  it('sends nothing when nothing changed', () => {
    expect(toUpdateInput(toFormValues(loaded), loaded)).toEqual({});
  });

  it('sends only the keys that changed, in their section', () => {
    const values = { ...toFormValues(loaded), nextCheckNumber: '1500', printMicr: true, bankName: ' First Bank ', requirePrenotes: true };
    expect(toUpdateInput(values, loaded)).toEqual({
      nextCheckNumber: 1500,
      checkSettings: { printMicr: true, bankName: 'First Bank' },
      achSettings: { requirePrenotes: true },
    });
  });

  it('clears a key with null when its field is emptied', () => {
    const values = { ...toFormValues(loaded), companyName: '', nextCheckNumber: '' };
    expect(toUpdateInput(values, loaded)).toEqual({ nextCheckNumber: null, achSettings: { companyName: null } });
  });

  it('sends the whole alignment when one offset moves, blanks as zero', () => {
    const values = { ...toFormValues(loaded), dy: '-3.5' };
    expect(toUpdateInput(values, loaded)).toEqual({ checkSettings: { alignment: { dx: 2, dy: -3.5, micrDx: 0, micrDy: 0 } } });
  });

  it('splits the bank address into lines', () => {
    const values = { ...toFormValues(loaded), bankAddress: '1 Bank Plaza\n\n  Dallas, TX 75201 ' };
    expect(toUpdateInput(values, loaded)).toEqual({ checkSettings: { bankAddressLines: ['1 Bank Plaza', 'Dallas, TX 75201'] } });
  });

  it('sends the EIN only when one was typed', () => {
    expect(toUpdateInput({ ...toFormValues(loaded), ein: '  ' }, loaded)).toEqual({});
    expect(toUpdateInput({ ...toFormValues(loaded), ein: '12-3456789' }, loaded)).toEqual({ achSettings: { ein: '12-3456789' } });
  });
});

describe('createSettingsSchema', () => {
  const schema = createSettingsSchema(en.weldbooksUs.payments.settings.validation);
  const valid = toFormValues(loaded);
  const messagesFor = (patch: Partial<typeof valid>) => {
    const result = schema.safeParse({ ...valid, ...patch });
    return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };

  it('accepts the stored settings', () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it('checks routing numbers against the ABA checksum', () => {
    expect(messagesFor({ immediateDestination: '021000021' })).toEqual([]);
    expect(messagesFor({ immediateDestination: '021000022' })).toEqual(['immediateDestination: This routing number does not pass the ABA check.']);
    expect(messagesFor({ odfiRoutingNumber: '12345' })).toEqual(['odfiRoutingNumber: A routing number has nine digits.']);
  });

  it('keeps the offsets within 72 points', () => {
    expect(messagesFor({ dx: '72' })).toEqual([]);
    expect(messagesFor({ dy: '73' })).toEqual(['dy: Use a number between -72 and 72 points.']);
    expect(messagesFor({ micrDx: 'abc' })).toEqual(['micrDx: Use a number between -72 and 72 points.']);
  });

  it('refuses the entry descriptions Nacha reserves', () => {
    expect(messagesFor({ entryDescription: 'payroll' })).toEqual(['entryDescription: "PAYROLL" and "PURCHASE" are reserved by Nacha.']);
    expect(messagesFor({ entryDescription: 'VENDOR PAY' })).toEqual([]);
  });

  it('checks the EIN, the numerator and the hold window', () => {
    expect(messagesFor({ ein: '12-3456789' })).toEqual([]);
    expect(messagesFor({ ein: '12-345' })).toEqual(['ein: An EIN has nine digits, like 12-3456789.']);
    expect(messagesFor({ fractionalNumerator: '90-7162' })).toEqual([]);
    expect(messagesFor({ fractionalNumerator: '907162' })).toEqual(['fractionalNumerator: It looks like 90-7162.']);
    expect(messagesFor({ holdWindowDays: '0' })).toEqual(['holdWindowDays: Use a whole number of days from 1 to 365.']);
  });

  it('allows at most three bank address lines', () => {
    expect(messagesFor({ bankAddress: 'a\nb\nc' })).toEqual([]);
    expect(messagesFor({ bankAddress: 'a\nb\nc\nd' })).toEqual(['bankAddress: At most three lines of up to 60 characters.']);
  });
});

describe('helpers', () => {
  it('reads blank offsets as no shift', () => {
    expect(alignmentOf({ dx: '', dy: '1.5', micrDx: 'x', micrDy: '-2' })).toEqual({ dx: 0, dy: 1.5, micrDx: 0, micrDy: -2 });
  });

  it('shows only the ends of a company identification, which carries the EIN', () => {
    expect(maskedCompanyId('1123456789')).toBe('1•••••6789');
    expect(maskedCompanyId(null)).toBe('—');
    expect(maskedCompanyId('1234')).toBe('••••');
  });
});
