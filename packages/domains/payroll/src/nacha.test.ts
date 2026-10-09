import { describe, expect, it } from 'vitest';
import { buildNachaFile, isValidRoutingNumber, type NachaFileInput } from './nacha';

const originator = { companyName: 'Acme Widgets Inc', companyId: '1123456789', odfiRouting: '011000015', odfiName: 'Federal Reserve Boston' };

function file(overrides: Partial<NachaFileInput> = {}): NachaFileInput {
  return {
    originator,
    effectiveDate: '2026-10-16',
    createdAt: '2026-10-14T09:30:00Z',
    credits: [
      { individualId: 'EMP-001', individualName: 'José Álvarez', routingNumber: '021000021', accountNumber: '123456789', accountType: 'checking', amountCents: 154_321 },
      { individualId: 'EMP-002', individualName: 'Mary Smith', routingNumber: '121000248', accountNumber: '9876-5432', accountType: 'savings', amountCents: 200_000 },
      { individualId: 'EMP-003', individualName: 'Li Wei', routingNumber: '011000015', accountNumber: '55555', accountType: 'checking', amountCents: 99 },
    ],
    ...overrides,
  };
}

const recordsOf = (content: string) => content.split('\n').filter((l) => l.length > 0);

describe('isValidRoutingNumber', () => {
  it('accepts real routing numbers (ABA checksum)', () => {
    for (const r of ['011000015', '021000021', '121000248', '026009593', '322271627']) expect(isValidRoutingNumber(r)).toBe(true);
  });

  it('rejects a wrong check digit, wrong length, letters, zeros and unknown prefixes', () => {
    for (const r of ['021000022', '12100024', '0210000210', 'abcdefghi', '000000000', '500000005']) expect(isValidRoutingNumber(r)).toBe(false);
  });
});

