import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { PayrollDocument } from './documents';
import { formatDate, formatMoney, payslipLineKey, renderDocumentPdf, renderPayslipPdf, type PayslipView } from './payslip-pdf';
import type { PayslipLine } from './types';

const lines: PayslipLine[] = [
  { code: 'nl.salary', section: 'earning', labelKey: 'nl.salary', label: 'Salaris', amountCents: 300000 },
  { code: 'nl.travel', section: 'reimbursement', labelKey: 'nl.travel', label: 'Reiskosten', quantity: 20, rate: 0.23, amountCents: 4600 },
  { code: 'nl.wage_tax', section: 'tax', labelKey: 'nl.wage_tax', label: 'Loonheffing', amountCents: -61200, jurisdiction: null },
  { code: 'nl.pension', section: 'deduction', labelKey: 'nl.pension', label: 'Pensioenpremie', amountCents: -15000 },
  { code: 'nl.awf', section: 'employer', labelKey: 'nl.awf', label: 'AWf premie', amountCents: 21000 },
];

function view(overrides: Partial<PayslipView> = {}): PayslipView {
  return {
    country: 'NL',
    currency: 'EUR',
    number: '2026-0007',
    employer: { name: 'Acme BV', address: ['Dorpsstraat 1', '1234 AB Utrecht'], taxId: { label: 'Loonheffingennummer', value: '123456789L01' } },
    employee: { name: 'Jan de Vries', address: ['Kerkstraat 2', '1234 CD Utrecht'], taxIdMasked: '•••••1234', dateOfBirth: '1990-05-17' },
    period: { start: '2026-07-01', end: '2026-07-31', payDate: '2026-07-24', periodNumber: 7, taxYear: 2026 },
    lines,
    totals: {
      grossCents: 300000,
      taxableWageCents: 285000,
      employeeTaxesCents: 61200,
      employeeDeductionsCents: 15000,
      reimbursementsCents: 4600,
      netCents: 228400 + 4600,
      employerTaxesCents: 21000,
      employerCostCents: 325600,
    },
    ytd: {
      totals: {
        grossCents: 2100000,
        taxableWageCents: 1995000,
        employeeTaxesCents: 428400,
        employeeDeductionsCents: 105000,
        reimbursementsCents: 32200,
        netCents: 1598800,
        employerTaxesCents: 147000,
        employerCostCents: 2279200,
      },
      byLine: Object.fromEntries(lines.map((l) => [payslipLineKey(l), l.amountCents * 7])),
    },
    nl: { contractHoursPerWeek: 36, writtenContract: true, indefiniteContract: true, onCall: false, minimumHourlyWageCents: 1406 },
    payTo: 'NL91 •••• •••• 4300',
    watermark: null,
    ...overrides,
  };
}

async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

function header(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes.slice(0, 5));
}

describe('formatting', () => {
  it('formats money per language', () => {
    expect(formatMoney(123456, 'EUR', 'nl')).toBe('€ 1.234,56');
    expect(formatMoney(123456, 'USD', 'en')).toBe('$1,234.56');
    expect(formatMoney(-5, 'EUR', 'en')).toBe('-€0.05');
    expect(formatMoney(100, 'SEK', 'en')).toBe('SEK 1.00');
  });

  it('formats dates per language', () => {
    expect(formatDate('2026-07-31', 'nl')).toBe('31-07-2026');
    expect(formatDate('2026-07-31', 'en')).toBe('07/31/2026');
  });
});

