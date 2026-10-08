import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [nested, text] of leaves(value, path)) out.set(nested, text);
  }
  return out;
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();

const english = leaves(en.weldbooksUs.assets as Tree);
const dutch = leaves(nl.weldbooksUs.assets as Tree);

describe('weldbooksUs.assets translations', () => {
  it('has the same keys in English and Dutch', () => {
    const missingInDutch = [...english.keys()].filter((key) => !dutch.has(key));
    const missingInEnglish = [...dutch.keys()].filter((key) => !english.has(key));
    expect(missingInDutch).toEqual([]);
    expect(missingInEnglish).toEqual([]);
  });

  it('has no empty strings and no leftover translation markers', () => {
    for (const [key, text] of [...english, ...dutch]) {
      expect(text.trim(), key).not.toBe('');
      expect(text, key).not.toMatch(/\[TRANSLATE\]|\[REVIEW\]|TODO|FIXME/);
    }
  });

  it('keeps the same placeholders in both languages', () => {
    for (const [key, text] of english) {
      const other = dutch.get(key);
      if (other === undefined) continue;
      expect(placeholders(other), key).toEqual(placeholders(text));
    }
  });

  it('is large enough to cover the screens (guards against an empty locale)', () => {
    expect(english.size).toBeGreaterThan(500);
  });
});
