import { describe, expect, it } from 'vitest';
import * as domain from '../../../../../packages/domains/books/src/jurisdictions/br/regimes';
import {
  BR_ENTITY_TYPES,
  BR_TAX_REGIMES,
  DEFAULT_BR_VALUES,
  allowedBrRegimes,
  brEntityErrors,
  brEntityPayload,
  brValuesFromEntity,
  contactTaxIdError,
  defaultBrRegime,
  timezoneOfUf,
  validBrRegime,
} from './br-entity';

describe('br-entity mirror of the books domain', () => {
  it('lists the same regimes and legal forms', () => {
    expect([...BR_TAX_REGIMES]).toEqual([...domain.BR_TAX_REGIMES]);
    expect([...BR_ENTITY_TYPES]).toEqual([...domain.BR_ENTITY_TYPES]);
  });

  it('allows the same regimes per legal form', () => {
    for (const type of [...BR_ENTITY_TYPES, null, undefined]) {
      expect(allowedBrRegimes(type)).toEqual(domain.allowedBrRegimes(type as domain.BrEntityType | null | undefined));
    }
  });

  it('has the same time zone per state', () => {
    for (const uf of ['SP', 'AC', 'AM', 'MT', 'BA', 'PE', 'XX']) expect(timezoneOfUf(uf)).toBe(domain.timezoneOfUf(uf));
  });
});

describe('regimes', () => {
  it('starts a MEI in the SIMEI and an S.A. in Lucro Presumido', () => {
    expect(defaultBrRegime('mei')).toBe('mei');
    expect(defaultBrRegime('sa')).toBe('lucro_presumido');
    expect(defaultBrRegime('ltda')).toBe('simples_nacional');
  });

  it('keeps an allowed regime and replaces one the legal form cannot have', () => {
    expect(validBrRegime('ltda', 'lucro_real')).toBe('lucro_real');
    expect(validBrRegime('sa', 'simples_nacional')).toBe('lucro_presumido');
    expect(validBrRegime('ltda', undefined)).toBe('simples_nacional');
  });
});

describe('brEntityErrors', () => {
  const ok = { ...DEFAULT_BR_VALUES, uf: 'SP', municipalityCode: '3550308', cnae: '6201501', issRate: '2', pixKey: 'a@b.com' };

  it('accepts an empty setup and a well formed one', () => {
    expect(brEntityErrors(DEFAULT_BR_VALUES, { entityType: 'ltda', cnpj: '', ie: '' })).toEqual({});
    expect(brEntityErrors(ok, { entityType: 'ltda', cnpj: '11.222.333/0001-81', ie: 'ISENTO' })).toEqual({});
  });

  it('flags a wrong CNPJ, IE, municipality, CNAE, ISS rate and Pix key', () => {
    const errors = brEntityErrors(
      { ...ok, municipalityCode: '3350308', cnae: '12', issRate: '9', pixKey: 'nope', nfeSeries: '1234' },
      { entityType: 'ltda', cnpj: '11.222.333/0001-82', ie: 'A1' },
    );
    expect(errors).toMatchObject({
      cnpj: 'cnpjChecksum',
      ie: 'ie',
      municipalityCode: 'municipalityUf',
      cnae: 'cnae',
      issRate: 'issRate',
      pixKey: 'pixKey',
      nfeSeries: 'nfeSeries',
    });
  });

  it('flags a regime the legal form cannot have', () => {
    expect(brEntityErrors({ ...DEFAULT_BR_VALUES, regime: 'simples_nacional' }, { entityType: 'sa' }).regime).toBe('regime');
  });
});

describe('payload', () => {
  it('sends the filled settings, empty ones as null (cleared), and the formatted identifiers', () => {
    const payload = brEntityPayload(
      { ...DEFAULT_BR_VALUES, regime: 'lucro_presumido', uf: 'sp', issRate: '2,5', pixKey: ' a@b.com ', cnae: '' },
      { cnpj: '11222333000181', ie: 'isento' },
    );
    expect(payload).toMatchObject({
      taxClassification: 'lucro_presumido',
      jurisdictionSettings: { icmsContributor: false, nfseStandard: 'nacional', uf: 'SP', issRate: 2.5, pixKey: 'a@b.com', cnae: null, cbsRate: null },
      taxIdentifiers: { vatNumber: '11.222.333/0001-81', registrationNumber: 'ISENTO' },
    });
  });

  it('reads a stored entity back into the form', () => {
    const values = brValuesFromEntity({
      entityType: 'ltda',
      taxClassification: 'lucro_real',
      jurisdictionSettings: { uf: 'RJ', issRate: 3, simplesAnexo: 'III', icmsContributor: true, nfseStandard: 'municipal', payroll12m: 1000 },
    });
    expect(values).toMatchObject({ regime: 'lucro_real', uf: 'RJ', issRate: '3', simplesAnexo: 'III', icmsContributor: true, nfseStandard: 'municipal', payroll12m: '1000' });
  });
});

describe('contactTaxIdError', () => {
  it('accepts a CNPJ or a CPF and names what is wrong otherwise', () => {
    expect(contactTaxIdError('')).toBeNull();
    expect(contactTaxIdError('11.222.333/0001-81')).toBeNull();
    expect(contactTaxIdError('529.982.247-25')).toBeNull();
    expect(contactTaxIdError('529.982.247-24')).toBe('cpfChecksum');
    expect(contactTaxIdError('11.222.333/0001-82')).toBe('cnpjChecksum');
    expect(contactTaxIdError('123')).toBe('cnpj');
  });
});
