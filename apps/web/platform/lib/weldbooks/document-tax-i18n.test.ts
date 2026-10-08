import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { WELD_TAX_CODES } from './tax-codes';

type Tree = { [key: string]: Tree | string };

/** Every leaf of a translation tree as `a.b.c`. */
function leaves(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : leaves(value, `${prefix}${key}.`),
  );
}

/** The `{placeholders}` of every leaf, so a translation can't drop one the code fills in. */
function placeholders(tree: Tree, prefix = ''): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string') {
      result[`${prefix}${key}`] = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    } else {
      Object.assign(result, placeholders(value, `${prefix}${key}.`));
    }
  }
  return result;
}

const english = en.weldbooksUs.salesTax.documents as unknown as Tree;
const dutch = nl.weldbooksUs.salesTax.documents as unknown as Tree;

describe('weldbooksUs.salesTax.documents translations', () => {
  it('has the same keys in English and Dutch', () => {
    expect(leaves(dutch).sort()).toEqual(leaves(english).sort());
  });

  it('fills the same placeholders in both languages', () => {
    expect(placeholders(dutch)).toEqual(placeholders(english));
  });

  it('has no empty text', () => {
    for (const tree of [english, dutch]) {
      const lookup = (path: string) => path.split('.').reduce<Tree | string>((node, key) => (node as Tree)[key], tree);
      const empty = leaves(tree).filter((path) => String(lookup(path)).trim() === '');
      expect(empty).toEqual([]);
    }
  });

  it('names every tax code in both languages', () => {
    for (const tree of [en.weldbooksUs.salesTax.documents, nl.weldbooksUs.salesTax.documents]) {
      expect(Object.keys(tree.taxCodes).sort()).toEqual([...WELD_TAX_CODES].sort());
    }
  });
});
