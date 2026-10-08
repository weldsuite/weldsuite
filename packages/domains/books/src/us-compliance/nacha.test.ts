import { describe, it, expect } from 'vitest';
import {
  NACHA_MAX_AMOUNT,
  abaCheckDigit,
  abaChecksumValid,
  buildNachaFile,
  buildRmrSegments,
  companyIdFromEin,
  isAchBankingDay,
  nextAchBankingDay,
  sameDayLimitDollars,
  sanitizeAchText,
  suggestEffectiveEntryDate,
  verifyNachaFile,
  type NachaFileInput,
  type NachaIssueCode,
  type NachaPayment,
} from './nacha';

// Real routing numbers of large banks; each passes the ABA checksum.
const CHASE_NY = '021000021';
const BOFA_CA = '121000358';
const CHASE_IL = '071000013';
const CHASE_CA = '322271627';
const BOFA_NY = '026009593';

const PAD = (value: string, length: number) => value.padEnd(length, ' ');

function input(over: Partial<NachaFileInput> = {}): NachaFileInput {
  return {
    originator: {
      immediateDestination: CHASE_NY,
      immediateDestinationName: 'JPMORGAN CHASE',
      immediateOrigin: '1123456789',
      immediateOriginName: 'WELD DEMO LLC',
      companyName: 'Weld Demo LLC',
      companyIdentification: '123456789',
      offsetAccount: { routingNumber: CHASE_NY, accountNumber: '5550001234', accountType: 'checking' },
    },
    payments: [
      { id: 'p1', name: 'Acme Supplies Inc', routingNumber: BOFA_CA, accountNumber: '123456789', accountType: 'checking', amount: 1234.56, identification: 'INV-1001' },
      { id: 'p2', name: 'Beta Tools', routingNumber: CHASE_IL, accountNumber: '98765432', accountType: 'savings', amount: 250, identification: 'INV-1002' },
    ],
    effectiveEntryDate: '2026-10-09',
    fileCreation: { date: '2026-10-08', time: '1430' },
    ...over,
  };
}

function build(over: Partial<NachaFileInput> = {}) {
  const result = buildNachaFile(input(over));
  if (!result.ok) throw new Error(`build failed: ${JSON.stringify(result.errors)}`);
  return result;
}

function errorCodes(over: Partial<NachaFileInput>): NachaIssueCode[] {
  const result = buildNachaFile(input(over));
  return result.ok ? [] : result.errors.map((e) => e.code);
}

function pay(over: Partial<NachaPayment> = {}): NachaPayment {
  return { id: 'x', name: 'Vendor', routingNumber: BOFA_CA, accountNumber: '1234567', accountType: 'checking', amount: 10, ...over };
}

