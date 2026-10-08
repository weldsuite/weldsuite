import {
  BANK_ACCOUNT_TYPES,
  DEFAULT_PAYMENT_METHODS,
  US_PAYMENT_METHODS,
  bankAccountSubtitle,
  defaultPaymentMethod,
  isBankAccountType,
  maskedAccountNumber,
  offersDepositChoice,
  paymentExtras,
  paymentMethodsFor,
  takesCheckNumber,
  waitsInUndepositedFunds,
} from '@/lib/payments';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';

describe('payment methods', () => {
  it('offers a US entity check, ACH, wire, cards and cash', () => {
    expect([...paymentMethodsFor(true)]).toEqual(['check', 'ach', 'wire', 'credit_card', 'debit_card', 'cash', 'other']);
    expect(paymentMethodsFor(true)).toBe(US_PAYMENT_METHODS);
  });

  it('keeps the other jurisdictions on their own list', () => {
    expect(paymentMethodsFor(false)).toBe(DEFAULT_PAYMENT_METHODS);
    expect([...paymentMethodsFor(false)]).toContain('bank_transfer');
    expect([...paymentMethodsFor(false)]).not.toContain('check');
  });

  it('starts on ACH in the US and a bank transfer elsewhere', () => {
    expect(defaultPaymentMethod(true)).toBe('ach');
    expect(defaultPaymentMethod(false)).toBe('bank_transfer');
  });

  it('has a label for every method in both languages', () => {
    const labelKeys = {
      check: 'check',
      ach: 'ach',
      wire: 'wire',
      credit_card: 'creditCard',
      debit_card: 'debitCard',
      cash: 'cash',
      other: 'other',
      bank_transfer: 'bankTransfer',
      card: 'card',
      direct_debit: 'directDebit',
      manual: 'other',
    } as const;
    for (const method of [...US_PAYMENT_METHODS, ...DEFAULT_PAYMENT_METHODS]) {
      for (const catalog of [en.payments, nl.payments]) expect(catalog[labelKeys[method]]).toBeTruthy();
    }
  });
});

describe('checks and Undeposited Funds', () => {
  it('lets checks and cash wait to be deposited, nothing else', () => {
    expect(waitsInUndepositedFunds('check')).toBe(true);
    expect(waitsInUndepositedFunds('cash')).toBe(true);
    for (const method of ['ach', 'wire', 'credit_card', 'debit_card', 'other', 'bank_transfer']) {
      expect(waitsInUndepositedFunds(method)).toBe(false);
    }
  });

  it('offers the choice only for a US payment received by check or cash', () => {
    expect(offersDepositChoice(true, 'received', 'check')).toBe(true);
    expect(offersDepositChoice(true, 'received', 'cash')).toBe(true);
    expect(offersDepositChoice(true, 'received', 'ach')).toBe(false);
    // Paying a bill takes no deposit.
    expect(offersDepositChoice(true, 'sent', 'check')).toBe(false);
    // The Dutch chart has no Undeposited Funds.
    expect(offersDepositChoice(false, 'received', 'cash')).toBe(false);
  });

  it('asks for a check number on a US check, received or issued', () => {
    expect(takesCheckNumber(true, 'check')).toBe(true);
    expect(takesCheckNumber(true, 'ach')).toBe(false);
    expect(takesCheckNumber(false, 'check')).toBe(false);
  });
});

describe('paymentExtras', () => {
  it('sends the number and the deposit target of a received check', () => {
    expect(
      paymentExtras({ isUs: true, direction: 'received', method: 'check', checkNumber: ' 1042 ', depositTo: 'undeposited_funds' }),
    ).toEqual({ checkNumber: '1042', depositTo: 'undeposited_funds' });
  });

  it('sends cash that goes straight to the bank as such', () => {
    expect(paymentExtras({ isUs: true, direction: 'received', method: 'cash', depositTo: 'bank' })).toEqual({
      depositTo: 'bank',
    });
  });

  it('defaults a received check to Undeposited Funds', () => {
    expect(paymentExtras({ isUs: true, direction: 'received', method: 'check' })).toEqual({
      depositTo: 'undeposited_funds',
    });
  });

  it('sends only the number for a check we issue', () => {
    expect(paymentExtras({ isUs: true, direction: 'sent', method: 'check', checkNumber: '2001', depositTo: 'bank' })).toEqual({
      checkNumber: '2001',
    });
  });

  it('sends nothing for a method without extras, and drops a stale number when the method changed', () => {
    expect(paymentExtras({ isUs: true, direction: 'received', method: 'ach', checkNumber: '1042', depositTo: 'bank' })).toEqual({});
  });

  it('sends nothing at all outside the US', () => {
    expect(paymentExtras({ isUs: false, direction: 'received', method: 'cash', checkNumber: '1', depositTo: 'bank' })).toEqual({});
  });

  it('leaves out a blank check number', () => {
    expect(paymentExtras({ isUs: true, direction: 'sent', method: 'check', checkNumber: '   ' })).toEqual({});
  });
});

describe('bank accounts', () => {
  it('masks an account number to its last four digits', () => {
    expect(maskedAccountNumber('1234')).toBe('••••1234');
    expect(maskedAccountNumber('0042')).toBe('••••0042');
    expect(maskedAccountNumber(undefined)).toBeNull();
    expect(maskedAccountNumber('')).toBeNull();
  });

  it('never prints more than four digits', () => {
    // A full number must not slip through if it ever reached the app.
    expect(maskedAccountNumber('123456789')).toBeNull();
    expect(maskedAccountNumber('12ab')).toBeNull();
  });

  it('knows the account types', () => {
    expect([...BANK_ACCOUNT_TYPES]).toEqual(['checking', 'savings', 'credit_card', 'money_market', 'line_of_credit']);
    expect(isBankAccountType('savings')).toBe(true);
    expect(isBankAccountType('ledger')).toBe(false);
    expect(isBankAccountType(undefined)).toBe(false);
    for (const type of BANK_ACCOUNT_TYPES) {
      expect(en.bank.accountTypes[type]).toBeTruthy();
      expect(nl.bank.accountTypes[type]).toBeTruthy();
    }
  });

  it('describes a US account by bank, type and last four digits, with no IBAN', () => {
    expect(
      bankAccountSubtitle(
        { bankName: 'Chase', accountType: 'checking', accountNumberLast4: '1234', iban: undefined },
        en.bank.accountTypes,
      ),
    ).toBe('Chase · Checking ••••1234');
    expect(bankAccountSubtitle({ accountType: 'savings', accountNumberLast4: '9876' }, en.bank.accountTypes)).toBe(
      'Savings ••••9876',
    );
    expect(bankAccountSubtitle({ bankName: 'Amex', accountType: 'credit_card', accountNumberLast4: '0005' }, nl.bank.accountTypes)).toBe(
      'Amex · Creditcard ••••0005',
    );
  });

  it('describes a European account by its IBAN, then its bank', () => {
    expect(bankAccountSubtitle({ iban: 'NL91ABNA0417164300', bankName: 'ABN AMRO', accountType: 'checking' }, en.bank.accountTypes)).toBe(
      'NL91ABNA0417164300',
    );
    expect(bankAccountSubtitle({ bankName: 'ING', accountType: 'checking' }, en.bank.accountTypes)).toBe('ING');
    expect(bankAccountSubtitle({ accountType: 'checking' }, en.bank.accountTypes)).toBeUndefined();
  });
});
