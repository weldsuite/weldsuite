import { describe, expect, it } from 'vitest';
import { parseBankFile, detectFormat } from './index';
import { parseBai2, parseBai2Amount, parseBai2Date } from './bai2';

/**
 * A prior-day report with two accounts. Account 0975312468 has its status
 * items continued on an 88 record and a long transaction text continued too;
 * one check is value-dated.
 */
const BAI2 = `01,121000248,CUSTOMERID,260116,0630,1,80,,2/
02,CUSTOMERID,121000248,1,260115,2359,USD,2/
03,0975312468,USD,010,1050000,,,015,1177750,,/
88,040,1050000,,,045,1177750,,,100,200000,2,/
16,142,125050,,B0001,INV2001,ACH CREDIT ACME CORP INVOICE 2001/
16,175,74700,0,B0002,,CHECK DEPOSIT/
88,REMOTE DEPOSIT 0116/
16,475,30000,V,260114,0000,B0003,1042,CHECK PAID/
16,495,15000,,B0004,WIRE77,OUTGOING WIRE TO SMITH & SONS, LLC/
16,890,500,,,,UNSUPPORTED CODE/
49,5555550,9/
03,0123456789,USD,010,50000,,,015,45000,,/
16,451,5000,,B0005,,ACH DEBIT UTILITY CO/
49,95000,3/
98,5650550,2,16/
99,5650550,1,20/
`;

describe('BAI2 helpers', () => {
  it('reads dates and amounts in cents', () => {
    expect(parseBai2Date('260115')).toBe('2026-01-15');
    expect(parseBai2Date('261301')).toBeNull();
    expect(parseBai2Amount('125050')).toBe(1250.5);
    expect(parseBai2Amount('-1500')).toBe(-15);
    expect(parseBai2Amount('12.50')).toBe(12.5);
    expect(parseBai2Amount('')).toBeNull();
  });
});

describe('BAI2 parser', () => {
  it('is recognised by content', () => {
    expect(detectFormat(BAI2)).toBe('bai2');
    expect(parseBankFile(BAI2, undefined, { accountLast4: '2468' }).format).toBe('bai2');
  });

  it('reads one account of a multi-account file with continuation records', () => {
    const result = parseBai2(BAI2, { accountLast4: '2468' });
    expect(result.account).toEqual({ accountNumber: '0975312468', currency: 'USD' });
    expect(result.accounts).toHaveLength(2);
    expect(result.openingBalance).toBe(10500);
    expect(result.closingBalance).toBe(11777.5);
    expect(result.availableBalance).toBe(11777.5);
    expect(result.balanceDate).toBe('2026-01-15');

    const [ach, deposit, check, wire] = result.transactions;
    expect(result.transactions).toHaveLength(4);
    expect(ach).toMatchObject({
      date: '2026-01-15',
      amount: 1250.5,
      transactionCode: '142',
      reference: 'INV2001',
      description: 'ACH CREDIT ACME CORP INVOICE 2001',
    });
    // The 88 record continues the text field.
    expect(deposit).toMatchObject({ amount: 747, description: 'CHECK DEPOSIT REMOTE DEPOSIT 0116' });
    // Debits (400-699) are money out; a value-dated record carries its value date.
    expect(check).toMatchObject({ amount: -300, valueDate: '2026-01-14', checkNumber: '1042', description: 'CHECK PAID' });
    // A comma inside the text field is part of the text, not a new field.
    expect(wire).toMatchObject({ amount: -150, reference: 'WIRE77', description: 'OUTGOING WIRE TO SMITH & SONS LLC' });
    expect(result.errors).toEqual([{ line: 10, message: 'Skipped transaction with unsupported type code 890' }]);
    expect(result.dateRange).toEqual({ from: '2026-01-15', to: '2026-01-15' });
  });

  it('gives every line a stable id so a re-sent file does not import twice', () => {
    const first = parseBai2(BAI2, { accountLast4: '2468' }).transactions.map((t) => t.externalId);
    const again = parseBai2(BAI2, { accountLast4: '2468' }).transactions.map((t) => t.externalId);
    expect(first).toEqual(again);
    expect(new Set(first).size).toBe(first.length);
    expect(first[0]).toMatch(/^bai2:/);
  });

  it('reads the other account and refuses to guess without a match', () => {
    const other = parseBai2(BAI2, { accountLast4: '6789' });
    expect(other.transactions).toHaveLength(1);
    expect(other.transactions[0]).toMatchObject({ amount: -50, description: 'ACH DEBIT UTILITY CO' });
    expect(other.closingBalance).toBe(450);

    const none = parseBai2(BAI2);
    expect(none.transactions).toEqual([]);
    expect(none.errors[0].message).toMatch(/holds 2 accounts/);
  });

  it('rejects a file without a 01 record', () => {
    expect(parseBai2('hello').errors[0].message).toMatch(/Not a BAI2/);
  });
});