describe('known-good unbalanced CCD file', () => {
  // Hand-checked field by field against the NACHA record layouts.
  const expected = [
    '101 021000021' + '1123456789' + '261008' + '1430' + 'A' + '094' + '10' + '1' + PAD('JPMORGAN CHASE', 23) + PAD('WELD DEMO LLC', 23) + ' '.repeat(8),
    '5' + '220' + PAD('WELD DEMO LLC', 16) + ' '.repeat(20) + '1123456789' + 'CCD' + 'VENDOR PAY' + ' '.repeat(6) + '261009' + '   ' + '1' + '02100002' + '0000001',
    '6' + '22' + '12100035' + '8' + PAD('123456789', 17) + '0000123456' + PAD('INV-1001', 15) + PAD('ACME SUPPLIES INC', 22) + '  ' + '0' + '021000020000001',
    '6' + '32' + '07100001' + '3' + PAD('98765432', 17) + '0000025000' + PAD('INV-1002', 15) + PAD('BETA TOOLS', 22) + '  ' + '0' + '021000020000002',
    '8' + '220' + '000002' + '0019200036' + '000000000000' + '000000148456' + '1123456789' + ' '.repeat(19) + ' '.repeat(6) + '02100002' + '0000001',
    '9' + '000001' + '000001' + '00000002' + '0019200036' + '000000000000' + '000000148456' + ' '.repeat(39),
    ...Array<string>(4).fill('9'.repeat(94)),
  ];

  it('builds the exact records', () => {
    const result = build();
    expect(result.lines).toEqual(expected);
    expect(result.warnings).toEqual([]);
  });

  it('is 94-character records in whole blocks of ten, with CRLF endings', () => {
    const result = build();
    expect(result.lines.every((line) => line.length === 94)).toBe(true);
    expect(result.recordCount).toBe(10);
    expect(result.blockCount).toBe(1);
    expect(result.content).toBe(expected.join('\r\n') + '\r\n');
    expect(build({ lineEnding: '\n' }).content).toBe(expected.join('\n') + '\n');
  });

  it('reports counts, hash and totals', () => {
    const result = build();
    expect(result).toMatchObject({
      batchCount: 1,
      entryAddendaCount: 2,
      entryHash: '0019200036',
      totalDebitCents: 0,
      totalCreditCents: 148_456,
    });
    expect(result.batches).toEqual([
      { batchNumber: 1, secCode: 'CCD', serviceClassCode: 220, entryAddendaCount: 2, entryHash: '0019200036', totalDebitCents: 0, totalCreditCents: 148_456 },
    ]);
    expect(result.traces).toEqual([
      { paymentId: 'p1', kind: 'payment', traceNumber: '021000020000001', batchNumber: 1 },
      { paymentId: 'p2', kind: 'payment', traceNumber: '021000020000002', batchNumber: 1 },
    ]);
  });

  it('passes the verifier', () => {
    expect(verifyNachaFile(build().content)).toMatchObject({
      ok: true,
      issues: [],
      batchCount: 1,
      entryAddendaCount: 2,
      entryHash: '0019200036',
      totalCreditCents: 148_456,
    });
  });
});

describe('balanced file', () => {
  it('adds one offsetting debit to the originator\'s account and makes the batch mixed', () => {
    const result = build({ balanced: true });
    const offset =
      '6' + '27' + '02100002' + '1' + PAD('5550001234', 17) + '0000148456' + ' '.repeat(15) + PAD('WELD DEMO LLC', 22) + '  ' + '0' + '021000020000003';
    expect(result.lines[4]).toBe(offset);
    expect(result.lines[1]?.slice(1, 4)).toBe('200');
    // 12100035 + 07100001 + 02100002 = 21300038
    expect(result.lines[5]).toBe(
      '8' + '200' + '000003' + '0021300038' + '000000148456' + '000000148456' + '1123456789' + ' '.repeat(25) + '02100002' + '0000001',
    );
    expect(result.lines[6]).toBe('9' + '000001' + '000001' + '00000003' + '0021300038' + '000000148456' + '000000148456' + ' '.repeat(39));
    expect(result.totalDebitCents).toBe(148_456);
    expect(result.totalCreditCents).toBe(148_456);
    expect(result.traces.at(-1)).toEqual({ paymentId: null, kind: 'offset', traceNumber: '021000020000003', batchNumber: 1 });
    expect(verifyNachaFile(result.content).ok).toBe(true);
  });

  it('debits a savings offset account with code 37 and a named offset entry', () => {
    const base = input();
    const result = build({
      balanced: true,
      originator: { ...base.originator, offsetAccount: { routingNumber: BOFA_NY, accountNumber: '777', accountType: 'savings', name: 'Offset Account' } },
    });
    const line = result.lines[4] as string;
    expect(line.slice(1, 3)).toBe('37');
    expect(line.slice(3, 12)).toBe(BOFA_NY);
    expect(line.slice(54, 76)).toBe(PAD('OFFSET ACCOUNT', 22));
  });

  it('needs the offset account', () => {
    const base = input();
    expect(errorCodes({ balanced: true, originator: { ...base.originator, offsetAccount: undefined } })).toContain('missing_offset_account');
    expect(
      errorCodes({
        balanced: true,
        originator: { ...base.originator, offsetAccount: { routingNumber: '021000022', accountNumber: '1', accountType: 'checking' } },
      }),
    ).toContain('invalid_routing_checksum');
  });

  it('leaves out the offset of a prenote-only batch', () => {
    const result = build({ balanced: true, payments: [pay({ id: 'n', prenote: true, amount: 0 })] });
    expect(result.batches[0]).toMatchObject({ serviceClassCode: 220, totalDebitCents: 0 });
    expect(result.traces.map((t) => t.kind)).toEqual(['prenote']);
  });
});