describe('buildNachaFile', () => {
  it('writes 94-character records in blocks of 10, padded with 9s', () => {
    const f = buildNachaFile(file());
    expect(f.issues).toEqual([]);
    const records = recordsOf(f.content);
    expect(records.every((r) => r.length === 94)).toBe(true);
    expect(records).toHaveLength(10);
    expect(records.map((r) => r[0]).join('')).toBe('1566689999');
    expect(records.slice(7).every((r) => r === '9'.repeat(94))).toBe(true);
    expect(f.fileName).toBe('payroll-20261014-A.ach');
  });

  it('fills the file header', () => {
    const header = recordsOf(buildNachaFile(file()).content)[0];
    expect(header.slice(0, 3)).toBe('101');
    expect(header.slice(3, 13)).toBe(' 011000015');
    expect(header.slice(13, 23)).toBe('1123456789');
    expect(header.slice(23, 29)).toBe('261014');
    expect(header.slice(29, 33)).toBe('0930');
    expect(header.slice(33, 40)).toBe('A094101');
    expect(header.slice(40, 63)).toBe('FEDERAL RESERVE BOSTON ');
    expect(header.slice(63, 86)).toBe('ACME WIDGETS INC       ');
  });

  it('writes a PPD credit batch with service class 220 and the PAYROLL description', () => {
    const batch = recordsOf(buildNachaFile(file({ entryDescription: 'SALARY' })).content)[1];
    expect(batch.slice(0, 4)).toBe('5220');
    expect(batch.slice(4, 20)).toBe('ACME WIDGETS INC');
    expect(batch.slice(40, 50)).toBe('1123456789');
    expect(batch.slice(50, 53)).toBe('PPD');
    expect(batch.slice(53, 63)).toBe('PAYROLL   ');
    expect(batch.slice(69, 75)).toBe('261016');
    expect(batch.slice(78, 87)).toBe('101100001');
    expect(batch.slice(87, 94)).toBe('0000001');
  });

  it('writes entry details with transaction codes, amounts and ascending trace numbers', () => {
    const entries = recordsOf(buildNachaFile(file()).content).slice(2, 5);
    expect(entries[0].slice(0, 3)).toBe('622');
    expect(entries[0].slice(3, 12)).toBe('021000021');
    expect(entries[0].slice(12, 29)).toBe('123456789        ');
    expect(entries[0].slice(29, 39)).toBe('0000154321');
    expect(entries[0].slice(39, 54)).toBe('EMP-001        ');
    expect(entries[0].slice(54, 76)).toBe('JOSE ALVAREZ          ');
    expect(entries[0].slice(78, 79)).toBe('0');
    expect(entries[1].slice(0, 3)).toBe('632');
    expect(entries[1].slice(12, 29)).toBe('9876-5432        ');
    expect(entries.map((e) => e.slice(79, 94))).toEqual(['011000010000001', '011000010000002', '011000010000003']);
  });

  it('totals the batch and the file: counts, entry hash and amounts', () => {
    const records = recordsOf(buildNachaFile(file()).content);
    const batchControl = records[5];
    const fileControl = records[6];
    // Entry hash: 02100002 + 12100024 + 01100001 = 15300027.
    expect(batchControl).toBe(`822000000300153000270000000000000000003544201123456789${' '.repeat(25)}011000010000001`);
    expect(fileControl.slice(0, 55)).toBe('9000001000001000000030015300027000000000000000000354420');
    expect(fileControl.slice(55)).toBe(' '.repeat(39));
  });

  it('adds one offsetting debit for a balanced file (service class 200, code 27)', () => {
    const f = buildNachaFile(file({ balancedOffset: { routingNumber: '026009593', accountNumber: '000123', accountType: 'checking' } }));
    const records = recordsOf(f.content);
    expect(records[1].slice(1, 4)).toBe('200');
    const offset = records[5];
    expect(offset.slice(0, 3)).toBe('627');
    expect(offset.slice(29, 39)).toBe('0000354420');
    expect(offset.slice(54, 76)).toBe('ACME WIDGETS INC      ');
    const control = records[6];
    // Hash + 02600959 = 17900986; debit = credit.
    expect(control.slice(0, 44)).toBe('82000000040017900986000000354420000000354420');
    expect(records[7].slice(0, 13)).toBe('9000001000001');
  });

  it('keeps only the rightmost 10 digits of an overflowing entry hash', () => {
    const credits = Array.from({ length: 400 }, (_, i) => ({
      individualId: `E${i}`,
      individualName: `Employee ${i}`,
      routingNumber: '322271627',
      accountNumber: String(1000 + i),
      accountType: 'checking' as const,
      amountCents: 100,
    }));
    const records = recordsOf(buildNachaFile(file({ credits })).content);
    // 400 × 32227162 = 12,890,864,800.
    const batchControl = records.find((r) => r.startsWith('8'));
    expect(batchControl?.slice(10, 20)).toBe('2890864800');
    expect(records.length % 10).toBe(0);
    // 1 + 1 + 400 + 1 + 1 = 404 records → 41 blocks.
    expect(records.find((r) => r.startsWith('9') && r !== '9'.repeat(94))?.slice(7, 13)).toBe('000041');
  });

  it('reports and skips invalid bank details and zero amounts', () => {
    const f = buildNachaFile(
      file({
        credits: [
          { individualId: 'A', individualName: 'A', routingNumber: '021000022', accountNumber: '1', accountType: 'checking', amountCents: 100 },
          { individualId: 'B', individualName: 'B', routingNumber: '021000021', accountNumber: '12 34 56', accountType: 'checking', amountCents: 100 },
          { individualId: 'C', individualName: 'C', routingNumber: '021000021', accountNumber: 'ABC#123', accountType: 'checking', amountCents: 100 },
          { individualId: 'D', individualName: 'D', routingNumber: '021000021', accountNumber: '42', accountType: 'checking', amountCents: 0 },
        ],
      }),
    );
    expect(f.issues).toEqual([
      { severity: 'error', code: 'invalid_routing_number', params: { individualId: 'A' } },
      { severity: 'error', code: 'invalid_account_number', params: { individualId: 'C' } },
      { severity: 'warning', code: 'net_pay_zero', params: { individualId: 'D' } },
    ]);
    const entries = recordsOf(f.content).filter((r) => r.startsWith('6'));
    expect(entries).toHaveLength(1);
    expect(entries[0].slice(12, 29)).toBe('123456           ');
  });

  it('flags an invalid ODFI routing number', () => {
    const f = buildNachaFile(file({ originator: { ...originator, odfiRouting: '011000016' } }));
    expect(f.issues).toContainEqual({ severity: 'error', code: 'employer_incomplete', params: { field: 'odfiRouting' } });
  });
});
