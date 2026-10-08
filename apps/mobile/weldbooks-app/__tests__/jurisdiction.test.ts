import {
  BUILT_IN_JURISDICTIONS,
  DEFAULT_TERMINOLOGY,
  NO_FEATURES,
  defaultJurisdictionCode,
  defaultTaxRateFor,
  findJurisdiction,
  isUsJurisdiction,
  resolveFormatLocale,
  resolveJurisdictionContext,
  terminologyLabels,
  terminologyValues,
  usesIban,
  usesUsDates,
} from '@/lib/jurisdiction';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';
import type { Jurisdiction } from '@/types/accounting';

const US = BUILT_IN_JURISDICTIONS.find((j) => j.code === 'US') as Jurisdiction;
const NL = BUILT_IN_JURISDICTIONS.find((j) => j.code === 'NL') as Jurisdiction;
const IN = BUILT_IN_JURISDICTIONS.find((j) => j.code === 'IN') as Jurisdiction;

describe('terminology', () => {
  it('names a US entity in US words in English', () => {
    const labels = terminologyLabels(en.terminology, US.terminology);

    expect(labels).toMatchObject({
      tax: 'Sales tax',
      taxPercent: 'Sales tax %',
      taxRateTemplate: '{rate}% sales tax',
      taxId: 'EIN',
      taxIdPlaceholder: '12-3456789',
      supplier: 'Vendor',
      suppliers: 'Vendors',
      creditNote: 'Credit memo',
    });
  });

  it('names a Dutch entity in VAT words in English and in Dutch', () => {
    expect(terminologyLabels(en.terminology, NL.terminology)).toMatchObject({
      tax: 'VAT',
      taxId: 'VAT number',
      supplier: 'Supplier',
      suppliers: 'Suppliers',
      creditNote: 'Credit note',
    });
    expect(terminologyLabels(nl.terminology, NL.terminology)).toMatchObject({
      tax: 'Btw',
      taxPercent: 'Btw %',
      taxRateTemplate: '{rate}% btw',
      taxId: 'Btw-nummer',
      supplier: 'Leverancier',
      creditNote: 'Creditnota',
    });
  });

  it('names an Indian entity in GST words', () => {
    expect(terminologyLabels(en.terminology, IN.terminology)).toMatchObject({
      tax: 'GST',
      taxId: 'GSTIN',
      supplier: 'Supplier',
      creditNote: 'Credit note',
    });
  });

  it('keeps a Dutch-language user on one word for both vendor and supplier', () => {
    expect(terminologyLabels(nl.terminology, US.terminology)).toMatchObject({
      supplier: 'Leverancier',
      suppliers: 'Leveranciers',
      creditNote: 'Creditnota',
      taxId: 'EIN',
    });
  });

  it('has a label for every terminology code the API can send, in both languages', () => {
    for (const catalog of [en.terminology, nl.terminology]) {
      for (const tax of ['vat', 'gst', 'sales_tax'] as const) {
        expect(catalog.tax[tax]).toBeTruthy();
        expect(catalog.taxPercent[tax]).toBeTruthy();
        expect(catalog.taxRate[tax]).toContain('{rate}');
      }
      for (const id of ['vat_number', 'gstin', 'ein'] as const) {
        expect(catalog.taxId[id]).toBeTruthy();
        expect(catalog.taxIdPlaceholder[id]).toBeTruthy();
      }
      for (const supplier of ['supplier', 'vendor'] as const) {
        expect(catalog.supplier[supplier]).toBeTruthy();
        expect(catalog.suppliers[supplier]).toBeTruthy();
      }
      for (const note of ['credit_note', 'credit_memo'] as const) {
        expect(catalog.creditNote[note]).toBeTruthy();
      }
    }
  });

  it('gives sentences the lower-case and the labelled forms', () => {
    const values = terminologyValues(terminologyLabels(en.terminology, US.terminology));

    expect(values).toMatchObject({
      tax: 'Sales tax',
      taxId: 'EIN',
      supplier: 'vendor',
      Supplier: 'Vendor',
      suppliers: 'vendors',
      creditNote: 'credit memo',
      CreditNote: 'Credit memo',
    });
  });

  it('fills the catalog templates with them', () => {
    const interpolate = (template: string, values: Record<string, string>) =>
      template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
    const us = terminologyValues(terminologyLabels(en.terminology, US.terminology));
    const dutch = terminologyValues(terminologyLabels(nl.terminology, NL.terminology));

    expect(interpolate(en.invoiceDetail.createCreditNote, us)).toBe('Create credit memo');
    expect(interpolate(en.invoiceDetail.creditNoteCreated, us)).toBe('Credit memo created');
    expect(interpolate(en.billNew.nameError, us)).toBe('Enter a vendor name');
    expect(interpolate(en.billNew.namePlaceholder, us)).toBe('Vendor name');
    expect(interpolate(en.contacts.both, us)).toBe('Customer & vendor');
    expect(interpolate(en.more.contactsSub, us)).toBe('Customers and vendors');
    expect(interpolate(en.expenses.unknownVendor, us)).toBe('Unknown vendor');
    expect(interpolate(en.billDetail.taxPaid, us)).toBe('Sales tax paid (part of the cost)');

    expect(interpolate(nl.invoiceDetail.createCreditNote, dutch)).toBe('Creditnota maken');
    expect(interpolate(nl.invoiceDetail.creditNoteCreated, dutch)).toBe('Creditnota aangemaakt');
    expect(interpolate(nl.billNew.nameError, dutch)).toBe('Vul de naam van de leverancier in');
    expect(interpolate(nl.expenses.unknownVendor, dutch)).toBe('Onbekende leverancier');
    expect(interpolate(nl.more.contactsSub, dutch)).toBe('Klanten en leveranciers');
  });
});

