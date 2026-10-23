import { ApiError } from '@weldsuite/api-client/client';

import {
  btwProblem,
  fiscalYearStartLabel,
  formatIbanInput,
  hasInvoiceAddress,
  ibanProblem,
  kvkProblem,
  missingFieldsFromError,
  missingInvoiceFields,
  requiredInvoiceFields,
} from '@/lib/company';
import { isoToPickerDate, toDateInput } from '@/lib/date';
import type { Jurisdiction } from '@/types/accounting';

describe('requiredInvoiceFields', () => {
  it('asks a Dutch company for BTW, KvK, IBAN and an address', () => {
    expect(requiredInvoiceFields('NL')).toEqual(['vatNumber', 'registrationNumber', 'iban', 'address']);
  });

  it('asks every company for an address, even where nothing else is required', () => {
    expect(requiredInvoiceFields('US')).toEqual(['address']);
    expect(requiredInvoiceFields('BR')).toEqual(['vatNumber', 'address']);
    expect(requiredInvoiceFields(null)).toEqual(['address']);
    expect(requiredInvoiceFields('XX')).toEqual(['address']);
  });

  it("prefers the API's list over the built-in one and keeps the address in it", () => {
    const loaded = [{ code: 'NL', invoiceRequiredFields: ['vatNumber', 'bogus'] }] as unknown as Jurisdiction[];
    expect(requiredInvoiceFields('nl', loaded)).toEqual(['vatNumber', 'address']);
  });

  it('falls back to the built-in list when the API does not send one', () => {
    const loaded = [{ code: 'NL' }] as unknown as Jurisdiction[];
    expect(requiredInvoiceFields('NL', loaded)).toEqual(['vatNumber', 'registrationNumber', 'iban', 'address']);
  });
});

describe('missingInvoiceFields', () => {
  const required = requiredInvoiceFields('NL');

  it('lists everything for a company with no details', () => {
    expect(missingInvoiceFields({}, required)).toEqual(required);
    expect(missingInvoiceFields(null, required)).toEqual(required);
  });

  it('is empty once the details are there', () => {
    expect(
      missingInvoiceFields(
        {
          vatNumber: 'NL123456789B01',
          registrationNumber: '12345678',
          iban: 'NL91ABNA0417164300',
          address: { line1: 'Damrak 1', city: 'Amsterdam' },
        },
        required,
      ),
    ).toEqual([]);
  });

  it('treats blank text and an address without a street or city as missing', () => {
    expect(
      missingInvoiceFields(
        { vatNumber: '  ', registrationNumber: '12345678', iban: 'NL91', address: { city: 'Amsterdam' } },
        required,
      ),
    ).toEqual(['vatNumber', 'address']);
  });
});

describe('hasInvoiceAddress', () => {
  it('needs a street line and a city', () => {
    expect(hasInvoiceAddress({ line1: 'Damrak 1', city: 'Amsterdam' })).toBe(true);
    expect(hasInvoiceAddress({ line1: 'Damrak 1' })).toBe(false);
    expect(hasInvoiceAddress(null)).toBe(false);
  });
});

describe('missingFieldsFromError', () => {
  const refusal = (details: unknown) =>
    new ApiError('Entity is missing legally required invoice fields', 400, {
      error: { code: 'BAD_REQUEST', message: 'x', details },
    });

  it('reads the structured fields books-api sends', () => {
    expect(
      missingFieldsFromError(
        refusal({ code: 'ENTITY_INVOICE_FIELDS_MISSING', missingFields: ['vatNumber', 'iban', 'nonsense'] }),
      ),
    ).toEqual(['vatNumber', 'iban']);
  });

  it('is empty for any other error, or an older API without details', () => {
    expect(missingFieldsFromError(refusal(undefined))).toEqual([]);
    expect(missingFieldsFromError(new Error('boom'))).toEqual([]);
    expect(missingFieldsFromError(null)).toEqual([]);
  });
});

describe('identifier checks', () => {
  it('accepts a real IBAN and rejects a wrong check digit or shape', () => {
    expect(ibanProblem('NL91 ABNA 0417 1643 00')).toBeNull();
    expect(ibanProblem('NL92 ABNA 0417 1643 00')).toBe('checksum');
    expect(ibanProblem('12345')).toBe('format');
  });

  it('groups an IBAN by four while typing', () => {
    expect(formatIbanInput('nl91abna0417164300')).toBe('NL91 ABNA 0417 1643 00');
  });

  it('checks the Dutch BTW and KvK formats', () => {
    expect(btwProblem('NL123456789B01')).toBeNull();
    expect(btwProblem('nl 123456789 b01')).toBeNull();
    expect(btwProblem('123456789')).toBe('format');
    expect(kvkProblem('12345678')).toBeNull();
    expect(kvkProblem('1234567')).toBe('format');
  });
});

describe('fiscalYearStartLabel', () => {
  it('shows the month name in the locale instead of the number', () => {
    expect(fiscalYearStartLabel(1, 'en-GB')).toBe('1 January');
    expect(fiscalYearStartLabel('4', 'nl-NL')).toBe('1 april');
    expect(fiscalYearStartLabel(7, 'en-US')).toBe('July 1');
  });

  it('is null when there is no value and passes an unknown one through', () => {
    expect(fiscalYearStartLabel(null, 'en-GB')).toBeNull();
    expect(fiscalYearStartLabel('', 'en-GB')).toBeNull();
    expect(fiscalYearStartLabel('13', 'en-GB')).toBe('13');
  });
});

describe('isoToPickerDate', () => {
  it('starts the picker on the same calendar day, whatever the time zone', () => {
    const picked = isoToPickerDate('2026-03-31');
    expect(toDateInput(picked)).toBe('2026-03-31');
  });

  it('falls back to today for text that is not a date', () => {
    expect(toDateInput(isoToPickerDate(''))).toBe(toDateInput(new Date()));
  });
});
