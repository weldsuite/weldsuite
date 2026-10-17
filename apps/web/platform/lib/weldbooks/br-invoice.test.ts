// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { BR_NOTICE_MEI, BR_NOTICE_NOT_FISCAL, BR_NOTICE_SIMPLES, brComplianceNotices, brPixFor } from './br-invoice';
import { brLineCodes, brTotalsOf, generateInvoicePdf, type InvoicePdfLabels } from './invoice-pdf';
import { buildPixPayload } from './pix';

const entity = {
  name: 'Weld',
  legalName: 'Weld Tecnologia Ltda',
  baseCurrency: 'BRL',
  taxClassification: 'simples_nacional',
  jurisdictionSettings: { pixKey: '11222333000181', pixCity: 'Curitiba' },
};
const invoice = {
  id: 'inv_1',
  invoiceNumber: 'FT0001',
  type: 'invoice',
  status: 'sent',
  currency: 'BRL',
  balanceDue: '150.00',
  total: '150.00',
};

describe('brPixFor', () => {
  it('builds the BR Code for the amount still due', () => {
    const pix = brPixFor(invoice, entity);
    expect(pix?.key).toBe('11222333000181');
    expect(pix?.amount).toBe(150);
    expect(pix?.payload.startsWith('000201')).toBe(true);
    expect(pix?.payload).toContain('5406150.00');
    expect(pix?.payload).toBe(
      buildPixPayload({ key: '11222333000181', merchantName: 'Weld Tecnologia Ltda', merchantCity: 'Curitiba', amount: 150, txid: 'FT0001' }),
    );
  });

  it('is absent without a key, for a paid, draft or foreign-currency invoice and a credit note', () => {
    expect(brPixFor(invoice, { ...entity, jurisdictionSettings: {} })).toBeNull();
    expect(brPixFor({ ...invoice, balanceDue: '0.00' }, entity)).toBeNull();
    expect(brPixFor({ ...invoice, status: 'draft' }, entity)).toBeNull();
    expect(brPixFor({ ...invoice, currency: 'USD' }, entity)).toBeNull();
    expect(brPixFor({ ...invoice, type: 'credit_note' }, entity)).toBeNull();
    expect(brPixFor(invoice, null)).toBeNull();
  });
});

describe('brComplianceNotices', () => {
  it('prints the regime statement and that the invoice is not the NF-e', () => {
    expect(brComplianceNotices(entity)).toEqual([BR_NOTICE_SIMPLES, BR_NOTICE_NOT_FISCAL]);
    expect(brComplianceNotices({ ...entity, taxClassification: 'mei' })).toEqual([BR_NOTICE_MEI, BR_NOTICE_NOT_FISCAL]);
    expect(brComplianceNotices({ ...entity, taxClassification: 'lucro_real' })).toEqual([BR_NOTICE_NOT_FISCAL]);
  });
});

describe('Brazilian invoice PDF', () => {
  const labels: InvoicePdfLabels = {
    invoice: 'FATURA',
    from: 'EMITENTE',
    billTo: 'DESTINATARIO',
    shipTo: 'ENTREGA',
    issueDate: 'EMISSAO',
    dueDate: 'VENCIMENTO',
    reference: 'REFERENCIA',
    description: 'DESCRICAO',
    quantity: 'QTD',
    unitPrice: 'UNITARIO',
    tax: 'Tributos',
    amount: 'VALOR',
    subtotal: 'Subtotal',
    total: 'Total',
    paid: 'Pago',
    balanceDue: 'Saldo',
    continued: '{number} (continuacao)',
    page: 'Pagina {page} de {total}',
    bank: 'Banco',
    iban: 'IBAN',
    bic: 'BIC',
    accountNumber: 'Conta',
    routingNumber: 'Agencia',
    taxId: 'CNPJ',
    registrationId: 'IE',
    br: {
      ncm: 'NCM',
      cfop: 'CFOP',
      includedTaxes: 'Tributos incluidos no preco',
      withholdings: 'Retencoes',
      informationalTaxes: 'CBS/IBS',
      netAmount: 'Valor liquido',
      pixPayment: 'Pague com Pix',
      fiscalDocument: 'Documento fiscal',
      accessKey: 'Chave de acesso',
      fiscalDocumentNumber: 'no. {number}',
    },
  };

  const brInvoice = {
    id: 'inv_1',
    invoiceNumber: 'FT0001',
    type: 'invoice',
    status: 'sent',
    currency: 'BRL',
    issueDate: '2026-10-01',
    dueDate: '2026-10-31',
    subtotal: '1000.00',
    taxTotal: '-15.00',
    total: '985.00',
    balanceDue: '985.00',
    amountPaid: '0',
    items: [{ id: 'l1', description: 'Consultoria', quantity: '1', unitPrice: '1000.00', lineTotal: '1000.00', ncm: '84713012', cfop: '5933' }],
    taxBreakdown: [
      { taxRateName: 'ISS 2%', taxRate: 2, taxableAmount: 1000, taxAmount: 20, component: 'iss', treatment: 'embedded' },
      { taxRateName: 'IRRF 1.5%', taxRate: 1.5, taxableAmount: 1000, taxAmount: 15, component: 'irrf', treatment: 'withheld' },
    ],
  } as unknown as InvoiceWithTax;

  it('lists withholdings apart from the taxes inside the price', () => {
    expect(brTotalsOf(brInvoice)).toEqual({
      added: [],
      withheld: [{ label: 'IRRF 1.5%', amount: -15 }],
      embedded: [{ label: 'ISS 2%', amount: 20 }],
      informational: [],
    });
    expect(brLineCodes({ ncm: '84713012', cfop: '5933' }, labels)).toBe('NCM: 84713012 · CFOP: 5933');
    expect(brLineCodes({}, labels)).toBeNull();
  });

  it('renders a PDF with the Pix QR, the fiscal document and the notices', async () => {
    const pix = brPixFor(brInvoice as never, entity);
    const bytes = await generateInvoicePdf(
      brInvoice,
      { name: 'Weld', jurisdictionCode: 'BR', baseCurrency: 'BRL', locale: 'pt-BR' },
      {
        labels,
        br: {
          pix,
          fiscalDocument: { label: 'NFS-e', number: '42', accessKey: '3'.repeat(44) },
          notices: brComplianceNotices(entity),
        },
      },
    );
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(bytes.length).toBeGreaterThan(2000);
  });
});
