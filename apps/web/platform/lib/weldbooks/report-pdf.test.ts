// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildReportPdf, formatReportAmount, reportPaperSize, type ReportPdfLabels } from './report-pdf';
import type { PrintTableRow, ReportPrintDocument } from './report-types';

const labels: ReportPdfLabels = {
  basis: { cash: 'Cash basis', accrual: 'Accrual basis' },
  amountsIn: 'Amounts in {currency}',
  generated: 'Generated {date}',
  page: 'Page {page} of {total}',
  taxId: 'EIN',
  dba: 'DBA',
  account: 'Account',
};

function document(overrides: Partial<ReportPrintDocument> = {}, rows?: PrintTableRow[]): ReportPrintDocument {
  return {
    kind: 'report',
    report: 'profit_loss',
    title: 'Profit and loss',
    paper: 'letter',
    entity: {
      name: 'Acme',
      legalName: 'Acme LLC',
      dba: 'Acme Co',
      address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
      taxId: '12-3456789',
      jurisdictionCode: 'US',
      locale: 'en-US',
      timezone: 'America/Chicago',
    },
    basis: 'accrual',
    periodLabel: 'Period: 2026-01-01 to 2026-12-31',
    currency: 'USD',
    generatedAt: '2026-10-08T10:00:00.000Z',
    table: {
      report: 'profit_loss',
      title: 'Profit and loss',
      hasCode: true,
      columns: [{ key: 'current', label: '2026-01-01 to 2026-12-31', numeric: true }],
      rows: rows ?? [
        { kind: 'section', depth: 0, label: 'Income', values: {} },
        { kind: 'account', depth: 1, label: 'Sales', code: '4000', values: { current: '1234567.5' } },
        { kind: 'total', depth: 0, label: 'Net income', values: { current: '-12.00' } },
      ],
      notes: ['A note under the table.'],
    },
    ...overrides,
  };
}

describe('formatReportAmount', () => {
  it('groups digits and keeps two decimals', () => {
    expect(formatReportAmount('1234567.5', 'en-US')).toBe('1,234,567.50');
    expect(formatReportAmount('-12', 'en-US')).toBe('-12.00');
    expect(formatReportAmount('1234.5', 'nl-NL')).toBe('1.234,50');
  });

  it('leaves text, percentages and empty values alone', () => {
    expect(formatReportAmount('12.5%')).toBe('12.5%');
    expect(formatReportAmount(null)).toBe('');
    expect(formatReportAmount(undefined)).toBe('');
    expect(formatReportAmount('')).toBe('');
  });
});

describe('buildReportPdf', () => {
  const options = { labels, locale: 'en-US', formatDate: (value: string) => value };

  it('renders a PDF on US Letter for a US document', async () => {
    const bytes = await buildReportPdf(document(), options);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');

    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
  });

  it('uses A4 for a document that says so', async () => {
    const bytes = await buildReportPdf(document({ paper: 'a4' }), options);
    const pdf = await PDFDocument.load(bytes);
    const { width, height } = pdf.getPage(0).getSize();
    expect(Math.round(width)).toBe(595);
    expect(Math.round(height)).toBe(842);
    expect(reportPaperSize({ paper: 'a4' }).width).toBeCloseTo(595.28);
  });

  it('turns landscape when the report has many value columns', async () => {
    const columns = Array.from({ length: 13 }, (_, i) => ({ key: `c${i}`, label: `Col ${i}`, numeric: true }));
    const doc = document();
    doc.table.columns = columns;
    doc.table.rows = [{ kind: 'account', depth: 0, label: 'Sales', values: Object.fromEntries(columns.map((c) => [c.key, '1.00'])) }];
    const pdf = await PDFDocument.load(await buildReportPdf(doc, options));
    expect(pdf.getPage(0).getSize()).toEqual({ width: 792, height: 612 });
  });

  it('continues on a new page when the table is long', async () => {
    const rows: PrintTableRow[] = Array.from({ length: 120 }, (_, i) => ({
      kind: 'account',
      depth: 0,
      label: `Account ${i}`,
      code: String(1000 + i),
      values: { current: String(i) },
    }));
    const pdf = await PDFDocument.load(await buildReportPdf(document({}, rows), options));
    expect(pdf.getPageCount()).toBeGreaterThan(2);
  });

  it('does not fail on text the standard fonts can not draw', async () => {
    const rows: PrintTableRow[] = [
      { kind: 'account', depth: 0, label: 'Café – 日本語 ₹', code: null, values: { current: '1.00' } },
    ];
    const bytes = await buildReportPdf(document({}, rows), { ...options, periodLabel: 'Per 31 dec – €' });
    expect(bytes.length).toBeGreaterThan(500);
  });

  it('renders a document without a basis, tax ID or notes', async () => {
    const doc = document({ basis: null });
    doc.entity.taxId = null;
    doc.entity.dba = null;
    doc.table.notes = [];
    const bytes = await buildReportPdf(doc, options);
    expect(bytes.length).toBeGreaterThan(500);
  });
});
