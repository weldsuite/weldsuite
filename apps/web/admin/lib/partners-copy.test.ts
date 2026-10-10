import { describe, expect, it } from 'vitest';
import { partnersCopyByLocale } from './partners-copy';

function flatten(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('partner copy', () => {
  const en = flatten(partnersCopyByLocale.en);
  const nl = new Map(flatten(partnersCopyByLocale.nl));

  it('has a Dutch string for every English one, with the same placeholders', () => {
    for (const [key, text] of en) {
      const dutch = nl.get(key);
      expect(dutch, key).toBeTruthy();
      expect(placeholders(dutch as string), key).toEqual(placeholders(text));
    }
    expect(nl.size).toBe(en.length);
  });

  it('has no empty strings', () => {
    for (const [key, text] of en) expect(text.trim(), key).not.toBe('');
  });
});
