import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [inner, text] of leaves(value, path)) out.set(inner, text);
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// The Sales Tax Center keys: the setup screens own the other top-level keys of `weldbooksUs.salesTax`.
const english = leaves(en.weldbooksUs.salesTax.center as Tree);
const dutch = leaves(nl.weldbooksUs.salesTax.center as Tree);

describe('weldbooksUs.salesTax.center locale', () => {
  it('has the same keys in English and Dutch', () => {
    expect([...dutch.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it('has no empty strings', () => {
    for (const [path, text] of [...english, ...dutch]) expect(text.trim(), path).not.toBe('');
  });

  it('uses the same placeholders in both languages', () => {
    for (const [path, text] of english) {
      expect(placeholders(dutch.get(path) ?? ''), path).toEqual(placeholders(text));
    }
  });

  it('translates every sentence: only names, codes and loan words are the same in both languages', () => {
    const sameInBoth = new Set([
      'bases.accrual',
      'levels.county',
      'levels.district',
      'overview.estimatedBreakdown',
      'returnPage.worksheet.documentsCountOne',
      'returnPage.documents.useTax',
      'reports.providerReconciliation.engines.avalara',
      'certificates.expiring.forms.sst_f0003',
      'certificates.expiring.forms.mtc_uniform',
    ]);
    // Words that are the same in Dutch.
    const sameWords = new Set(['Nexus', 'Details', 'Document', 'Open', 'Status', 'Marketplace', 'Info', 'Engine', 'Sales Tax Center', 'Stripe Tax']);
    const copies = [...english].filter(([path, text]) => dutch.get(path) === text && !sameInBoth.has(path) && !sameWords.has(text));
    expect(copies.map(([path]) => path)).toEqual([]);
  });
});
