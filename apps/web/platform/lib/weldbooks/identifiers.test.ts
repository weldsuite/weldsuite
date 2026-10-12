import { describe, expect, it } from 'vitest';
import { checkVatNumberFormat, ibanProblem, isValidIban } from './identifiers';

describe('checkVatNumberFormat', () => {
  it('refuses a Belgian number that is too short, with or without spaces and dots', () => {
    expect(checkVatNumberFormat('BE0123').valid).toBe(false);
    expect(checkVatNumberFormat('be 0123').valid).toBe(false);
    expect(checkVatNumberFormat('BE0123', 'BE')).toMatchObject({ valid: false, prefix: 'BE', example: 'BE0123456789' });
  });

  it('accepts well-formed numbers and returns them compact', () => {
    expect(checkVatNumberFormat('BE 0123.456.789')).toMatchObject({ valid: true, formatted: 'BE0123456789' });
    expect(checkVatNumberFormat('nl123456789b01')).toMatchObject({ valid: true, formatted: 'NL123456789B01' });
    expect(checkVatNumberFormat('DE 123 456 789')).toMatchObject({ valid: true, formatted: 'DE123456789' });
    expect(checkVatNumberFormat('FR12345678901').valid).toBe(true);
    expect(checkVatNumberFormat('ATU12345678').valid).toBe(true);
    expect(checkVatNumberFormat('EL123456789').valid).toBe(true);
  });

  it('refuses numbers of the wrong shape per country', () => {
    expect(checkVatNumberFormat('NL123456789').valid).toBe(false); // no B suffix
    expect(checkVatNumberFormat('DE12345678').valid).toBe(false); // 8 digits
    expect(checkVatNumberFormat('BE2123456789').valid).toBe(false); // starts with 2
    expect(checkVatNumberFormat('IT1234567890').valid).toBe(false); // 10 digits
  });

  it("reads a number without a prefix with the contact's country", () => {
    expect(checkVatNumberFormat('0123456789', 'BE')).toMatchObject({ valid: true, formatted: 'BE0123456789' });
    expect(checkVatNumberFormat('0123', 'BE').valid).toBe(false);
    expect(checkVatNumberFormat('123456789', 'GR')).toMatchObject({ valid: true, formatted: 'EL123456789' });
    expect(checkVatNumberFormat('GR123456789', 'GR')).toMatchObject({ valid: true, formatted: 'EL123456789' });
  });

  it('leaves values without an EU prefix on contacts of other countries alone', () => {
    expect(checkVatNumberFormat('12-3456789', 'US')).toMatchObject({ valid: true, prefix: null });
    expect(checkVatNumberFormat('22AAAAA0000A1Z5', 'IN')).toMatchObject({ valid: true, prefix: null });
    expect(checkVatNumberFormat('CHE-123.456.789 MWST', 'CH')).toMatchObject({ valid: true, prefix: null });
    expect(checkVatNumberFormat('', 'BE').valid).toBe(true);
  });
});

describe('IBAN', () => {
  it('accepts real IBANs, spaced or not, in any case', () => {
    expect(isValidIban('NL91ABNA0417164300')).toBe(true);
    expect(isValidIban('nl91 abna 0417 1643 00')).toBe(true);
    expect(isValidIban('BE68 5390 0754 7034')).toBe(true);
    expect(isValidIban('DE89370400440532013000')).toBe(true);
    expect(isValidIban('GB29NWBK60161331926819')).toBe(true);
  });

  it('refuses NL00 BANK 1234 and other nonsense', () => {
    expect(ibanProblem('NL00 BANK 1234')).toBe('format');
    expect(isValidIban('NL00BANK1234567890')).toBe(false);
    expect(ibanProblem('')).toBe('format');
  });

  it('refuses a wrong length for the country even when the check digits fit the characters', () => {
    // A Dutch IBAN is 18 characters; this one is 19.
    expect(ibanProblem('NL91ABNA04171643000')).toBe('country_length');
    expect(ibanProblem('BE685390075470341')).toBe('country_length');
  });

  it('refuses wrong check digits', () => {
    expect(ibanProblem('NL92ABNA0417164300')).toBe('checksum');
    expect(ibanProblem('DE89370400440532013001')).toBe('checksum');
  });
});
