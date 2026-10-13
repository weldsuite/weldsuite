// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFPage } from 'pdf-lib';
import type { InvoiceWithTax, TaxBreakdownRow } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import {
  generateInvoicePdf,
  taxRowsOf,
  type InvoicePdfEntity,
  type InvoicePdfLabels,
} from './invoice-pdf';

const labels: InvoicePdfLabels = {
  invoice: 'INVOICE',
  from: 'FROM',
  billTo: 'BILL TO',
  shipTo: 'SHIP TO',
  issueDate: 'ISSUE DATE',
  dueDate: 'DUE DATE',
  reference: 'REFERENCE',
  description: 'DESCRIPTION',
  quantity: 'QTY',
  unitPrice: 'UNIT PRICE',
  tax: 'Sales tax',
  amount: 'AMOUNT',
  subtotal: 'Subtotal',
  total: 'Total',
  paid: 'Paid',
  balanceDue: 'Balance due',
  continued: '{number} (continued)',
  page: 'Page {page} of {total}',
  bank: 'Bank',
  iban: 'IBAN',
  bic: 'BIC',
  accountNumber: 'Account',
  routingNumber: 'Routing',
  taxId: 'EIN',
  registrationId: 'State ID',
  creditNote: 'CREDIT MEMO',
  jurisdictionTax: '{tax} – {jurisdiction} {rate}%',
  exempt: {
    reason: 'Exempt sale: {reason}.',
    reasonWithCertificate: 'Exempt sale: {reason}. Certificate no. {number}.',
    certificateOnly: 'Exempt sale. Certificate no. {number}.',
    notice: 'Exempt sale.',
  },
};

const usEntity: InvoicePdfEntity = {
  name: 'Acme LLC',
  jurisdictionCode: 'US',
  baseCurrency: 'USD',
  locale: 'en-US',
  address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' },
};

