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

const english = leaves(en.weldbooksUs.bankFeeds as Tree);
const dutch = leaves(nl.weldbooksUs.bankFeeds as Tree);

describe('weldbooksUs.bankFeeds locale', () => {
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
      const keys = [...leaves(locale.weldbooksUs.bankFeeds as Tree).keys()];
      for (const key of keys.filter((k) => k.endsWith('.one'))) {
        expect(keys, key).toContain(key.replace(/\.one$/, '.other'));
      }
    }
  });
});
