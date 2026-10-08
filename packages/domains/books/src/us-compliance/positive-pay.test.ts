import { describe, it, expect } from 'vitest';
import {
  POSITIVE_PAY_FORMATS,
  buildPositivePayFile,
  formatPositivePayDate,
  getPositivePayConfig,
  isPositivePayFormat,
  type PositivePayCheck,
  type PositivePayIssueCode,
  type PositivePayOptions,
} from './positive-pay';

const ACCOUNT = '123456789';

function check(over: Partial<PositivePayCheck> = {}): PositivePayCheck {
  return { checkNumber: 1001, issueDate: '2026-10-08', amount: 1234.56, payee: 'Acme Supplies Inc', status: 'issued', ...over };
}

function opts(over: Partial<PositivePayOptions> = {}): PositivePayOptions {
  return { format: 'generic_csv', accountNumber: ACCOUNT, ...over };
}

function build(checks: PositivePayCheck[], over: Partial<PositivePayOptions> = {}) {
  const result = buildPositivePayFile(checks, opts(over));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
}

function errors(checks: PositivePayCheck[], over: Partial<PositivePayOptions> = {}): PositivePayIssueCode[] {
  const result = buildPositivePayFile(checks, opts(over));
  return result.ok ? [] : result.errors.map((e) => e.code);
}