describe('features', () => {
  it('gives the Dutch entity the VAT return, ICP and XAF and no sales tax', () => {
    expect(NL.features).toMatchObject({
      vatReturn: true,
      icp: true,
      xafExport: true,
      smallBusinessScheme: true,
      salesTax: false,
      form1099: false,
    });
  });

  it('gives the US entity sales tax and 1099s and none of the Dutch modules', () => {
    expect(US.features).toMatchObject({
      salesTax: true,
      form1099: true,
      vatReturn: false,
      icp: false,
      xafExport: false,
      smallBusinessScheme: false,
      gstReturn: false,
    });
  });

  it('gives the Indian entity the GST return only', () => {
    expect(IN.features).toMatchObject({ gstReturn: true, vatReturn: false, salesTax: false });
  });

  it('turns every module off for a country it does not know', () => {
    const context = resolveJurisdictionContext({ jurisdictionCode: 'ZZ', baseCurrency: 'XXX' });

    expect(context.features).toEqual(NO_FEATURES);
    expect(context.terminology).toEqual(DEFAULT_TERMINOLOGY);
    expect(context.isUs).toBe(false);
  });
});

describe('resolveJurisdictionContext', () => {
  it('answers from the built-in table before the API list has loaded', () => {
    const context = resolveJurisdictionContext({ jurisdictionCode: 'us', baseCurrency: 'USD', locale: 'en-US' });

    expect(context).toMatchObject({
      code: 'US',
      isUs: true,
      usesIban: false,
      currency: 'USD',
      entityLocale: 'en-US',
    });
    expect(context.features.vatReturn).toBe(false);
    expect(context.terminology.tax).toBe('sales_tax');
  });

  it('prefers what the API says over the built-in table', () => {
    const fromApi: Jurisdiction = {
      ...NL,
      features: { ...NL.features, icp: false, xafExport: false },
    };

    const context = resolveJurisdictionContext(
      { jurisdictionCode: 'NL', baseCurrency: 'EUR', locale: 'nl-NL' },
      [fromApi],
    );

    expect(context.features.vatReturn).toBe(true);
    expect(context.features.icp).toBe(false);
  });

  it('takes the entity locale from the jurisdiction when the entity row has none', () => {
    expect(resolveJurisdictionContext({ jurisdictionCode: 'NL', baseCurrency: 'EUR' }).entityLocale).toBe('nl-NL');
    expect(resolveJurisdictionContext({ jurisdictionCode: 'US', baseCurrency: 'USD' }).entityLocale).toBe('en-US');
  });

  it('copes with no entity at all', () => {
    const context = resolveJurisdictionContext(null);

    expect(context.code).toBeNull();
    expect(context.features).toEqual(NO_FEATURES);
    expect(context.currency).toBe('EUR');
    expect(context.entityLocale).toBeNull();
  });

  it('uses the entity base currency, not the jurisdiction default', () => {
    // A US entity can keep its books in another currency.
    expect(resolveJurisdictionContext({ jurisdictionCode: 'US', baseCurrency: 'CAD' }).currency).toBe('CAD');
  });
});

