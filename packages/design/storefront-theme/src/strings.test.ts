// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { errorMessage, format, plural, statusLabel, t } from './strings';
import { SHOP_LOCALES } from './types';

type Tree = { [key: string]: string | Tree };

/** Every leaf of a strings tree, by its dotted path. */
function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [child, text] of leaves(value, path)) out.set(child, text);
  }
  return out;
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('shop strings', () => {
  const english = leaves(t('en') as unknown as Tree);

  it.each(SHOP_LOCALES.filter((locale) => locale !== 'en'))('%s has every English key, none empty, no extras', (locale) => {
    const other = leaves(t(locale) as unknown as Tree);
    expect([...other.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [path, text] of other) expect(text.trim(), `${locale}.${path}`).not.toBe('');
  });

  it.each(SHOP_LOCALES.filter((locale) => locale !== 'en'))('%s keeps the placeholders of every English string', (locale) => {
    const other = leaves(t(locale) as unknown as Tree);
    for (const [path, text] of english) expect(placeholders(other.get(path) ?? ''), `${locale}.${path}`).toEqual(placeholders(text));
  });

  it('falls back to English for an unknown language', () => {
    expect(t('es')).toBe(t('en'));
    expect(t(undefined)).toBe(t('en'));
  });

  it('formats placeholders and plurals', () => {
    expect(format('Hi {name}, {missing}', { name: 'Ann' })).toBe('Hi Ann, {missing}');
    expect(plural('en', t('en').cart.itemCount, 1)).toBe('1 item');
    expect(plural('nl', t('nl').cart.itemCount, 3)).toBe('3 artikelen');
    expect(plural('fr', t('fr').cart.itemCount, 0)).toBe('0 article');
  });

  it('maps API and local error codes, with a generic sentence otherwise', () => {
    const s = t('de');
    expect(errorMessage(s, 'OUT_OF_STOCK')).toBe(s.errors.codes.OUT_OF_STOCK);
    expect(errorMessage(s, 'TERMS_REQUIRED')).toBe(s.errors.local.TERMS_REQUIRED);
    expect(errorMessage(s, 'SOMETHING_NEW')).toBe(s.errors.generic);
    expect(errorMessage(s, null)).toBe(s.errors.generic);
  });

  it('labels statuses, and makes unknown ones readable', () => {
    expect(statusLabel(t('en'), 'payment', 'on_invoice')).toBe('On invoice');
    expect(statusLabel(t('en'), 'order', 'on_hold')).toBe('On hold');
  });
});
