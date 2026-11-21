import { describe, expect, it } from 'vitest';
import type { ProductSupplier } from '@weldsuite/app-api-client/schemas/product-suppliers';
import {
  EMPTY_PRODUCT_SUPPLIER_FORM,
  formToCreateInput,
  formToUpdateInput,
  makeProductSupplierFormSchema,
  productSupplierToForm,
} from './product-supplier-form';

const row: ProductSupplier = {
  id: 'ps1',
  productId: 'p1',
  variantId: null,
  supplierId: 's1',
  supplierSku: 'ACME-1',
  supplierProductName: null,
  unitCost: '12.5000',
  currency: 'EUR',
  leadTimeDays: 21,
  minOrderQty: 50,
  orderMultiple: 10,
  isPreferred: true,
  createdAt: '',
  updatedAt: '',
  supplierName: 'Acme',
  supplierCode: null,
  supplierCurrency: 'EUR',
  supplierLeadTimeDays: 14,
  productName: 'Widget',
  productSku: 'W-1',
};

describe('formToCreateInput', () => {
  it('needs a supplier', () => {
    expect(formToCreateInput(EMPTY_PRODUCT_SUPPLIER_FORM, { productId: 'p1' })).toEqual({ ok: false, errors: { supplierId: 'required' } });
  });

  it('leaves out empty optional fields and keeps the multiple', () => {
    const result = formToCreateInput({ ...EMPTY_PRODUCT_SUPPLIER_FORM, supplierId: 's1' }, { productId: 'p1' });
    expect(result).toEqual({ ok: true, input: { productId: 'p1', supplierId: 's1', orderMultiple: 1, isPreferred: false } });
  });

  it('parses the terms, with a decimal comma and a lowercase currency', () => {
    const result = formToCreateInput(
      { ...EMPTY_PRODUCT_SUPPLIER_FORM, supplierId: 's1', unitCost: '12,5', currency: 'eur', leadTimeDays: '21', minOrderQty: '50', orderMultiple: '10', supplierSku: ' A-1 ', isPreferred: true },
      { productId: 'p1', variantId: 'v1' },
    );
    expect(result).toEqual({
      ok: true,
      input: { productId: 'p1', variantId: 'v1', supplierId: 's1', supplierSku: 'A-1', unitCost: 12.5, currency: 'EUR', leadTimeDays: 21, minOrderQty: 50, orderMultiple: 10, isPreferred: true },
    });
  });

  it('refuses bad numbers and currency codes', () => {
    const base = { ...EMPTY_PRODUCT_SUPPLIER_FORM, supplierId: 's1' };
    expect(formToCreateInput({ ...base, unitCost: '-1' }, { productId: 'p1' })).toEqual({ ok: false, errors: { unitCost: 'invalid' } });
    expect(formToCreateInput({ ...base, leadTimeDays: '400' }, { productId: 'p1' })).toEqual({ ok: false, errors: { leadTimeDays: 'invalid' } });
    expect(formToCreateInput({ ...base, minOrderQty: '0' }, { productId: 'p1' })).toEqual({ ok: false, errors: { minOrderQty: 'invalid' } });
    expect(formToCreateInput({ ...base, orderMultiple: '1.5' }, { productId: 'p1' })).toEqual({ ok: false, errors: { orderMultiple: 'invalid' } });
    expect(formToCreateInput({ ...base, currency: 'EURO' }, { productId: 'p1' })).toEqual({ ok: false, errors: { currency: 'invalid' } });
  });
});

describe('formToUpdateInput', () => {
  it('round-trips a row and sends emptied fields as null so they clear', () => {
    const form = productSupplierToForm(row);
    expect(form).toMatchObject({ unitCost: '12.5', leadTimeDays: '21', minOrderQty: '50', orderMultiple: '10', isPreferred: true });
    expect(formToUpdateInput({ ...form, leadTimeDays: '', supplierSku: '' })).toEqual({
      ok: true,
      input: {
        supplierSku: null,
        supplierProductName: null,
        unitCost: 12.5,
        currency: 'EUR',
        leadTimeDays: null,
        minOrderQty: 50,
        orderMultiple: 10,
        isPreferred: true,
      },
    });
  });
});

describe('makeProductSupplierFormSchema', () => {
  it('puts messages on the fields the API would refuse', () => {
    const schema = makeProductSupplierFormSchema({ required: 'Required', invalid: 'Invalid' }, { kind: 'create', productId: 'p1' });
    const result = schema.safeParse({ ...EMPTY_PRODUCT_SUPPLIER_FORM, unitCost: 'x' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => [i.path[0], i.message])).toEqual(
        expect.arrayContaining([['supplierId', 'Required'], ['unitCost', 'Invalid']]),
      );
    }
  });
});
