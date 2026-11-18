import { describe, expect, it } from 'vitest';
import {
  missingFieldsFromError,
  missingInvoiceFields,
  requiredInvoiceFields,
} from './invoice-requirements';

describe('requiredInvoiceFields', () => {
  it('uses the built-in list (as books-api lists it) until the jurisdictions load', () => {
    expect(requiredInvoiceFields('NL')).toEqual(['vatNumber', 'registrationNumber', 'iban', 'address']);
    expect(requiredInvoiceFields('nl')).toEqual(['vatNumber', 'registrationNumber', 'iban', 'address']);
    expect(requiredInvoiceFields('US')).toEqual(['address']);
    expect(requiredInvoiceFields('BR')).toEqual(['vatNumber', 'address']);
  });

  it('asks for the address at least, also without a known jurisdiction', () => {
    expect(requiredInvoiceFields(null)).toEqual(['address']);
    expect(requiredInvoiceFields('XX')).toEqual(['address']);
  });

  it("follows the API's list and drops fields it doesn't know", () => {
    const loaded = [{ code: 'NL', invoiceRequiredFields: ['vatNumber', 'bogus'] }];
    expect(requiredInvoiceFields('NL', loaded)).toEqual(['vatNumber', 'address']);
  });

  it('falls back to the built-in list for an API without the field', () => {
    expect(requiredInvoiceFields('NL', [{ code: 'NL' }])).toEqual(['vatNumber', 'registrationNumber', 'iban', 'address']);
  });
});

describe('missingInvoiceFields', () => {
  const required = requiredInvoiceFields('NL');

  it('lists every field of an empty entity', () => {
    expect(missingInvoiceFields({}, required)).toEqual(required);
    expect(missingInvoiceFields(null, required)).toEqual(required);
  });

  it('treats blank values and an address without a city as missing', () => {
    expect(
      missingInvoiceFields(
        {
          taxIdentifiers: { vatNumber: 'NL123456789B01', registrationNumber: '  ' },
          bankDetails: { iban: 'NL91ABNA0417164300' },
          address: { line1: 'Hoofdweg 76' },
        },
        required,
      ),
    ).toEqual(['registrationNumber', 'address']);
  });

  it('reads the legacy street + city address shape', () => {
    expect(
      missingInvoiceFields(
        {
          taxIdentifiers: { vatNumber: 'NL123456789B01', registrationNumber: '12345678' },
          bankDetails: { iban: 'NL91ABNA0417164300' },
          address: { street: 'Hoofdweg', houseNumber: '76', city: 'Ede' },
        },
        required,
      ),
    ).toEqual([]);
  });
});

describe('missingFieldsFromError', () => {
  const refusal = (details: unknown) => ({ status: 400, body: { error: { code: 'BAD_REQUEST', details } } });

  it("reads the fields of books-api's refusal", () => {
    expect(
      missingFieldsFromError(refusal({ code: 'ENTITY_INVOICE_FIELDS_MISSING', missingFields: ['vatNumber', 'iban', 'nope'] })),
    ).toEqual(['vatNumber', 'iban']);
  });

  it('is empty for any other error', () => {
    expect(missingFieldsFromError(refusal({ code: 'OTHER', missingFields: ['iban'] }))).toEqual([]);
    expect(missingFieldsFromError(refusal(undefined))).toEqual([]);
    expect(missingFieldsFromError(new Error('boom'))).toEqual([]);
    expect(missingFieldsFromError(null)).toEqual([]);
  });
});