describe('batches, SEC codes and addenda', () => {
  const remittance = 'ST*820*0001\\' + 'RMR*IV*INV-1*' + '*100.00\\'.repeat(20);

  function mixed() {
    return build({
      payments: [
        pay({ id: 'ctx', secCode: 'CTX', name: 'Delta Freight Co Ltd', routingNumber: BOFA_NY, paymentInfo: remittance, amount: 900 }),
        pay({ id: 'plus', secCode: 'CCD+', name: 'Gamma Parts', routingNumber: CHASE_CA, paymentInfo: 'RMR*IV*INV-77**500.00\\', amount: 500 }),
        pay({ id: 'ppd', secCode: 'PPD', name: 'José Pérez', routingNumber: CHASE_IL, accountType: 'savings', amount: 75.1 }),
        pay({ id: 'ccd', name: 'Plain CCD Vendor', routingNumber: BOFA_CA, amount: 20 }),
      ],
    });
  }

  it('makes one batch per header SEC code in PPD, CCD, CTX order, with CCD+ in the CCD batch', () => {
    const result = mixed();
    expect(result.batches.map((b) => [b.batchNumber, b.secCode])).toEqual([
      [1, 'PPD'],
      [2, 'CCD'],
      [3, 'CTX'],
    ]);
    const headers = result.lines.filter((l) => l.startsWith('5'));
    expect(headers.map((h) => h.slice(50, 53))).toEqual(['PPD', 'CCD', 'CTX']);
    expect(headers.map((h) => h.slice(87, 94))).toEqual(['0000001', '0000002', '0000003']);
    expect(verifyNachaFile(result.content)).toMatchObject({ ok: true, issues: [], batchCount: 3 });
  });

  it('writes a CCD+ addenda record tied to its entry', () => {
    const result = mixed();
    const entryIndex = result.lines.findIndex((l) => l.startsWith('6') && l.slice(54, 76).startsWith('GAMMA PARTS'));
    const entry = result.lines[entryIndex] as string;
    const addenda = result.lines[entryIndex + 1] as string;
    expect(entry.slice(78, 79)).toBe('1');
    expect(addenda).toBe('7' + '05' + PAD('RMR*IV*INV-77**500.00\\', 80) + '0001' + entry.slice(87, 94));
  });

  it('splits a CTX remittance over addenda records and counts them in the entry', () => {
    const result = mixed();
    const entryIndex = result.lines.findIndex((l) => l.startsWith('6') && l.slice(58, 74).startsWith('DELTA FREIGHT'));
    const entry = result.lines[entryIndex] as string;
    const expectedChunks = Math.ceil(remittance.length / 80);
    expect(expectedChunks).toBeGreaterThan(2);
    // CTX layout: addenda count in 55-58, receiving company name 16 characters in 59-74.
    expect(entry.slice(54, 58)).toBe(String(expectedChunks).padStart(4, '0'));
    expect(entry.slice(58, 74)).toBe('DELTA FREIGHT CO');
    expect(entry.slice(78, 79)).toBe('1');
    const addenda = result.lines.slice(entryIndex + 1, entryIndex + 1 + expectedChunks);
    expect(addenda.map((l) => l.slice(0, 3))).toEqual(Array(expectedChunks).fill('705'));
    expect(addenda.map((l) => l.slice(83, 87))).toEqual(Array.from({ length: expectedChunks }, (_, i) => String(i + 1).padStart(4, '0')));
    expect(addenda.map((l) => l.slice(3, 83).trimEnd()).join('')).toBe(remittance);
    expect(result.lines[entryIndex + 1 + expectedChunks]?.[0]).toBe('8');
  });

  it('counts addenda records in the batch control', () => {
    const result = mixed();
    const ctx = result.batches.find((b) => b.secCode === 'CTX');
    expect(ctx?.entryAddendaCount).toBe(1 + Math.ceil(remittance.length / 80));
    expect(result.entryAddendaCount).toBe(result.batches.reduce((sum, b) => sum + b.entryAddendaCount, 0));
  });

  it('keeps counting trace numbers across the batches of a file', () => {
    const result = mixed();
    expect(result.traces.map((t) => t.traceNumber.slice(8))).toEqual(['0000001', '0000002', '0000003', '0000004']);
    expect(result.traces.map((t) => t.paymentId)).toEqual(['ppd', 'plus', 'ccd', 'ctx']);
  });

  it('transliterates the PPD name and pads the file to whole blocks', () => {
    const result = mixed();
    const ppd = result.lines.find((l) => l.startsWith('6') && l.slice(1, 3) === '32') as string;
    expect(ppd.slice(54, 76)).toBe(PAD('JOSE PEREZ', 22));
    expect(result.recordCount % 10).toBe(0);
    expect(result.recordCount).toBeGreaterThan(10);
    expect(result.blockCount).toBe(result.recordCount / 10);
    expect(result.lines.at(-1)).toBe('9'.repeat(94));
  });

  it('flags missing CCD+ info, ignored CCD info and an oversized CTX remittance', () => {
    expect(errorCodes({ payments: [pay({ secCode: 'CCD+' })] })).toContain('missing_payment_info');
    const ignored = build({ payments: [pay({ paymentInfo: 'INV 1' })] });
    expect(ignored.warnings.map((w) => w.code)).toEqual(['addenda_ignored']);
    expect(errorCodes({ payments: [pay({ secCode: 'CTX', paymentInfo: 'X'.repeat(80 * 10_000) })] })).toContain('too_many_addenda');
    const trimmed = build({ payments: [pay({ secCode: 'CCD+', paymentInfo: 'Y'.repeat(100) })] });
    expect(trimmed.warnings.map((w) => w.code)).toEqual(['addenda_trimmed']);
  });
});