describe('format list', () => {
  it('lists the formats with labels', () => {
    expect(POSITIVE_PAY_FORMATS.map((f) => [f.id, f.label])).toEqual([
      ['generic_csv', 'Generic CSV'],
      ['generic_fixed', 'Generic fixed width'],
      ['bofa', 'Bank of America (CashPro)'],
      ['chase', 'Chase (ACCESS)'],
      ['wells_fargo', 'Wells Fargo (CEO)'],
      ['us_bank', 'U.S. Bank'],
    ]);
    expect(isPositivePayFormat('bofa')).toBe(true);
    expect(isPositivePayFormat('citi')).toBe(false);
  });

  it('flags the bank formats as templates the company must match to the bank\'s spec', () => {
    for (const id of ['bofa', 'chase', 'wells_fargo']) {
      const format = POSITIVE_PAY_FORMATS.find((f) => f.id === id);
      expect(format).toMatchObject({ documentation: 'none', needsBankSpec: true });
    }
    expect(POSITIVE_PAY_FORMATS.find((f) => f.id === 'us_bank')).toMatchObject({ documentation: 'third_party', needsBankSpec: true });
    expect(POSITIVE_PAY_FORMATS.find((f) => f.id === 'us_bank')?.sourceUrl).toMatch(/^https:\/\//);
    for (const id of ['generic_csv', 'generic_fixed']) {
      expect(POSITIVE_PAY_FORMATS.find((f) => f.id === id)?.needsBankSpec).toBe(false);
    }
  });

  it('starts the bank templates as the generic CSV', () => {
    for (const id of ['bofa', 'chase', 'wells_fargo'] as const) {
      expect(getPositivePayConfig(id)).toEqual(getPositivePayConfig('generic_csv'));
    }
  });
});

describe('generic CSV', () => {
  it('writes a header and one row per check, in check number order', () => {
    const result = build([
      check({ checkNumber: 1003, amount: 20, payee: 'Gamma' }),
      check({ checkNumber: 1001 }),
      check({ checkNumber: 1002, issueDate: '2026-10-07', amount: 5.5, payee: 'Smith, John & Co' }),
    ]);
    expect(result.content).toBe(
      [
        'Account Number,Check Number,Issue Date,Amount,Payee,Void',
        '123456789,1001,10/08/2026,1234.56,Acme Supplies Inc,',
        '123456789,1002,10/07/2026,5.50,"Smith, John & Co",',
        '123456789,1003,10/08/2026,20.00,Gamma,',
        '',
      ].join('\r\n'),
    );
    expect(result).toMatchObject({ recordCount: 3, issueCount: 3, voidCount: 0, totalIssuedCents: 123_456 + 550 + 2_000, totalVoidedCents: 0 });
  });

  it('orders check numbers numerically, not as text', () => {
    const result = build([check({ checkNumber: 1000 }), check({ checkNumber: 999 }), check({ checkNumber: 10_000 })]);
    expect(result.content.split('\r\n').slice(1, 4).map((l) => l.split(',')[1])).toEqual(['999', '1000', '10000']);
  });

  it('quotes cells with quotes and line breaks', () => {
    const result = build([check({ payee: 'The "Best" Co\nLtd' })]);
    expect(result.content.split('\r\n')[1]).toBe('123456789,1001,10/08/2026,1234.56,"The ""Best"" Co Ltd",');
  });

  it('names the file after the account and the end of the range', () => {
    expect(build([check()], { to: '2026-10-31' }).fileName).toBe('positive-pay-6789-2026-10-31.csv');
    expect(build([check()]).fileName).toBe('positive-pay-6789-2026-10-08.csv');
  });

  it('writes LF endings when asked', () => {
    expect(build([check()], { config: { lineEnding: '\n' } }).content).not.toContain('\r');
  });
});

describe('generic fixed width', () => {
  it('writes 83-character records', () => {
    const result = build([check({ checkNumber: 1001 })], { format: 'generic_fixed' });
    expect(result.content).toBe(
      '000123456789' + '0000001001' + '000000123456' + '10082026' + 'Acme Supplies Inc'.padEnd(40, ' ') + ' ' + '\r\n',
    );
    expect(result.content.split('\r\n')[0]).toHaveLength(83);
    expect(result.fileName.endsWith('.txt')).toBe(true);
  });

  it('marks a void with V', () => {
    const result = build([check({ status: 'voided', voidDate: '2026-10-09' })], { format: 'generic_fixed' });
    expect(result.content.split('\r\n')[0]?.slice(82)).toBe('V');
    expect(result).toMatchObject({ voidCount: 1, issueCount: 0, totalVoidedCents: 123_456 });
  });

  it('cuts a payee that is too long and warns', () => {
    const result = build([check({ payee: 'A'.repeat(55) })], { format: 'generic_fixed' });
    expect(result.content.split('\r\n')[0]?.slice(42, 82)).toBe('A'.repeat(40));
    expect(result.warnings.map((w) => w.code)).toEqual(['payee_trimmed']);
  });

  it('rejects a value wider than its column', () => {
    expect(errors([check({ checkNumber: '12345678901' })], { format: 'generic_fixed' })).toEqual(['check_number_too_long']);
    expect(errors([check()], { format: 'generic_fixed', accountNumber: '1234567890123' })).toEqual(['account_number_too_long']);
    expect(errors([check()], { format: 'generic_fixed', config: { columns: [{ field: 'check_number' }] } })).toEqual(['missing_width']);
  });
});

describe('U.S. Bank layout (third-party documentation)', () => {
  it('writes account, check number, amount, date, action, payee 1 and payee 2', () => {
    const result = build([check({ checkNumber: 1001 }), check({ checkNumber: 1002, status: 'voided', voidDate: '2026-10-09', amount: 9.99 })], {
      format: 'us_bank',
    });
    const [issue, voided] = result.content.split('\r\n');
    expect(issue).toBe('000123456789' + '0000001001' + '000000123456' + '10082026' + 'IS' + 'Acme Supplies Inc'.padEnd(40, ' ') + ' '.repeat(40));
    expect(issue).toHaveLength(124);
    expect(voided?.slice(42, 44)).toBe('CN');
    expect(voided?.slice(22, 34)).toBe('000000000999');
  });
});

describe('what a range holds', () => {
  const checks: PositivePayCheck[] = [
    check({ checkNumber: 1, issueDate: '2026-09-15', status: 'issued' }),
    check({ checkNumber: 2, issueDate: '2026-09-20', status: 'voided', voidDate: '2026-10-03' }),
    check({ checkNumber: 3, issueDate: '2026-10-02', status: 'issued' }),
    check({ checkNumber: 4, issueDate: '2026-10-04', status: 'voided', voidDate: '2026-10-05' }),
    check({ checkNumber: 5, issueDate: '2026-10-06', status: 'voided', voidDate: '2026-11-02' }),
    check({ checkNumber: 6, issueDate: '2026-11-05', status: 'issued' }),
  ];

  function nums(over: Partial<PositivePayOptions>) {
    const result = build(checks, { format: 'generic_fixed', ...over });
    return result.content
      .split('\r\n')
      .filter(Boolean)
      .map((line) => [Number(line.slice(12, 22)), line.slice(82)]);
  }

  it('holds issues in the range and voids made in it', () => {
    // Check 2 was issued in September and voided in the range: a void record only.
    // Check 5 was issued in the range and voided later: an issue.
    expect(nums({ from: '2026-10-01', to: '2026-10-31' })).toEqual([
      [2, 'V'],
      [3, ' '],
      [4, 'V'],
      [5, ' '],
    ]);
  });

  it('includes both ends of the range', () => {
    expect(nums({ from: '2026-10-02', to: '2026-10-02' })).toEqual([[3, ' ']]);
    expect(nums({ from: '2026-10-03', to: '2026-10-03' })).toEqual([[2, 'V']]);
  });

  it('marks a check voided by the end of the range as void even when it was issued in an earlier file', () => {
    expect(nums({ from: '2026-11-01', to: '2026-11-30' })).toEqual([
      [5, 'V'],
      [6, ' '],
    ]);
  });

  it('takes everything without a range', () => {
    expect(nums({}).map(([n]) => n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(nums({}).filter(([, flag]) => flag === 'V').map(([n]) => n)).toEqual([2, 4, 5]);
  });

  it('treats a voided check without a void date as voided on its issue date', () => {
    const result = build([check({ status: 'voided', voidDate: null })], { format: 'generic_fixed', from: '2026-10-08', to: '2026-10-08' });
    expect(result.voidCount).toBe(1);
  });

  it('reports totals for issues and voids separately', () => {
    const result = build(checks, { format: 'generic_fixed', from: '2026-10-01', to: '2026-10-31' });
    expect(result).toMatchObject({ recordCount: 4, issueCount: 2, voidCount: 2, totalIssuedCents: 246_912, totalVoidedCents: 246_912 });
  });
});

describe('configuration', () => {
  it('reorders columns and changes delimiter, date and amount formats', () => {
    const result = build([check()], {
      config: {
        columns: [
          { field: 'check_number', header: 'Item' },
          { field: 'amount', header: 'Amt' },
          { field: 'issue_date', header: 'Date' },
          { field: 'void_date', header: 'VoidDate' },
          { field: 'action_code', header: 'Action' },
          { field: 'blank', header: 'Filler', literal: 'X' },
        ],
        delimiter: ';',
        dateFormat: 'YYYYMMDD',
        amountFormat: 'implied_decimal',
      },
    });
    expect(result.content).toBe(['Item;Amt;Date;VoidDate;Action;Filler', '1001;123456;20261008;;IS;X', ''].join('\r\n'));
  });

  it('writes a void date and the cancel action code for a void', () => {
    const result = build([check({ status: 'voided', voidDate: '2026-10-09' })], {
      config: {
        columns: [{ field: 'check_number' }, { field: 'void_date' }, { field: 'action_code' }, { field: 'void_flag' }],
        header: false,
        dateFormat: 'MM/DD/YY',
        issueFlag: 'N',
        voidFlag: 'Y',
      },
    });
    expect(result.content).toBe('1001,10/09/26,CN,Y\r\n');
  });

  it('can leave off the header, quote everything and upper-case payees', () => {
    const result = build([check()], { config: { header: false, quoteAll: true, uppercasePayee: true } });
    expect(result.content).toBe('"123456789","1001","10/08/2026","1234.56","ACME SUPPLIES INC",""\r\n');
  });

  it('cuts a CSV payee to the bank\'s limit', () => {
    const result = build([check({ payee: 'Acme Supplies Inc' })], { config: { payeeMaxLength: 4, header: false } });
    expect(result.content).toBe('123456789,1001,10/08/2026,1234.56,Acme,\r\n');
    expect(result.warnings.map((w) => w.code)).toEqual(['payee_trimmed']);
  });

  it('takes the account number from the check in a multi-account file', () => {
    const result = build([check({ accountNumber: '987-654' }), check({ checkNumber: 1002 })], { config: { header: false } });
    expect(result.content.split('\r\n').slice(0, 2).map((l) => l.split(',')[0])).toEqual(['987-654', '123456789']);
  });

  it('does not change the preset when overriding', () => {
    build([check()], { config: { delimiter: '|' } });
    expect(getPositivePayConfig('generic_csv').delimiter).toBe(',');
    const config = getPositivePayConfig('generic_csv');
    config.columns[0] = { field: 'blank' };
    expect(getPositivePayConfig('generic_csv').columns[0]?.field).toBe('account_number');
  });
});

describe('dates', () => {
  it('formats every date style', () => {
    const d = '2026-03-07';
    expect(formatPositivePayDate(d, 'MMDDYYYY')).toBe('03072026');
    expect(formatPositivePayDate(d, 'MM/DD/YYYY')).toBe('03/07/2026');
    expect(formatPositivePayDate(d, 'YYYYMMDD')).toBe('20260307');
    expect(formatPositivePayDate(d, 'YYYY-MM-DD')).toBe('2026-03-07');
    expect(formatPositivePayDate(d, 'MMDDYY')).toBe('030726');
    expect(formatPositivePayDate(d, 'MM/DD/YY')).toBe('03/07/26');
  });
});

describe('validation', () => {
  it('rejects bad check numbers, amounts, dates and ranges', () => {
    expect(errors([check({ checkNumber: 'A12' })])).toEqual(['invalid_check_number']);
    expect(errors([check({ checkNumber: '' })])).toEqual(['invalid_check_number']);
    expect(errors([check({ amount: 0 })])).toEqual(['invalid_amount']);
    expect(errors([check({ amount: -4 })])).toEqual(['invalid_amount']);
    expect(errors([check({ amount: 10.005 })])).toEqual(['invalid_amount']);
    expect(errors([check({ amount: Number.NaN })])).toEqual(['invalid_amount']);
    expect(errors([check({ issueDate: '10/08/2026' })])).toEqual(['invalid_date']);
    expect(errors([check({ status: 'voided', voidDate: 'soon' })])).toEqual(['invalid_date']);
    expect(errors([check()], { from: '2026-10-31', to: '2026-10-01' })).toEqual(['invalid_range']);
    expect(errors([check()], { from: 'Oct 1' })).toEqual(['invalid_range']);
  });

  it('rejects duplicate check numbers on one account and an invalid account number', () => {
    expect(errors([check(), check()])).toEqual(['duplicate_check_number']);
    expect(errors([check(), check({ accountNumber: '777' })])).toEqual([]);
    expect(errors([check()], { accountNumber: '12#34' })).toEqual(['invalid_account_number']);
  });

  it('says so when a range holds nothing', () => {
    expect(errors([check()], { from: '2027-01-01', to: '2027-01-31' })).toEqual(['no_checks']);
    expect(errors([])).toEqual(['no_checks']);
  });

  it('warns about a missing payee', () => {
    expect(build([check({ payee: '  ' })]).warnings.map((w) => w.code)).toEqual(['missing_payee']);
  });

  it('ignores a check outside the range even when its data is not valid', () => {
    expect(errors([check(), check({ checkNumber: 'x', issueDate: '2026-01-01' })], { from: '2026-10-01', to: '2026-10-31' })).toEqual([]);
  });
});