const nlEntity: InvoicePdfEntity = {
  name: 'Acme BV',
  jurisdictionCode: 'NL',
  baseCurrency: 'EUR',
  locale: 'nl-NL',
  address: { line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 LG', country: 'NL' },
};

function row(overrides: Partial<TaxBreakdownRow>): TaxBreakdownRow {
  return { taxRateName: 'Sales tax', taxRate: 0, taxableAmount: 0, taxAmount: 0, ...overrides };
}

function invoice(overrides: Partial<InvoiceWithTax> = {}): InvoiceWithTax {
  return {
    id: 'inv_1',
    invoiceNumber: 'INV-0001',
    type: 'standard',
    status: 'sent',
    contactId: 'cus_1',
    contactName: 'Globex',
    contactEmail: null,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    currency: 'USD',
    subtotal: '100.00',
    taxTotal: '8.25',
    total: '108.25',
    amountPaid: '0',
    balanceDue: '108.25',
    reference: null,
    notes: null,
    internalNotes: null,
    createdAt: '2026-03-01T00:00:00Z',
    items: [
      {
        id: 'ili_1',
        invoiceId: 'inv_1',
        description: 'Consulting',
        quantity: '1',
        unitPrice: '100.00',
        unit: null,
        discountPercent: '0',
        taxRateId: null,
        taxRate: '8.25',
        taxAmount: '8.25',
        lineTotal: '100.00',
        lineTotalWithTax: '108.25',
        accountId: null,
        sortOrder: 0,
      },
    ],
    payments: [],
    ...overrides,
  } as InvoiceWithTax;
}

const usRows: TaxBreakdownRow[] = [
  row({ lineId: 'ili_1', jurisdictionCode: 'TX', jurisdictionName: 'Texas', jurisdictionLevel: 'state', taxRate: 6.25, taxableAmount: 100, taxAmount: 6.25 }),
  row({ lineId: 'ili_1', jurisdictionCode: 'AUSTIN', jurisdictionName: 'Austin', jurisdictionLevel: 'city', taxRate: 2, taxableAmount: 100, taxAmount: 2 }),
];

/** Every string the renderer draws, in order. */
function captureText() {
  const drawn: string[] = [];
  const original = PDFPage.prototype.drawText;
  const spy = vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text, options) {
    drawn.push(String(text));
    return original.call(this, text, options);
  });
  return { drawn, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('taxRowsOf', () => {
  it('has one row per US jurisdiction: "Sales tax – Texas 6.25%"', () => {
    expect(taxRowsOf(invoice({ taxBreakdown: usRows }), labels)).toEqual([
      { label: 'Sales tax – Texas 6.25%', amount: 6.25 },
      { label: 'Sales tax – Austin 2%', amount: 2 },
    ]);
  });

  it('adds the lines of one jurisdiction together', () => {
    const rows = [
      row({ lineId: 'a', jurisdictionCode: 'TX', jurisdictionName: 'Texas', jurisdictionLevel: 'state', taxRate: 6.25, taxableAmount: 100, taxAmount: 6.25 }),
      row({ lineId: 'b', jurisdictionCode: 'TX', jurisdictionName: 'Texas', jurisdictionLevel: 'state', taxRate: 6.25, taxableAmount: 40, taxAmount: 2.5 }),
    ];
    expect(taxRowsOf(invoice({ taxBreakdown: rows }), labels)).toEqual([{ label: 'Sales tax – Texas 6.25%', amount: 8.75 }]);
  });

  it('prints one tax line for an exempt sale, so the amount is always there', () => {
    const exempt = [
      row({ jurisdictionCode: 'TX', jurisdictionName: 'Texas', jurisdictionLevel: 'state', taxRate: 0, taxAmount: 0, exemptAmount: 100, exemptReason: 'resale' }),
    ];
    expect(taxRowsOf(invoice({ taxBreakdown: exempt, taxTotal: '0.00' }), labels)).toEqual([{ label: 'Sales tax', amount: '0.00' }]);
  });

  it('keeps one row per VAT rate, as before', () => {
    const vat = [
      row({ taxRateName: 'BTW 21%', taxRate: 21, taxableAmount: 100, taxAmount: 21 }),
      row({ taxRateName: 'BTW 9%', taxRate: 9, taxableAmount: 50, taxAmount: 4.5 }),
    ];
    expect(taxRowsOf(invoice({ taxBreakdown: vat }), { ...labels, tax: 'BTW' })).toEqual([
      { label: 'BTW 21%', amount: 21 },
      { label: 'BTW 9%', amount: 4.5 },
    ]);
  });

  it('falls back to the tax total when there is no breakdown', () => {
    expect(taxRowsOf(invoice({ taxBreakdown: null }), labels)).toEqual([{ label: 'Sales tax', amount: '8.25' }]);
  });
});

const inEntity: InvoicePdfEntity = {
  name: 'Weld India Pvt Ltd',
  jurisdictionCode: 'IN',
  baseCurrency: 'INR',
  locale: 'en-IN',
  taxIdentifiers: { vatNumber: '27AABCU9603R1ZN', registrationNumber: 'AABCU9603R' },
  address: { line1: '12 Linking Road', city: 'Mumbai', state: 'Maharashtra', postalCode: '400050', country: 'IN' },
};

describe('generateInvoicePdf: India GST tax invoice', () => {
  const gstLabels: InvoicePdfLabels = {
    ...labels,
    invoice: 'TAX INVOICE',
    tax: 'GST',
    taxId: 'GSTIN',
    registrationId: 'PAN',
    placeOfSupply: 'Place of supply',
    hsnSac: 'HSN/SAC',
    outsideIndia: 'Outside India',
  };
  const gstInvoice = (overrides: Partial<InvoiceWithTax> = {}) =>
    invoice({
      currency: 'INR',
      placeOfSupply: '27',
      contactTaxNumber: '27AAPFU0939F1ZV',
      subtotal: '1000.00',
      taxTotal: '180.00',
      total: '1180.00',
      balanceDue: '1180.00',
      taxBreakdown: [
        row({ taxRateName: 'CGST 9%', taxRate: 9, taxableAmount: 1000, taxAmount: 90, component: 'cgst' }),
        row({ taxRateName: 'SGST 9%', taxRate: 9, taxableAmount: 1000, taxAmount: 90, component: 'sgst' }),
      ],
      items: [
        { ...invoice().items[0], unitPrice: '1000.00', taxRate: '18.0000', taxAmount: '180.00', lineTotal: '1000.00', hsnSac: '998313' },
      ],
      ...overrides,
    } as Partial<InvoiceWithTax>);

  it('prints the supplier GSTIN and PAN, the buyer GSTIN, the place of supply and the HSN/SAC', async () => {
    const { drawn } = captureText();
    await generateInvoicePdf(gstInvoice(), inEntity, { labels: gstLabels });

    expect(drawn).toContain('TAX INVOICE');
    expect(drawn).toContain('GSTIN: 27AABCU9603R1ZN');
    expect(drawn).toContain('PAN: AABCU9603R');
    expect(drawn).toContain('GSTIN: 27AAPFU0939F1ZV');
    expect(drawn).toContain('Place of supply');
    expect(drawn).toContain('Maharashtra (27)');
    expect(drawn).toContain('HSN/SAC: 998313');
    // The slab is printed as the CGST and SGST rows the invoice stored.
    expect(drawn).toContain('CGST 9%');
    expect(drawn).toContain('SGST 9%');
  });

  it('names a supply outside India', async () => {
    const { drawn } = captureText();
    await generateInvoicePdf(gstInvoice({ placeOfSupply: '96' }), inEntity, { labels: gstLabels });
    expect(drawn).toContain('Outside India');
  });

  it('leaves GST lines off an invoice of another jurisdiction', async () => {
    const { drawn } = captureText();
    await generateInvoicePdf(gstInvoice({ taxBreakdown: null }), nlEntity, { labels });
    expect(drawn.some((text) => text.startsWith('HSN/SAC') || text === 'Place of supply')).toBe(false);
  });
});

describe('generateInvoicePdf: US', () => {
  it('prints the tax per jurisdiction on US Letter', async () => {
    const { drawn } = captureText();
    const bytes = await generateInvoicePdf(invoice({ taxBreakdown: usRows }), usEntity, { labels });

    expect(drawn).toContain('Sales tax – Texas 6.25%');
    expect(drawn).toContain('Sales tax – Austin 2%');
    expect(drawn.some((text) => text.startsWith('Exempt sale'))).toBe(false);

    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
  });

  it('prints the exempt notice with the certificate number when a certificate exempts the sale', async () => {
    const exempt = [
      row({
        lineId: 'ili_1',
        jurisdictionCode: 'TX',
        jurisdictionName: 'Texas',
        jurisdictionLevel: 'state',
        taxRate: 6.25,
        taxableAmount: 0,
        taxAmount: 0,
        exemptAmount: 100,
        exemptReason: 'resale',
        certificateId: 'cert_1',
      }),
    ];
    const { drawn } = captureText();
    await generateInvoicePdf(invoice({ taxBreakdown: exempt, taxTotal: '0.00', total: '100.00' }), usEntity, {
      labels,
      certificateNumbers: ['A-123'],
    });

    expect(drawn).toContain('Exempt sale: Resale. Certificate no. A-123.');
  });

  it('prints a credit memo under its own title', async () => {
    const { drawn } = captureText();
    await generateInvoicePdf(invoice({ type: 'credit_note', taxBreakdown: usRows }), usEntity, { labels });
    expect(drawn).toContain('CREDIT MEMO');
    expect(drawn).not.toContain('INVOICE');
  });
});

describe('generateInvoicePdf: Dutch', () => {
  const vat = [
    row({ taxRateName: 'BTW 21%', taxRate: 21, taxableAmount: 100, taxAmount: 21 }),
    row({ taxRateName: 'BTW 9%', taxRate: 9, taxableAmount: 50, taxAmount: 4.5 }),
  ];

  it('keeps the VAT rows, on A4, with no sales tax wording', async () => {
    const { drawn } = captureText();
    const bytes = await generateInvoicePdf(
      invoice({ currency: 'EUR', taxBreakdown: vat, taxTotal: '25.50', total: '175.50' }),
      nlEntity,
      { labels: { ...labels, tax: 'BTW', taxId: 'BTW-nummer' } },
    );

    expect(drawn).toContain('BTW 21%');
    expect(drawn).toContain('BTW 9%');
    expect(drawn.some((text) => text.includes('–') || text.startsWith('Exempt'))).toBe(false);

    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPage(0).getSize().width).toBeCloseTo(595.28, 1);
  });
});
