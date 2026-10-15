import { describe, expect, it } from 'vitest';
import { toPostalAddressFormValue } from '@/components/address/postal-address';
import { buildBillPayload } from '@/app/weldbooks/bills/components/bill-payload';
import { buildRecurringPayload } from '@/app/weldbooks/recurring/components/recurring-payload';
import { EMPTY_BR_DOCUMENT, EMPTY_BR_LINE } from '@/lib/weldbooks/br-fiscal';
import { buildInvoicePayload, type InvoiceFormShape } from './invoice-payload';

const address = toPostalAddressFormValue({ line1: 'Rua das Flores, 123', city: 'São Paulo', state: 'SP', postalCode: '01310-100', country: 'BR', county: 'Bela Vista' });

const form: InvoiceFormShape = {
  contactId: 'con_1',
  issueDate: '2026-10-01',
  dueDate: '2026-10-31',
  billingAddress: address,
  shipToDifferent: false,
  shippingAddress: toPostalAddressFormValue(null),
  ...EMPTY_BR_DOCUMENT,
  brIrrf: '1.5',
  brCsrf: true,
  items: [
    { description: 'Consultoria', quantity: 1, unitPrice: 1000, taxRateId: 'tr_1', ...EMPTY_BR_LINE, cfop: '5933', brServiceCode: '01.07' },
    { description: 'Notebook', quantity: 2, unitPrice: 3000, taxRateId: 'tr_2', ...EMPTY_BR_LINE, ncm: '84713012', cfop: '5102', brOrigin: '0', brIcmsRate: '18' },
  ],
};

describe('invoice payload of a Brazilian entity', () => {
  it('sends NCM, CFOP and fiscal data per line and the withholdings per invoice', () => {
    const payload = buildInvoicePayload(form, { mode: 'add', kind: 'invoice', salesTax: false, br: true });
    expect(payload.fiscalData).toEqual({ withholdings: { irrf: 1.5, csrf: true } });
    const items = payload.items as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ ncm: null, cfop: '5933', fiscalData: { serviceCode: '01.07' }, taxRateId: 'tr_1' });
    expect(items[1]).toMatchObject({ ncm: '84713012', cfop: '5102', fiscalData: { origin: '0', icmsRate: 18 } });
  });

  it('keeps the neighbourhood of the address for the NF-e', () => {
    const payload = buildInvoicePayload(form, { mode: 'add', kind: 'invoice', salesTax: false, br: true });
    expect(payload.billingAddress).toMatchObject({ county: 'Bela Vista', state: 'SP', country: 'BR' });
  });

  it('clears a stored fiscalData on edit when nothing is set, and sends none on add', () => {
    const plain = { ...form, ...EMPTY_BR_DOCUMENT };
    expect(buildInvoicePayload(plain, { mode: 'edit', kind: 'invoice', salesTax: false, br: true }).fiscalData).toBeNull();
    expect('fiscalData' in buildInvoicePayload(plain, { mode: 'add', kind: 'invoice', salesTax: false, br: true })).toBe(false);
  });

  it('sends no Brazilian fields for other jurisdictions', () => {
    const payload = buildInvoicePayload(form, { mode: 'add', kind: 'invoice', salesTax: false });
    expect('fiscalData' in payload).toBe(false);
    expect('ncm' in (payload.items as Array<Record<string, unknown>>)[0]).toBe(false);
  });
});

describe('bill and recurring payloads of a Brazilian entity', () => {
  it('sends the supplier access key and the line fiscal fields of a bill', () => {
    const key = '4'.repeat(44);
    const payload = buildBillPayload(
      {
        contactId: 'sup_1',
        issueDate: '2026-10-01',
        dueDate: '2026-10-31',
        vendorAddress: address,
        ...EMPTY_BR_DOCUMENT,
        brAccessKey: key,
        items: [{ description: 'Peças', quantity: 1, unitPrice: 100, taxRateId: 'tr_9', ...EMPTY_BR_LINE, ncm: '87089990', cfop: '1102' }],
      },
      { mode: 'add', salesTax: false, form1099: false, br: true },
    );
    expect(payload.fiscalData).toEqual({ accessKey: key });
    expect(payload.items[0]).toMatchObject({ ncm: '87089990', cfop: '1102' });
  });

  it('keeps the withholdings and line fiscal fields in the recurring template', () => {
    const payload = buildRecurringPayload(
      {
        contactId: 'con_1',
        frequency: 'monthly',
        nextIssueDate: '2026-11-01',
        autoFinalize: false,
        autoSend: false,
        ...EMPTY_BR_DOCUMENT,
        brIssWithheld: '2',
        items: [{ description: 'Suporte', quantity: 1, unitPrice: 500, taxRateId: 'tr_1', ...EMPTY_BR_LINE, brServiceCode: '01.07' }],
      },
      { mode: 'add', salesTax: false, br: true },
    );
    const template = payload.templateData as { fiscalData: unknown; items: Array<Record<string, unknown>> };
    expect(template.fiscalData).toEqual({ withholdings: { iss: 2 } });
    expect(template.items[0]).toMatchObject({ fiscalData: { serviceCode: '01.07' } });
  });
});
