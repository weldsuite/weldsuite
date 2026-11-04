import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';

/** Every leaf path of a translation object with its string. */
function leaves(value: unknown, prefix = ''): Record<string, string> {
  if (typeof value === 'string') return { [prefix]: value };
  if (typeof value !== 'object' || value === null) return {};
  return Object.assign({}, ...Object.entries(value).map(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key)));
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe('flowClosing locale', () => {
  const english = leaves(en.flowClosing);
  const dutch = leaves(nl.flowClosing);

  it('has the same keys in en and nl', () => {
    expect(Object.keys(dutch).sort()).toEqual(Object.keys(english).sort());
  });

  it('uses the same placeholders in both languages', () => {
    for (const [key, text] of Object.entries(english)) {
      expect(placeholders(dutch[key] ?? ''), key).toEqual(placeholders(text));
    }
  });

  it('has no empty strings', () => {
    for (const [key, text] of [...Object.entries(english), ...Object.entries(dutch)]) {
      expect(text.length, key).toBeGreaterThan(0);
    }
  });
});
