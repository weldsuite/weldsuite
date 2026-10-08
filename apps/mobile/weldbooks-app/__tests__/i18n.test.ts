import { interpolate, plural } from '@/lib/i18n/interpolate';
import { resolveAppLanguage } from '@/lib/i18n/language';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      leafKeys(nested, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

describe('resolveAppLanguage', () => {
  it('keeps English and Dutch as-is', () => {
    expect(resolveAppLanguage('en')).toBe('en');
    expect(resolveAppLanguage('nl')).toBe('nl');
  });

  it('maps regional tags onto the base language', () => {
    expect(resolveAppLanguage('nl-NL')).toBe('nl');
    expect(resolveAppLanguage('en_GB')).toBe('en');
  });

  it('falls back to English for unsupported or empty profile values', () => {
    expect(resolveAppLanguage('es')).toBe('en');
    expect(resolveAppLanguage('fr-FR')).toBe('en');
    expect(resolveAppLanguage(undefined)).toBe('en');
    expect(resolveAppLanguage('')).toBe('en');
  });
});

describe('interpolate and plural', () => {
  it('substitutes named placeholders', () => {
    expect(interpolate('Due {date}', { date: '5 Aug' })).toBe('Due 5 Aug');
  });

  it('picks one vs other and injects the count', () => {
    expect(plural(1, { one: '{count} invoice', other: '{count} invoices' })).toBe('1 invoice');
    expect(plural(3, { one: '{count} invoice', other: '{count} invoices' })).toBe('3 invoices');
  });
});

describe('English and Dutch catalogs', () => {
  it('expose the same keys so a locale switch cannot miss a string', () => {
    expect(leafKeys(nl).sort()).toEqual(leafKeys(en).sort());
  });

  it('actually translates a representative sample rather than copying English', () => {
    expect(nl.invoices.title).toBe('Facturen');
    expect(nl.settings.language).toBe('Taal');
    expect(nl.auth.signIn).toBe('Inloggen');
    expect(nl.dashboard.outstanding).toBe('Openstaand');
    expect(nl.invoices.title).not.toBe(en.invoices.title);
  });
});

function leafStrings(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]];
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      leafStrings(nested, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [];
}

/** The names of the placeholders in a string; `{CreditNote}` and `{creditNote}` are one value, capitalised for a sentence start. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1].toLowerCase()).sort();
}

describe('placeholders', () => {
  it('are the same in Dutch as in English, so a translation cannot drop a value', () => {
    const dutch = new Map(leafStrings(nl));
    for (const [key, english] of leafStrings(en)) {
      expect({ key, placeholders: placeholders(dutch.get(key) ?? '') }).toEqual({
        key,
        placeholders: placeholders(english),
      });
    }
  });

  it('use the names the terminology values provide', () => {
    const provided = new Set(['tax', 'taxid', 'supplier', 'suppliers', 'creditnote']);
    // Strings filled with terminology values, by catalog path.
    const terminologyStrings = [
      en.invoiceDetail.createCreditNote,
      en.invoiceDetail.creditNoteTitle,
      en.invoiceDetail.creditNoteCreated,
      en.billNew.namePlaceholder,
      en.billNew.nameError,
      en.billNew.referencePlaceholder,
      en.billDetail.taxPaid,
      en.billDetail.useTaxHint,
      en.expenses.unknownVendor,
      en.contacts.both,
      en.contacts.emptyDescription,
      en.more.contactsSub,
      en.expenseQuick.amountHint,
    ];
    for (const text of terminologyStrings) {
      for (const name of placeholders(text)) {
        expect(provided.has(name) || ['rate', 'total'].includes(name)).toBe(true);
      }
    }
  });
});

describe('US wording', () => {
  it('speaks of sales tax, vendors and credit memos for a US entity', () => {
    expect(en.terminology.tax.sales_tax).toBe('Sales tax');
    expect(en.terminology.supplier.vendor).toBe('Vendor');
    expect(en.terminology.creditNote.credit_memo).toBe('Credit memo');
    expect(en.terminology.taxId.ein).toBe('EIN');
  });

  it('no longer hard-codes VAT, supplier or credit note in the strings every jurisdiction shares', () => {
    const shared = [
      ...leafStrings(en.invoiceDetail),
      ...leafStrings(en.billDetail),
      ...leafStrings(en.billNew),
      ...leafStrings(en.lineItems),
      ...leafStrings(en.contacts),
      ...leafStrings(en.contactDetail),
      ...leafStrings(en.contactNew),
      ...leafStrings(en.settings),
      ...leafStrings(en.expenses),
      ...leafStrings(en.expenseQuick),
      ...leafStrings(en.more).filter(([key]) => key !== 'vatReturns' && key !== 'vatReturnsSub'),
    ];
    for (const [key, source] of shared) {
      const text = source.replaceAll(/\{\w+\}/g, '');
      expect({ key, vat: /\bVAT\b/.test(text) }).toEqual({ key, vat: false });
      expect({ key, supplier: /\b[Ss]upplier/.test(text) }).toEqual({ key, supplier: false });
      expect({ key, creditNote: /credit note/i.test(text) }).toEqual({ key, creditNote: false });
    }
  });
});
