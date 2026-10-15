import { describe, expect, it } from 'vitest';
import {
  brTaxIdKind,
  brTaxIdProblem,
  checkVatNumberFormat,
  cnpjCheckDigits,
  cnpjProblem,
  cpfProblem,
  formatCnpj,
  formatCpf,
  ibanProblem,
  isValidCnpj,
  isValidCpf,
  isValidIban,
  isValidInscricaoEstadual,
  isValidMunicipalityCode,
  normalizeCep,
} from './identifiers';

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

describe('Brazil identifiers', () => {
  it('validates a numeric CNPJ with or without its mask', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(cnpjProblem('11.222.333/0001-82')).toBe('checksum');
    expect(cnpjProblem('1122233300018')).toBe('format');
    expect(cnpjProblem('00000000000000')).toBe('format');
  });

  it('validates an alphanumeric CNPJ (letters count ASCII minus 48)', () => {
    const base = '12ABC34501DE';
    const check = cnpjCheckDigits(base);
    expect(isValidCnpj(`${base}${check}`)).toBe(true);
    expect(isValidCnpj(`12.ABC.345/01DE-${check}`)).toBe(true);
    expect(cnpjProblem(`${base}${check === '00' ? '01' : '00'}`)).toBe('checksum');
  });

  it('validates a CPF', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('52998224725')).toBe(true);
    expect(cpfProblem('529.982.247-24')).toBe('checksum');
    expect(cpfProblem('111.111.111-11')).toBe('format');
    expect(cpfProblem('123')).toBe('format');
  });

  it('tells a CPF from a CNPJ by length', () => {
    expect(brTaxIdKind('529.982.247-25')).toBe('cpf');
    expect(brTaxIdKind('11.222.333/0001-81')).toBe('cnpj');
    expect(brTaxIdProblem('529.982.247-25')).toBeNull();
    expect(brTaxIdProblem('11.222.333/0001-81')).toBeNull();
  });

  it('formats masks', () => {
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81');
    expect(formatCpf('52998224725')).toBe('529.982.247-25');
  });

  it('checks the shape of an Inscrição Estadual, a CEP and an IBGE code', () => {
    expect(isValidInscricaoEstadual('ISENTO')).toBe(true);
    expect(isValidInscricaoEstadual('110.042.490.114')).toBe(true);
    expect(isValidInscricaoEstadual('A1')).toBe(false);
    expect(normalizeCep('01310100')).toBe('01310-100');
    expect(normalizeCep('0131')).toBeUndefined();
    expect(isValidMunicipalityCode('3550308')).toBe(true);
    expect(isValidMunicipalityCode('35503')).toBe(false);
  });
});