describe('renderPayslipPdf', () => {
  it('renders a Dutch payslip with a YTD column', async () => {
    const bytes = await renderPayslipPdf(view(), 'nl');
    expect(header(bytes)).toBe('%PDF-');
    expect(await pageCount(bytes)).toBe(1);
  });

  it('renders a US pay stub in English', async () => {
    const us = view({
      country: 'US',
      currency: 'USD',
      employer: { name: 'Acme Inc', address: ['1 Main St', 'Austin, TX 78701'], taxId: { label: 'EIN', value: '12-3456789' } },
      employee: { name: 'Pat Doe', address: [], taxIdMasked: '***-**-6789' },
      nl: null,
      us: { workState: 'TX' },
      payTo: null,
    });
    expect(await pageCount(await renderPayslipPdf(us, 'en'))).toBe(1);
  });

  it('draws a draft watermark and a correction banner without breaking', async () => {
    const bytes = await renderPayslipPdf(view({ watermark: 'CONCEPT', number: null, correction: { originalNumber: '2026-0003' } }), 'nl');
    expect(header(bytes)).toBe('%PDF-');
  });

  it('survives characters outside WinAnsi (they become ? or lose their accent)', async () => {
    const odd = view({
      employee: { name: 'Łukasz 王 Kowalski', address: ['Ulica Świętokrzyska 5 \u{1F600}'], taxIdMasked: null },
      lines: [{ code: 'bonus', section: 'earning', labelKey: 'bonus', label: 'Bonus ✓ (Zażółć)', amountCents: 1000 }],
    });
    const bytes = await renderPayslipPdf(odd, 'en');
    expect(await pageCount(bytes)).toBe(1);
  });

  it('flows onto more pages when there are many lines', async () => {
    const many: PayslipLine[] = Array.from({ length: 120 }, (_, i) => ({
      code: `hours.regular.${i}`,
      section: 'earning',
      labelKey: 'hours',
      label: `Hours day ${i + 1}`,
      quantity: 8,
      rate: 25,
      amountCents: 20000,
    }));
    const bytes = await renderPayslipPdf(view({ lines: many, ytd: null }), 'en');
    expect(await pageCount(bytes)).toBeGreaterThan(2);
  });

  it('keeps a payslip without a minimum wage figure rendering', async () => {
    const bytes = await renderPayslipPdf(view({ nl: { contractHoursPerWeek: null, writtenContract: false, indefiniteContract: false, onCall: true } }), 'nl');
    expect(await pageCount(bytes)).toBe(1);
  });
});

describe('renderDocumentPdf', () => {
  const doc: PayrollDocument = {
    title: 'Jaaropgaaf 2026',
    subtitle: 'Acme BV',
    language: 'nl',
    from: ['Acme BV', 'Dorpsstraat 1'],
    to: ['Jan de Vries', 'Kerkstraat 2'],
    sections: [
      { kind: 'fields', title: 'Gegevens', fields: [{ label: 'Loon', value: '€ 36.000,00', emphasis: true }, { label: 'Loonheffing', value: '€ 7.344,00' }] },
      {
        kind: 'table',
        title: 'Per maand',
        columns: ['Maand', 'Loon', 'Loonheffing'],
        alignRight: [1, 2],
        rows: Array.from({ length: 12 }, (_, i) => [`${i + 1}`, '€ 3.000,00', '€ 612,00']),
        totals: ['Totaal', '€ 36.000,00', '€ 7.344,00'],
      },
      { kind: 'text', title: 'Toelichting', paragraphs: ['Dit is een jaaropgaaf. '.repeat(30)] },
    ],
    footer: ['Acme BV - loonheffingennummer 123456789L01'],
    watermark: 'CONCEPT',
  };

  it('renders fields, a table with totals and text', async () => {
    const bytes = await renderDocumentPdf(doc);
    expect(header(bytes)).toBe('%PDF-');
    expect(await pageCount(bytes)).toBeGreaterThanOrEqual(1);
  });

  it('handles a wide table and a long table across pages', async () => {
    const wide: PayrollDocument = {
      title: 'Wage report',
      language: 'en',
      sections: [
        {
          kind: 'table',
          columns: ['SSN', 'Name', 'Wages', 'Tax', 'Another very long column header', 'More'],
          alignRight: [2, 3],
          rows: Array.from({ length: 200 }, (_, i) => [`***-**-${String(i).padStart(4, '0')}`, `Employee with a rather long name ${i}`, '$1,000.00', '$100.00', 'x'.repeat(60), 'y']),
        },
      ],
    };
    const bytes = await renderDocumentPdf(wide);
    expect(await pageCount(bytes)).toBeGreaterThan(3);
  });
});