describe('findJurisdiction', () => {
  it('matches case-insensitively and falls back to the built-in table', () => {
    expect(findJurisdiction('us')?.name).toBe('United States');
    expect(findJurisdiction('US', [])?.code).toBe('US');
    expect(findJurisdiction('ZZ')).toBeNull();
    expect(findJurisdiction(null)).toBeNull();
  });
});

describe('resolveFormatLocale', () => {
  it('reads a US entity in US format whatever language the app is in', () => {
    expect(resolveFormatLocale('en', 'en-US')).toBe('en-US');
    expect(resolveFormatLocale('nl', 'en-US')).toBe('en-US');
  });

  it('keeps the app language locale for a Dutch entity, as before entities had a locale', () => {
    expect(resolveFormatLocale('en', 'nl-NL')).toBe('en-GB');
    expect(resolveFormatLocale('nl', 'nl-NL')).toBe('nl-NL');
  });

  it('gives an English-language user the regional style of an English-speaking entity', () => {
    expect(resolveFormatLocale('en', 'en-IN')).toBe('en-IN');
    expect(resolveFormatLocale('nl', 'en-IN')).toBe('nl-NL');
  });

  it('falls back to the app language without an entity locale', () => {
    expect(resolveFormatLocale('en', null)).toBe('en-GB');
    expect(resolveFormatLocale('nl', undefined)).toBe('nl-NL');
  });

  it('turns the US locale into month-first dates and nothing else', () => {
    expect(usesUsDates('en-US')).toBe(true);
    expect(usesUsDates('en-GB')).toBe(false);
    expect(usesUsDates(null)).toBe(false);
  });
});

describe('small helpers', () => {
  it('recognises the US', () => {
    expect(isUsJurisdiction('US')).toBe(true);
    expect(isUsJurisdiction('us')).toBe(true);
    expect(isUsJurisdiction('NL')).toBe(false);
    expect(isUsJurisdiction(null)).toBe(false);
  });

  it('banks on IBANs in Europe and on routing numbers in the US', () => {
    expect(usesIban('NL')).toBe(true);
    expect(usesIban('DE')).toBe(true);
    expect(usesIban('US')).toBe(false);
    expect(usesIban('IN')).toBe(false);
    expect(usesIban(undefined)).toBe(false);
  });

  it('starts a new VAT or GST line on the country default and a US line on none', () => {
    expect(defaultTaxRateFor('NL')).toBe('21');
    expect(defaultTaxRateFor('IN')).toBe('18');
    expect(defaultTaxRateFor('US')).toBe('0');
    expect(defaultTaxRateFor(null)).toBe('0');
  });

  it('starts company setup on the country of the phone when it is supported', () => {
    expect(defaultJurisdictionCode('en-US')).toBe('US');
    expect(defaultJurisdictionCode('en_IN')).toBe('IN');
    expect(defaultJurisdictionCode('nl-NL')).toBe('NL');
    expect(defaultJurisdictionCode('en-GB')).toBe('NL');
    expect(defaultJurisdictionCode('en')).toBe('NL');
  });
});
