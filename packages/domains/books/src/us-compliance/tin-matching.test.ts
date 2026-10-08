import { describe, it, expect } from 'vitest';
import {
  buildTinMatchingFiles,
  parseTinMatchingResults,
  sanitizeTinMatchName,
  tinMatchAccountNumber,
  type TinMatchRecord,
} from './tin-matching';

const record = (partyId: string, overrides: Partial<TinMatchRecord> = {}): TinMatchRecord => ({
  partyId,
  tinType: 'ssn',
  tin: '123-45-6789',
  name: 'Jane Doe',
  ...overrides,
});

describe('buildTinMatchingFiles', () => {
  it('writes TIN type;TIN;name;account lines', () => {
    const { files, skipped } = buildTinMatchingFiles([
      record('vendor1'),
      record('vendor2', { tinType: 'ein', tin: '98-7654321', name: 'Acme & Sons LLC' }),
      record('vendor3', { tinType: 'unknown', tin: '112233445', name: 'Smith-Jones' }),
    ]);
    expect(skipped).toEqual([]);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ filename: 'tin-matching-001.txt', recordCount: 3 });
    expect(files[0]!.content).toBe(
      '2;123456789;Jane Doe;vendor1\r\n1;987654321;Acme & Sons LLC;vendor2\r\n3;112233445;Smith-Jones;vendor3\r\n',
    );
  });

  it('cleans names to the characters and length the program accepts', () => {
    expect(sanitizeTinMatchName("O'Brien, J.R. / Café")).toBe('OBrien JR Cafe');
    expect(sanitizeTinMatchName('  A   B  ')).toBe('A B');
    expect(sanitizeTinMatchName('X'.repeat(60))).toHaveLength(40);
    expect(sanitizeTinMatchName('!!!')).toBe('');
    expect(sanitizeTinMatchName('Tom & Jerry-Co 2')).toBe('Tom & Jerry-Co 2');
  });

  it('skips records it cannot send and says why', () => {
    const { files, skipped } = buildTinMatchingFiles([
      record('ok'),
      record('short', { tin: '12345678' }),
      record('letters', { tin: '12345678A' }),
      record('noname', { name: '...' }),
      record('dupe', { name: 'JANE DOE' }),
      record('itin', { tinType: 'itin', tin: '912-70-1234' }),
    ]);
    expect(files[0]!.recordCount).toBe(1);
    expect(skipped).toEqual([
      { partyId: 'short', reason: 'invalid_tin' },
      { partyId: 'letters', reason: 'invalid_tin' },
      { partyId: 'noname', reason: 'missing_name' },
      { partyId: 'dupe', reason: 'duplicate' },
      { partyId: 'itin', reason: 'itin_not_supported' },
    ]);
  });

  it('sends ITINs as unknown on request', () => {
    const { files } = buildTinMatchingFiles([record('itin', { tinType: 'itin', tin: '912-70-1234' })], { includeItins: true });
    expect(files[0]!.content).toBe('3;912701234;Jane Doe;itin\r\n');
  });

  it('shortens long party ids to a 20-character account number and keeps the mapping', () => {
    const id = 'party_V1StGXR8_Z5jdHi6B-myT'; // 27 characters with the prefix
    const account = tinMatchAccountNumber(id);
    expect(account).toHaveLength(20);
    expect(account).toMatch(/^[A-Za-z0-9]+$/);
    const { files, accountToParty } = buildTinMatchingFiles([record(id)]);
    expect(files[0]!.content.trim().split(';')[3]).toBe(account);
    expect(accountToParty).toEqual({ [account]: id });
  });

  it('refuses two parties that map to the same account number', () => {
    const a = 'party_aaaaaaaaaaaaaaaaaaaaZZZZZZZZZZZZZZZZZZZZ';
    const b = 'other_bbbbbbbbbbbbbbbbbbbbZZZZZZZZZZZZZZZZZZZZ';
    const { skipped } = buildTinMatchingFiles([record(a), record(b, { tin: '222334444', name: 'Other Person' })]);
    expect(skipped).toEqual([{ partyId: b, reason: 'account_collision' }]);
  });

  it('splits at the record limit into numbered files', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      record(`v${i}`, { tin: String(100000000 + i), name: `Vendor ${i}` }),
    );
    const { files } = buildTinMatchingFiles(many, { maxRecordsPerFile: 2, filenamePrefix: 'batch' });
    expect(files.map((file) => [file.filename, file.recordCount])).toEqual([
      ['batch-001.txt', 2],
      ['batch-002.txt', 2],
      ['batch-003.txt', 1],
    ]);
  });
});

describe('parseTinMatchingResults', () => {
  const file = [
    '2;123456789;Jane Doe;vendor1;0',
    '1;987654321;Acme;vendor2;3',
    '3;112233445;Smith-Jones;vendor3;7',
    '2;555667777;No Number;;2',
    '2;000000000;Bad Request;vendor5;4',
    '2;123456789;Jane Doe;vendor6;5',
    '2;222334444;Sue;vendor7;1',
    '3;111223333;Both;vendor8;8',
    '3;111224444;SsnOnly;vendor9;6',
  ].join('\r\n');

  it('maps indicators to statuses', () => {
    const { results, unreadable } = parseTinMatchingResults(file);
    expect(unreadable).toEqual([]);
    expect(results.map((r) => [r.partyId, r.status, r.code])).toEqual([
      ['vendor1', 'match', 0],
      ['vendor2', 'mismatch', 3],
      ['vendor3', 'match', 7],
      [null, 'not_issued', 2],
      ['vendor5', 'invalid', 4],
      ['vendor6', 'duplicate', 5],
      ['vendor7', 'invalid', 1],
      ['vendor8', 'match', 8],
      ['vendor9', 'match', 6],
    ]);
    expect(results[2]).toMatchObject({ matchedAs: 'ein', tinLast4: '3445', line: 3 });
    expect(results[7]?.matchedAs).toBe('both');
    expect(results[8]?.matchedAs).toBe('ssn');
    expect(results[0]).toMatchObject({ tinLast4: '6789', accountNumber: 'vendor1' });
    expect(results[0]).not.toHaveProperty('matchedAs');
  });

  it('maps account numbers back to party ids', () => {
    const id = 'party_V1StGXR8_Z5jdHi6B-myT';
    const built = buildTinMatchingFiles([record(id)]);
    const account = tinMatchAccountNumber(id);
    const parsed = parseTinMatchingResults(`2;123456789;Jane Doe;${account};0\n`, { accountToParty: built.accountToParty });
    expect(parsed.results[0]?.partyId).toBe(id);
  });

  it('accepts comma-separated results and a record without an account number', () => {
    const parsed = parseTinMatchingResults('2,123456789,Jane Doe,vendor1,0\n2;123456789;Jane Doe;3');
    expect(parsed.results.map((r) => [r.partyId, r.code])).toEqual([['vendor1', 0], [null, 3]]);
  });

  it('reports lines it cannot read', () => {
    const parsed = parseTinMatchingResults('TIN Type;TIN;Name;Account;Result\n\n2;123456789;Jane;a;9\nnonsense');
    expect(parsed.results).toEqual([]);
    expect(parsed.unreadable.map((entry) => entry.line)).toEqual([1, 3, 4]);
  });
});
