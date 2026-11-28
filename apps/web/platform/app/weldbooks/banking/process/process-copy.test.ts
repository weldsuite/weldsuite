import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';

/** Every key path of a nested copy object, with `{placeholder}` names, so en and nl can be compared. */
function shape(value: unknown, path = ''): string[] {
  if (typeof value === 'string') {
    const placeholders = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    return [`${path}|${placeholders.join(',')}`];
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => shape(child, path ? `${path}.${key}` : key));
  }
  return [path];
}

describe('the copy of the processing view', () => {
  for (const section of ['processing', 'automatic', 'panel', 'differences', 'credit'] as const) {
    it(`has the same keys and placeholders in en and nl: ${section}`, () => {
      expect(shape(nl.weldbooksConnected[section]).sort()).toEqual(shape(en.weldbooksConnected[section]).sort());
    });
  }

  it('has the new rule conditions and processed-as words in both languages', () => {
    for (const locale of [en, nl]) {
      const form = locale.sweep.weldbooks.reconciliationRuleForm;
      expect(form.field.direction).toBeTruthy();
      expect(form.field.bankAccountId).toBeTruthy();
      expect(form.directionIn).toBeTruthy();
      expect(form.directionOut).toBeTruthy();
      expect(locale.accounting.bankTransactionPanel.processedAs.transfer).toBeTruthy();
      expect(locale.accounting.bankTransactionPanel.processedAs.private).toBeTruthy();
    }
  });

  it('uses the owner words of the glossary', () => {
    expect(en.weldbooksConnected.processing.actions.category).toBe('Book to a category');
    expect(en.weldbooksConnected.processing.actions.ignore).toBe('Ignore');
    expect(en.weldbooksConnected.processing.tabs.toProcess).toBe('To process');
  });
});