describe('prenotes', () => {
  it('writes zero-dollar entries with codes 23 and 33 and no addenda', () => {
    const result = build({
      payments: [
        pay({ id: 'a', prenote: true, amount: 0 }),
        pay({ id: 'b', prenote: true, amount: 0, accountType: 'savings', secCode: 'CCD+', paymentInfo: 'ignored' }),
        pay({ id: 'c', amount: 40 }),
      ],
    });
    const entries = result.lines.filter((l) => l.startsWith('6'));
    expect(entries.map((l) => [l.slice(1, 3), l.slice(29, 39), l.slice(78, 79)])).toEqual([
      ['23', '0000000000', '0'],
      ['33', '0000000000', '0'],
      ['22', '0000004000', '0'],
    ]);
    expect(result.warnings.map((w) => w.code)).toEqual(['prenote_addenda_ignored']);
    expect(result.totalCreditCents).toBe(4_000);
    expect(verifyNachaFile(result.content).ok).toBe(true);
  });

  it('ignores an amount given to a prenote, with a warning', () => {
    const result = build({ payments: [pay({ prenote: true, amount: 12 })] });
    expect(result.lines[2]?.slice(29, 39)).toBe('0000000000');
    expect(result.warnings.map((w) => w.code)).toEqual(['prenote_amount_ignored']);
  });
});

