import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';

type Tree = { [key: string]: string | string[] | Tree };

/** Every leaf of a translation tree as `path -> string` (an array becomes `path[i]`). */
function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else if (Array.isArray(value)) value.forEach((item, index) => out.set(`${path}[${index}]`, item));
    else for (const [inner, text] of leaves(value, path)) out.set(inner, text);
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{[a-zA-Z0-9]+\}/g)].map((m) => m[0]).sort();

const english = leaves(en.weldbooksUs.form1099 as Tree);
const dutch = leaves(nl.weldbooksUs.form1099 as Tree);

describe('1099 translations: English and Dutch', () => {
  it('have something in them', () => {
    expect(english.size).toBeGreaterThan(300);
  });

  it('have the same keys', () => {
    expect([...dutch.keys()].filter((key) => !english.has(key))).toEqual([]);
    expect([...english.keys()].filter((key) => !dutch.has(key))).toEqual([]);
  });

  it('leave no string empty or marked as untranslated', () => {
    for (const [path, text] of [...english, ...dutch]) {
      expect(text.trim(), path).not.toBe('');
      expect(text, path).not.toMatch(/\[TRANSLATE\]|\[REVIEW\]|TODO|FIXME/);
    }
  });

  it('use the same placeholders in both languages, so a Dutch sentence fills in the same values', () => {
    const mismatched = [...english]
      .filter(([path, text]) => JSON.stringify(placeholders(text)) !== JSON.stringify(placeholders(dutch.get(path) ?? '')))
      .map(([path]) => path);
    expect(mismatched).toEqual([]);
  });
});
