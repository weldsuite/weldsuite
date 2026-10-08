import { describe, expect, it } from 'vitest';
import { buildPrintDocument, csvResponse, toCsv, type ReportMeta, type ReportTable } from './accounting-report-export';

const meta: ReportMeta = { entityName: 'Acme, LLC', basis: 'cash', periodLabel: 'Period: 2026-07-01 to 2026-07-31', currency: 'USD' };

const table: ReportTable = {
  report: 'profit_loss',
  title: 'Profit and loss',
  hasCode: true,
  columns: [
    { key: 'current', label: 'Jul 2026', numeric: true },
    { key: 'delta', label: 'Change', numeric: true },
  ],
  rows: [
    { kind: 'section', depth: 0, label: 'Income', values: {} },
    { kind: 'account', depth: 1, label: 'Sales "web", EU', code: '4000', values: { current: '100.00', delta: '-5.00' } },
    { kind: 'account', depth: 1, label: '=HYPERLINK("http://evil")', code: '4010', values: { current: '1.00', delta: null } },
    { kind: 'account', depth: 1, label: '-draft', code: '4020', values: { current: '2.00', delta: null } },
    { kind: 'total', depth: 0, label: 'Net income', values: { current: '103.00' } },
  ],
  notes: ['Cash basis.'],
};

describe('toCsv', () => {
  const lines = toCsv(table, meta).replace('\uFEFF', '').split('\r\n');

  it('starts with the report, entity, basis, period and currency, then the header', () => {
    expect(lines.slice(0, 7)).toEqual([
      'Profit and loss',
      '"Acme, LLC"',
      'Basis: Cash',
      'Period: 2026-07-01 to 2026-07-31',
      'Amounts in USD',
      '',
      'Code,Name,Jul 2026,Change',
    ]);
  });

  it('indents by depth, quotes commas and quotes, and leaves numbers bare', () => {
    expect(lines).toContain(',Income,,');
    expect(lines).toContain('4000,"  Sales ""web"", EU",100.00,-5.00');
    expect(lines).toContain(',Net income,103.00,');
  });

  it('keeps spreadsheets from running a label as a formula', () => {
    expect(lines).toContain(`4010,"  '=HYPERLINK(""http://evil"")",1.00,`);
    expect(lines).toContain("4020,  '-draft,2.00,");
  });

  it('ends with the notes, UTF-8 BOM first', () => {
    expect(toCsv(table, meta).startsWith('\uFEFF')).toBe(true);
    expect(lines.at(-2)).toBe('Cash basis.');
  });

  it('leaves the code column and basis out when the table has none', () => {
    const plain = toCsv({ ...table, hasCode: false, rows: [{ kind: 'account', depth: 0, label: 'Total', values: { current: '1.00' } }] }, { ...meta, basis: null }).split('\r\n');
    expect(plain).not.toContain('Basis: Cash');
    expect(plain).toContain('Name,Jul 2026,Change');
    expect(plain).toContain('Total,1.00,');
  });
});

describe('csvResponse', () => {
  it('is a download with a safe filename', async () => {
    const res = csvResponse('a,b', 'report 2026/07.csv');
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="report_2026_07.csv"');
    expect(await res.text()).toBe('a,b');
  });
});

describe('buildPrintDocument', () => {
  const entity = { name: 'Acme', legalName: null, dba: null, address: null, taxId: null, locale: 'en-US', timezone: null };

  it('prints US entities on Letter and the rest on A4', () => {
    expect(buildPrintDocument(table, meta, { ...entity, jurisdictionCode: 'US' }).paper).toBe('letter');
    expect(buildPrintDocument(table, meta, { ...entity, jurisdictionCode: 'NL' }).paper).toBe('a4');
  });

  it('carries the table and when it was made', () => {
    const doc = buildPrintDocument(table, meta, { ...entity, jurisdictionCode: 'US' }, new Date('2026-07-31T12:00:00Z'));
    expect(doc).toMatchObject({ kind: 'report', report: 'profit_loss', basis: 'cash', generatedAt: '2026-07-31T12:00:00.000Z', table });
  });
});
