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

const english = leaves(en.weldbooksUs.payments as Tree);
const dutch = leaves(nl.weldbooksUs.payments as Tree);

describe('weldbooksUs.payments locale', () => {
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

  it('keeps what is printed on a check in English in both languages', () => {
    for (const key of ['payTo', 'date', 'dollars', 'memo', 'voidAfter', 'paymentDetails', 'total']) {
      expect(dutch.get(`checkPdf.${key}`), key).toBe(english.get(`checkPdf.${key}`));
    }
  });

  it('names every hold code and every error the screens translate', () => {
    for (const code of [
      'no_bank_details',
      'invalid_bank_details',
      'bank_details_changed',
      'prenote_required',
      'prenote_pending',
      'in_other_run',
      'backup_withholding',
    ]) {
      expect(english.has(`holds.codes.${code}`), code).toBe(true);
      expect(english.has(`holds.help.${code}`), code).toBe(true);
    }
    for (const code of ['NOTHING_TO_PAY', 'ALREADY_APPROVED', 'ACH_SETTINGS_INCOMPLETE', 'BANK_DETAILS_CHANGED', 'NACHA_INVALID']) {
      expect(english.has(`errors.${code}`), code).toBe(true);
    }
  });
});
