import { describe, expect, it } from 'vitest';
import type { Entity } from '@weldsuite/db/schema';
import { generateTemplatedInvoiceHtml, invoiceTemplateData, type InvoiceRenderData } from '../accounting-invoice-html';
import { presetTemplate } from './presets';

function entity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: 'ent_test',
    name: 'Weld BV',
    legalName: 'Weld B.V.',
    jurisdictionCode: 'NL',
    baseCurrency: 'EUR',
    locale: 'nl-NL',
    address: { line1: 'Damrak 1', postalCode: '1012 LG', city: 'Amsterdam', country: 'NL' },
    taxIdentifiers: { vatNumber: 'NL123456789B01', registrationNumber: '12345678' },
    bankDetails: { iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' },
    branding: { footerText: 'Bedankt voor uw opdracht' },
    ...overrides,
  } as Entity;
}

function invoice(overrides: Partial<InvoiceRenderData> = {}): InvoiceRenderData {
  return {
    invoiceNumber: 'INV-0001',
    type: 'standard',
    issueDate: '2026-10-01T00:00:00.000Z',
    dueDate: '2026-10-31T00:00:00.000Z',
    currency: 'EUR',
    contactName: 'Acme Corp',
    items: [{ description: 'Consulting', quantity: '2', unitPrice: '100', taxRate: '21', lineTotal: '200', taxAmount: '42' }],
    subtotal: '200',
    discountTotal: '0',
    taxTotal: '42',
    total: '242',
    taxBreakdown: [{ taxRateName: 'BTW 21%', taxRate: 21, taxableAmount: 200, taxAmount: 42 }],
    ...overrides,
  };
}

describe('generateTemplatedInvoiceHtml', () => {
  it('prints the invoice in the template with the jurisdiction labels', () => {
    const html = generateTemplatedInvoiceHtml(presetTemplate('classic', 'a4'), invoice(), entity());
    expect(html).toContain('<title>Factuur INV-0001</title>');
    expect(html).toContain('INV-0001');
    expect(html).toContain('Acme Corp');
    expect(html).toContain('Bedankt voor uw opdracht');
    expect(html).toContain('NL123456789B01');
  });

  it('keeps the compliance notices and the buyer VAT number of a reverse-charge invoice', () => {
    const data = invoiceTemplateData(
      invoice({ complianceNotices: ['BTW verlegd'], contactVatNumber: 'DE123456789' }),
      entity(),
    );
    expect(data.legal.notices).toContain('BTW verlegd');
    expect(data.billTo.taxIdLines?.[0]).toContain('DE123456789');
    const template = presetTemplate('classic', 'a4');
    template.blocks = template.blocks.filter((b) => b.type !== 'legal');
    expect(generateTemplatedInvoiceHtml(template, invoice({ complianceNotices: ['BTW verlegd'] }), entity())).toContain('BTW verlegd');
  });

  it('splits an Indian intra-state line into CGST and SGST and requires the HSN/SAC column', () => {
    const data = invoiceTemplateData(
      invoice({
        currency: 'INR',
        items: [{ description: 'Design', quantity: '1', unitPrice: '1000', taxRate: '18', lineTotal: '1000', taxAmount: '180', hsnSac: '998391' }],
        taxBreakdown: [
          { taxRateName: 'CGST', taxRate: 9, taxableAmount: 1000, taxAmount: 90, component: 'cgst' },
          { taxRateName: 'SGST', taxRate: 9, taxableAmount: 1000, taxAmount: 90, component: 'sgst' },
        ],
      }),
      entity({ jurisdictionCode: 'IN', locale: 'en-IN', baseCurrency: 'INR', address: { line1: 'MG Road', city: 'Pune', country: 'IN' } } as Partial<Entity>),
    );
    expect(data.table.columns.hsnSac?.required).toBe(true);
    expect(data.table.rows[0].cells.taxRate).toBe('CGST 9%\nSGST 9%');
    expect(data.totals.map((r) => r.label)).toEqual(expect.arrayContaining(['CGST 9%', 'SGST 9%']));
  });

  it('marks a draft and escapes what the customer typed', () => {
    const html = generateTemplatedInvoiceHtml(
      presetTemplate('modern', 'a4'),
      invoice({ draft: true, contactName: '<img src=x onerror=alert(1)>', notes: '</svg><script>x</script>' }),
      entity(),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('fill-opacity="0.08"');
  });
});
