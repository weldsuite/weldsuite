import { describe, it, expect } from 'vitest';
import type { Entity } from '@weldsuite/db/schema';
import { missingEntityInvoiceFieldCodes } from './accounting-compliance';
import { getAdapter, listJurisdictions } from './jurisdictions/registry';

function entity(patch: Partial<Entity>): Entity {
  return { jurisdictionCode: 'NL', locale: 'nl-NL', ...patch } as Entity;
}

const nl = () => getAdapter('NL').getInvoiceRequirements('nl-NL');

describe('missingEntityInvoiceFieldCodes', () => {
  it('lists the Dutch fields an empty entity lacks, as codes', () => {
    expect(missingEntityInvoiceFieldCodes(entity({}), nl())).toEqual([
      'vatNumber',
      'registrationNumber',
      'iban',
      'address',
    ]);
  });

  it('is empty once the identifiers, IBAN and address are filled in', () => {
    const complete = entity({
      taxIdentifiers: { vatNumber: 'NL123456789B01', registrationNumber: '12345678' },
      bankDetails: { iban: 'NL91ABNA0417164300' },
      address: { line1: 'Damrak 1', city: 'Amsterdam' },
    });
    expect(missingEntityInvoiceFieldCodes(complete, nl())).toEqual([]);
  });

  it('asks a US entity for its address only', () => {
    const us = getAdapter('US').getInvoiceRequirements('en-US');
    expect(missingEntityInvoiceFieldCodes(entity({ jurisdictionCode: 'US' }), us)).toEqual(['address']);
  });
});

describe('listJurisdictions', () => {
  it('carries the invoice-required entity fields of each jurisdiction', () => {
    const byCode = Object.fromEntries(listJurisdictions().map((j) => [j.code, j.invoiceRequiredFields]));
    expect(byCode.NL).toEqual(['vatNumber', 'registrationNumber', 'iban', 'address']);
    expect(byCode.US).toEqual(['address']);
    expect(byCode.BR).toEqual(['vatNumber', 'address']);
  });
});
