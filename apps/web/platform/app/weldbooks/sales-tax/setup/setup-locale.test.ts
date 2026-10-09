import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { WELD_TAX_CODES } from '../rules/rule-model';
import { allUsStates } from '@/lib/weldbooks/us-sales-tax-states';

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

const english = leaves(en.weldbooksUs.salesTax.setup as Tree);
const dutch = leaves(nl.weldbooksUs.salesTax.setup as Tree);

describe('weldbooksUs.salesTax.setup locale', () => {
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

  it('gives every plural a one and an other form', () => {
    for (const locale of [en, nl]) {
      const keys = [...leaves(locale.weldbooksUs.salesTax.setup as Tree).keys()];
      for (const key of keys.filter((k) => k.endsWith('.one'))) {
        expect(keys, key).toContain(key.replace(/\.one$/, '.other'));
      }
    }
  });

  it('has no leftover TODO or undefined in either language', () => {
    for (const [path, text] of [...english, ...dutch]) {
      expect(text, path).not.toMatch(/\bTODO\b|\bundefined\b/);
    }
  });

  it('does not touch the subtrees other screens own', () => {
    expect(Object.keys(en.weldbooksUs.salesTax)).toEqual(expect.arrayContaining(['setup', 'center', 'documents']));
    expect(Object.keys(nl.weldbooksUs.salesTax)).toEqual(expect.arrayContaining(['setup', 'center', 'documents']));
  });

  it('labels every product tax code, in both languages', () => {
    for (const code of WELD_TAX_CODES) {
      expect(english.get(`taxCodes.${code}.label`), code).toBeTruthy();
      expect(dutch.get(`taxCodes.${code}.label`), code).toBeTruthy();
      expect(dutch.get(`taxCodes.${code}.description`), code).toBeTruthy();
    }
  });

  it('describes every state program that can show on the registration screen', () => {
    const programs = new Set(allUsStates().flatMap((s) => s.specialPrograms ?? []));
    for (const program of programs) {
      expect(english.get(`wizard.info.programs.${program}`), program).toBeTruthy();
      expect(dutch.get(`wizard.info.programs.${program}`), program).toBeTruthy();
    }
  });
});