describe('same day ACH', () => {
  it('writes SDHHMM in the company descriptive date and the file date as the effective date', () => {
    const result = build({ sameDay: { settlementTime: '1300' }, effectiveEntryDate: '2026-10-08' });
    expect(result.lines[1]?.slice(63, 69)).toBe('SD1300');
    expect(result.lines[1]?.slice(69, 75)).toBe('261008');
    expect(result.warnings).toEqual([]);
  });

  it('defaults to the 5:00 pm settlement', () => {
    expect(build({ sameDay: true, effectiveEntryDate: '2026-10-08' }).lines[1]?.slice(63, 69)).toBe('SD1700');
  });

  it('writes the caller\'s descriptive date in a standard file', () => {
    expect(build({ descriptiveDate: 'Oct 15' }).lines[1]?.slice(63, 69)).toBe('OCT 15');
  });

  it('rejects an entry over the $1,000,000 limit and an invalid time', () => {
    const big = [pay({ amount: 1_000_000.01 })];
    expect(errorCodes({ payments: big, sameDay: true, effectiveEntryDate: '2026-10-08' })).toContain('same_day_limit_exceeded');
    expect(buildNachaFile(input({ payments: [pay({ amount: 1_000_000 })], sameDay: true, effectiveEntryDate: '2026-10-08' })).ok).toBe(true);
    expect(errorCodes({ sameDay: { settlementTime: '2560' } })).toContain('invalid_same_day_time');
    // A standard (not same-day) entry may exceed $1M.
    expect(buildNachaFile(input({ payments: big })).ok).toBe(true);
  });

  it('raises the limit to $10,000,000 on 17 September 2027', () => {
    expect(sameDayLimitDollars('2027-09-16')).toBe(1_000_000);
    expect(sameDayLimitDollars('2027-09-17')).toBe(10_000_000);
    const result = buildNachaFile(
      input({
        payments: [pay({ amount: 5_000_000 })],
        sameDay: true,
        fileCreation: { date: '2027-09-17' },
        effectiveEntryDate: '2027-09-17',
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('warns when a same-day file carries another date, or a standard one is not in the future', () => {
    expect(build({ sameDay: true }).warnings.map((w) => w.code)).toContain('same_day_effective_date_mismatch');
    expect(build({ effectiveEntryDate: '2026-10-08' }).warnings.map((w) => w.code)).toContain('effective_date_not_after_file_date');
  });
});

describe('validation errors', () => {
  it('rejects a routing number that fails the checksum or has the wrong shape', () => {
    expect(errorCodes({ payments: [pay({ routingNumber: '121000359' })] })).toEqual(['invalid_routing_checksum']);
    expect(errorCodes({ payments: [pay({ routingNumber: '12100035' })] })).toEqual(['invalid_routing_format']);
    expect(errorCodes({ payments: [pay({ routingNumber: '12100035X' })] })).toEqual(['invalid_routing_format']);
    const base = input();
    expect(errorCodes({ originator: { ...base.originator, immediateDestination: '021000022' } })).toContain('invalid_routing_checksum');
  });

  it('rejects amounts that are zero, negative, fractional beyond cents, or too large', () => {
    expect(errorCodes({ payments: [pay({ amount: 0 })] })).toEqual(['invalid_amount']);
    expect(errorCodes({ payments: [pay({ amount: -5 })] })).toEqual(['invalid_amount']);
    expect(errorCodes({ payments: [pay({ amount: Number.NaN })] })).toEqual(['invalid_amount']);
    expect(errorCodes({ payments: [pay({ amount: 10.005 })] })).toEqual(['invalid_amount']);
    expect(errorCodes({ payments: [pay({ amount: 100_000_000 })] })).toEqual(['amount_exceeds_maximum']);
    expect(NACHA_MAX_AMOUNT).toBe(99_999_999.99);
    const max = build({ payments: [pay({ amount: 99_999_999.99 })] });
    expect(max.lines[2]?.slice(29, 39)).toBe('9999999999');
    expect(verifyNachaFile(max.content).ok).toBe(true);
  });

  it('rejects a bad account number, a missing name and duplicate ids', () => {
    expect(errorCodes({ payments: [pay({ accountNumber: '' })] })).toEqual(['invalid_account_number']);
    expect(errorCodes({ payments: [pay({ accountNumber: '1'.repeat(18) })] })).toEqual(['invalid_account_number']);
    expect(errorCodes({ payments: [pay({ accountNumber: '12#45' })] })).toEqual(['invalid_account_number']);
    expect(errorCodes({ payments: [pay({ name: '  ' })] })).toEqual(['missing_name']);
    expect(errorCodes({ payments: [pay({ id: 'same' }), pay({ id: 'same' })] })).toEqual(['duplicate_payment_id']);
    expect(errorCodes({ payments: [] })).toEqual(['no_payments']);
  });

  it('rejects an invalid file id modifier, dates, company id and origin', () => {
    expect(errorCodes({ fileIdModifier: 'a' })).toEqual(['invalid_file_id_modifier']);
    expect(errorCodes({ fileIdModifier: 'AB' })).toEqual(['invalid_file_id_modifier']);
    expect(buildNachaFile(input({ fileIdModifier: '7' })).ok).toBe(true);
    expect(errorCodes({ effectiveEntryDate: '10/09/2026' })).toContain('invalid_effective_date');
    expect(errorCodes({ fileCreation: { date: '2026-02-30' } })).toContain('invalid_file_date');
    expect(errorCodes({ fileCreation: { date: '2026-10-08', time: '2561' } })).toContain('invalid_file_time');
    const base = input();
    expect(errorCodes({ originator: { ...base.originator, companyIdentification: '12345' } })).toEqual(['invalid_company_identification']);
    expect(errorCodes({ originator: { ...base.originator, immediateOrigin: '123' } })).toEqual(['invalid_immediate_origin']);
  });

  it('reserves PAYROLL and PURCHASE as entry descriptions', () => {
    expect(errorCodes({ entryDescription: 'PAYROLL' })).toEqual(['reserved_entry_description']);
    expect(errorCodes({ entryDescription: 'purchase' })).toEqual(['reserved_entry_description']);
    expect(buildNachaFile(input({ entryDescription: 'PAYABLES' })).ok).toBe(true);
  });

  it('returns every issue at once and no file', () => {
    const result = buildNachaFile(
      input({ payments: [pay({ id: 'a', routingNumber: '121000359' }), pay({ id: 'b', amount: 0 })], fileIdModifier: '!' }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => [e.code, e.paymentId])).toEqual([
      ['invalid_file_id_modifier', undefined],
      ['invalid_routing_checksum', 'a'],
      ['invalid_amount', 'b'],
    ]);
  });

  it('refuses a trace sequence that would pass 9,999,999', () => {
    expect(errorCodes({ startingTraceSequence: 9_999_999 })).toEqual(['file_too_large']);
    expect(errorCodes({ startingTraceSequence: 9_999_998 })).toEqual([]);
  });
});

describe('warnings', () => {
  it('trims names and descriptions that are too long', () => {
    const base = input();
    const result = build({
      entryDescription: 'Vendor Payments',
      originator: { ...base.originator, companyName: 'The Weld Demonstration Company LLC' },
      payments: [pay({ name: 'A Very Long Vendor Name That Cannot Fit', identification: 'INVOICE-NUMBER-00012345' })],
    });
    expect(result.warnings.map((w) => [w.code, w.field])).toEqual([
      ['description_trimmed', 'entryDescription'],
      ['name_trimmed', 'companyName'],
      ['name_trimmed', 'name'],
      ['identification_trimmed', 'identification'],
    ]);
    expect(result.lines[1]?.slice(4, 20)).toBe('THE WELD DEMONST');
    expect(result.lines[1]?.slice(53, 63)).toBe('VENDOR PAY');
    expect(result.lines[2]?.slice(54, 76)).toBe('A VERY LONG VENDOR NAM');
    expect(result.lines[2]?.slice(39, 54)).toBe('INVOICE-NUMBER-');
  });

  it('replaces characters ACH does not allow and says so', () => {
    const result = build({ payments: [pay({ name: 'Smith [Hardware] <Co>' })] });
    expect(result.lines[2]?.slice(54, 76).trimEnd()).toBe('SMITH HARDWARE CO');
    expect(result.warnings.map((w) => w.code)).toEqual(['text_sanitized']);
  });

  it('warns about a weekend or holiday effective date', () => {
    expect(build({ effectiveEntryDate: '2026-10-10' }).warnings.map((w) => w.code)).toEqual(['effective_date_not_banking_day']);
    expect(build({ effectiveEntryDate: '2026-10-12' }).warnings.map((w) => w.code)).toEqual(['effective_date_not_banking_day']);
  });

  it('cleans account numbers of spaces and hyphens kept', () => {
    const result = build({ payments: [pay({ accountNumber: '12 34-56' })] });
    expect(result.lines[2]?.slice(12, 29)).toBe(PAD('1234-56', 17));
  });
});

describe('options', () => {
  it('uses the given ODFI, batch number and trace sequence', () => {
    const base = input();
    const result = build({
      originator: { ...base.originator, odfiRoutingNumber: BOFA_NY, referenceCode: 'RUN 42' },
      startingBatchNumber: 12,
      startingTraceSequence: 500,
    });
    expect(result.lines[0]?.slice(86, 94)).toBe('RUN 42  ');
    expect(result.lines[1]?.slice(79, 94)).toBe('02600959' + '0000012');
    expect(result.traces.map((t) => t.traceNumber)).toEqual(['026009590000500', '026009590000501']);
    expect(verifyNachaFile(result.content).ok).toBe(true);
  });

  it('takes a routing number as the immediate origin', () => {
    const base = input();
    const result = build({ originator: { ...base.originator, immediateOrigin: CHASE_NY } });
    expect(result.lines[0]?.slice(13, 23)).toBe(' 021000021');
  });

  it('leaves the file time blank when none is given', () => {
    expect(build({ fileCreation: { date: '2026-10-08' } }).lines[0]?.slice(29, 33)).toBe('    ');
  });
});

describe('verifier', () => {
  const good = () => build().lines;
  const text = (lines: string[]) => lines.join('\r\n') + '\r\n';
  const codes = (lines: string[]) => verifyNachaFile(text(lines)).issues.map((i) => i.code);

  it('catches a changed batch hash, credit total and file hash', () => {
    const lines = good();
    lines[4] = (lines[4] as string).slice(0, 10) + '0019200037' + (lines[4] as string).slice(20);
    expect(codes(lines)).toContain('entry_hash');
    const credit = good();
    credit[5] = (credit[5] as string).slice(0, 43) + '000000148457' + (credit[5] as string).slice(55);
    expect(codes(credit)).toContain('control_total');
  });

  it('catches wrong counts and missing padding', () => {
    const counts = good();
    counts[4] = (counts[4] as string).slice(0, 4) + '000003' + (counts[4] as string).slice(10);
    expect(codes(counts)).toContain('record_count');
    expect(codes(good().slice(0, 8))).toContain('blocking');
    const noPadding = good().slice(0, 6);
    expect(codes(noPadding)).toContain('blocking');
  });

  it('catches a short record, a bad checksum and a bad transaction code', () => {
    const short = good();
    short[2] = (short[2] as string).slice(0, 90);
    expect(codes(short)).toContain('record_length');
    const routing = good();
    routing[2] = (routing[2] as string).slice(0, 11) + '9' + (routing[2] as string).slice(12);
    expect(codes(routing)).toContain('invalid_routing_checksum');
    const code = good();
    code[2] = (code[2] as string).slice(0, 1) + '99' + (code[2] as string).slice(3);
    expect(codes(code)).toContain('transaction_code');
  });

  it('catches trace numbers out of order and addenda out of place', () => {
    const traces = good();
    const first = traces[2] as string;
    traces[3] = (traces[3] as string).slice(0, 79) + first.slice(79);
    expect(codes(traces)).toContain('trace_number');
    const addenda = good();
    addenda.splice(3, 0, '7' + '05' + ' '.repeat(80) + '0001' + '0000001');
    expect(codes(addenda)).toContain('addenda_sequence');
  });

  it('catches missing records', () => {
    expect(verifyNachaFile('').ok).toBe(false);
    expect(codes(good().filter((l) => !l.startsWith('9') || l.startsWith('99')))).toContain('record_order');
  });

  it('accepts a file with LF endings and no trailing newline', () => {
    const lines = good();
    expect(verifyNachaFile(lines.join('\n')).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('checks the ABA checksum', () => {
    expect(abaChecksumValid('021000021')).toBe(true);
    expect(abaChecksumValid(BOFA_CA)).toBe(true);
    expect(abaChecksumValid(CHASE_IL)).toBe(true);
    expect(abaChecksumValid(CHASE_CA)).toBe(true);
    expect(abaChecksumValid(BOFA_NY)).toBe(true);
    expect(abaChecksumValid('111000025')).toBe(true);
    expect(abaChecksumValid('091000019')).toBe(true);
    expect(abaChecksumValid('021000022')).toBe(false);
    expect(abaChecksumValid('02100002')).toBe(false);
    expect(abaChecksumValid('02100002A')).toBe(false);
    expect(abaChecksumValid('')).toBe(false);
  });

  it('works out the check digit of an 8-digit prefix', () => {
    expect(abaCheckDigit('02100002')).toBe('1');
    expect(abaCheckDigit('12100035')).toBe('8');
    expect(abaCheckDigit('07100001')).toBe('3');
    for (let n = 0; n < 50; n++) {
      const prefix = String(10_000_000 + n * 1_234_567).slice(0, 8).padStart(8, '0');
      expect(abaChecksumValid(prefix + abaCheckDigit(prefix))).toBe(true);
    }
    expect(() => abaCheckDigit('123')).toThrow(RangeError);
  });

  it('builds a company identification from an EIN', () => {
    expect(companyIdFromEin('12-3456789')).toBe('1123456789');
    expect(() => companyIdFromEin('12345')).toThrow(RangeError);
  });

  it('sanitizes text to the characters ACH accepts', () => {
    expect(sanitizeAchText('Café Müller & Söhne, Inc.')).toBe('CAFE MULLER & SOHNE, INC.');
    expect(sanitizeAchText('  a   b  ')).toBe('A B');
    expect(sanitizeAchText('Smith*Co_[1]~')).toBe('SMITH CO 1');
    expect(sanitizeAchText("O'Brien #4 (West) 50% @ $5/ea")).toBe("O'BRIEN #4 (WEST) 50% @ $5/EA");
  });

  it('knows Federal Reserve banking days', () => {
    // 2026: New Year's Thursday, MLK 19 Jan, Presidents 16 Feb, Memorial 25 May, Juneteenth Friday 19 Jun.
    for (const holiday of ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25']) {
      expect(isAchBankingDay(holiday), holiday).toBe(false);
    }
    // 4 July 2026 is a Saturday: the Fed is open the Friday before.
    expect(isAchBankingDay('2026-07-03')).toBe(true);
    expect(isAchBankingDay('2026-07-04')).toBe(false);
    // 1 January 2028 is a Saturday, 1 January 2023 a Sunday (observed on Monday 2 January).
    expect(isAchBankingDay('2027-12-31')).toBe(true);
    expect(isAchBankingDay('2023-01-01')).toBe(false);
    expect(isAchBankingDay('2023-01-02')).toBe(false);
    expect(isAchBankingDay('2023-01-03')).toBe(true);
    expect(isAchBankingDay('2026-10-08')).toBe(true);
    expect(isAchBankingDay('2026-10-10')).toBe(false);
    expect(nextAchBankingDay('2026-10-10')).toBe('2026-10-13');
    expect(nextAchBankingDay('2026-10-08')).toBe('2026-10-08');
  });

  it('suggests an effective entry date', () => {
    // File made on Thursday 8 October 2026.
    expect(suggestEffectiveEntryDate('2026-10-08', '2026-10-08')).toBe('2026-10-09');
    expect(suggestEffectiveEntryDate('2026-10-20', '2026-10-08')).toBe('2026-10-20');
    expect(suggestEffectiveEntryDate('2026-10-10', '2026-10-08')).toBe('2026-10-13');
    expect(suggestEffectiveEntryDate('2026-10-08', '2026-10-08', true)).toBe('2026-10-08');
    // File made on Friday 9 October: Monday 12 October is Columbus Day.
    expect(suggestEffectiveEntryDate('2026-10-09', '2026-10-09')).toBe('2026-10-13');
  });

  it('builds RMR remittance segments', () => {
    expect(buildRmrSegments([{ reference: 'INV-1042', amount: 1250 }, { reference: 'INV*7', amount: 0.5 }])).toBe(
      'RMR*IV*INV-1042**1250.00\\RMR*IV*INV 7**0.50\\',
    );
    expect(buildRmrSegments([{ reference: 'A', amount: 1 }], '~')).toBe('RMR*IV*A**1.00~');
  });
});
