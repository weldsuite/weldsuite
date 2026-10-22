import {
  buildEntityUpdate,
  companyProblems,
  emptyCompanyDraft,
  invoiceFieldNames,
  isEmptyUpdate,
  listInvoiceFields,
  toCompanyDraft,
  toGenericAddress,
} from '@/lib/company-form';
import { en } from '@/lib/i18n/locales/en';
import { toAddressDraft } from '@/lib/us';
import { nl } from '@/lib/i18n/locales/nl';
import type { AccountingEntity } from '@/types/accounting';

const nlEntity: AccountingEntity = {
  id: 'ent_1',
  name: 'E2E Company BV',
  jurisdictionCode: 'NL',
  baseCurrency: 'EUR',
};

const usEntity: AccountingEntity = {
  id: 'ent_2',
  name: 'Acme LLC',
  jurisdictionCode: 'US',
  baseCurrency: 'USD',
  ein: '12-3456789',
  address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701' },
};

describe('toCompanyDraft', () => {
  it('starts the edit sheet on what is stored', () => {
    const draft = toCompanyDraft({
      ...nlEntity,
      vatNumber: 'NL123456789B01',
      registrationNumber: '12345678',
      iban: 'NL91ABNA0417164300',
      address: { line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 AB' },
    });
    expect(draft).toMatchObject({
      name: 'E2E Company BV',
      taxId: 'NL123456789B01',
      registrationNumber: '12345678',
      iban: 'NL91 ABNA 0417 1643 00',
      address: { line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 AB' },
    });
  });

  it("uses a US company's EIN as its tax ID", () => {
    expect(toCompanyDraft(usEntity).taxId).toBe('12-3456789');
  });
});

describe('companyProblems', () => {
  it('has nothing to say about an empty form, apart from the name when it is required', () => {
    expect(companyProblems(emptyCompanyDraft(), { code: 'NL' })).toEqual({});
    expect(companyProblems(emptyCompanyDraft(), { code: 'NL', requireName: true })).toEqual({ name: 'required' });
  });

  it('flags a malformed BTW number, KvK number and IBAN', () => {
    const draft = { ...emptyCompanyDraft(), taxId: 'NL123', registrationNumber: '12', iban: 'NL00 0000' };
    expect(companyProblems(draft, { code: 'NL' })).toEqual({
      taxId: 'btwFormat',
      registrationNumber: 'kvkFormat',
      iban: 'ibanFormat',
    });
  });

  it('accepts a complete Dutch company', () => {
    const draft = {
      ...emptyCompanyDraft(),
      name: 'E2E Company BV',
      taxId: 'NL123456789B01',
      registrationNumber: '1234 5678',
      iban: 'NL91 ABNA 0417 1643 00',
      address: { ...emptyCompanyDraft().address, line1: 'Damrak 1', city: 'Amsterdam' },
    };
    expect(companyProblems(draft, { code: 'NL', requireName: true })).toEqual({});
  });

  it('wants a street and a city once an address is started, outside the US', () => {
    const draft = { ...emptyCompanyDraft(), address: { ...emptyCompanyDraft().address, postalCode: '1012 AB' } };
    expect(companyProblems(draft, { code: 'NL' }).address).toEqual({ line1: 'required', city: 'required' });
    // A US address is checked by the state / ZIP rules instead.
    expect(companyProblems(draft, { code: 'US' }).address).toBeUndefined();
  });

  it('checks the EIN of a US company', () => {
    expect(companyProblems({ ...emptyCompanyDraft(), taxId: '12-34' }, { code: 'US' }).taxId).toBe('einFormat');
  });
});

describe('buildEntityUpdate', () => {
  it('sends only what changed', () => {
    const draft = {
      ...toCompanyDraft(nlEntity),
      taxId: 'nl 123456789 b01',
      registrationNumber: '1234 5678',
      iban: 'nl91 abna 0417 1643 00',
      bic: 'abnanl2a',
      address: { ...emptyCompanyDraft().address, line1: ' Damrak 1 ', city: 'Amsterdam', postalCode: '1012 AB' },
    };
    expect(buildEntityUpdate(nlEntity, draft)).toEqual({
      taxIdentifiers: { vatNumber: 'NL123456789B01', registrationNumber: '12345678' },
      bankDetails: { iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' },
      address: { country: 'NL', line1: 'Damrak 1', city: 'Amsterdam', postalCode: '1012 AB' },
    });
  });

  it('sends nothing for an untouched form, so no stored identifier is re-checked', () => {
    const stored = { ...nlEntity, vatNumber: 'NL123456789B01', iban: 'NL91ABNA0417164300' };
    expect(isEmptyUpdate(buildEntityUpdate(stored, toCompanyDraft(stored)))).toBe(true);
  });

  it('clears an identifier that was emptied', () => {
    const stored = { ...nlEntity, vatNumber: 'NL123456789B01' };
    const update = buildEntityUpdate(stored, { ...toCompanyDraft(stored), taxId: '' });
    expect(update.taxIdentifiers).toEqual({ vatNumber: '' });
  });

  it('puts a US EIN in einOrSsn and the address in the US shape', () => {
    const update = buildEntityUpdate(usEntity, {
      ...toCompanyDraft(usEntity),
      taxId: '987654321',
      address: { ...toCompanyDraft(usEntity).address, city: 'Dallas' },
    });
    expect(update.taxIdentifiers).toEqual({ einOrSsn: '98-7654321' });
    expect(update.address).toMatchObject({ country: 'US', city: 'Dallas', state: 'TX', postalCode: '78701' });
  });

  it('does not clear an address with a blank form, and renames the company', () => {
    const update = buildEntityUpdate(usEntity, {
      ...toCompanyDraft(usEntity),
      name: ' Acme Inc ',
      address: emptyCompanyDraft().address,
    });
    expect(update).toEqual({ name: 'Acme Inc' });
  });
});

describe('toGenericAddress', () => {
  it('drops blank parts, sets the country and returns null for a blank address', () => {
    expect(toGenericAddress(emptyCompanyDraft().address, 'NL')).toBeNull();
    expect(
      toGenericAddress({ ...emptyCompanyDraft().address, line1: 'Damrak 1', city: ' Amsterdam' }, 'NL'),
    ).toEqual({ country: 'NL', line1: 'Damrak 1', city: 'Amsterdam' });
  });

  it('carries the stored state and county through, overwriting only what the form edits', () => {
    const stored = {
      line1: 'Old Rd 1',
      line2: 'Floor 2',
      city: 'Mumbai',
      state: 'MH',
      county: 'Thane',
      postalCode: '400001',
      country: 'IN',
    };
    expect(
      toGenericAddress({ ...toAddressDraft(stored), line1: 'New Rd 5', line2: '' }, 'IN', stored),
    ).toEqual({
      line1: 'New Rd 5',
      city: 'Mumbai',
      state: 'MH',
      county: 'Thane',
      postalCode: '400001',
      country: 'IN',
    });
  });

  it('keeps the stored state in the update when only the street of an IN company changes', () => {
    const inEntity: AccountingEntity = {
      id: 'ent_3',
      name: 'Asha Pvt Ltd',
      jurisdictionCode: 'IN',
      baseCurrency: 'INR',
      address: { line1: 'Old Rd 1', city: 'Mumbai', state: 'MH', postalCode: '400001', country: 'IN' },
    };
    const draft = toCompanyDraft(inEntity);
    const update = buildEntityUpdate(inEntity, { ...draft, address: { ...draft.address, line1: 'New Rd 5' } });
    expect(update.address).toEqual({
      line1: 'New Rd 5',
      city: 'Mumbai',
      state: 'MH',
      postalCode: '400001',
      country: 'IN',
    });
  });
});

describe('field names in the app language', () => {
  const labelsEn = { taxId: 'VAT number', registrationId: 'KvK number' };
  const labelsNl = { taxId: 'Btw-nummer', registrationId: 'KvK-nummer' };

  it('names the fields per locale and lists them as a phrase', () => {
    const fields = ['vatNumber', 'registrationNumber', 'iban'] as const;
    expect(listInvoiceFields(fields, invoiceFieldNames(en, labelsEn), { comma: ', ', and: en.company.listAnd })).toBe(
      'VAT number, KvK number and IBAN',
    );
    expect(listInvoiceFields(fields, invoiceFieldNames(nl, labelsNl), { comma: ', ', and: nl.company.listAnd })).toBe(
      'Btw-nummer, KvK-nummer en IBAN',
    );
    expect(invoiceFieldNames(nl, labelsNl).address).toBe('bedrijfsadres');
  });

  it('handles one field and none', () => {
    const names = invoiceFieldNames(en, labelsEn);
    expect(listInvoiceFields(['address'], names, { comma: ', ', and: 'and' })).toBe('business address');
    expect(listInvoiceFields([], names, { comma: ', ', and: 'and' })).toBe('');
  });
});
