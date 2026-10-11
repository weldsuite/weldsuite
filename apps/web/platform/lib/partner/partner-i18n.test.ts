/**
 * The partner namespace must exist in both maintained locales with the same
 * keys and the same {placeholders}: a missing key fails at runtime, not at
 * compile time (nl is not type-checked against en).
 */

import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';

function leaves(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === 'object') {
        for (const [p, v] of leaves(child, path)) out.set(p, v);
      } else {
        out.set(path, String(child));
      }
    }
  }
  return out;
}

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();

describe('partner translations', () => {
  const enLeaves = leaves(en.partner);
  const nlLeaves = leaves(nl.partner);

  it('nl has every en key and nothing else', () => {
    expect([...nlLeaves.keys()].sort()).toEqual([...enLeaves.keys()].sort());
  });

  it('keeps the same placeholders in every string', () => {
    for (const [key, value] of enLeaves) {
      expect(placeholders(nlLeaves.get(key) ?? ''), key).toEqual(placeholders(value));
    }
  });

  it('has no empty or untranslated-marker strings', () => {
    for (const [key, value] of [...enLeaves, ...nlLeaves]) {
      expect(value.trim().length, key).toBeGreaterThan(0);
      expect(value, key).not.toMatch(/\[TRANSLATE\]|\[REVIEW\]|TODO/);
    }
  });
});
