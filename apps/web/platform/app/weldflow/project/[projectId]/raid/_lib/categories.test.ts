import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { canAddCategory, draftBody, draftFromCategories, draftRowErrors } from './categories';
import { riskCategoryOptions } from './copy';

const categories = {
  builtIn: [
    { key: 'technical', hidden: false },
    { key: 'schedule', hidden: false },
    { key: 'budget', hidden: true },
    { key: 'scope', hidden: false },
    { key: 'resource', hidden: false },
    { key: 'compliance', hidden: false },
    { key: 'external', hidden: true },
  ],
  custom: [{ id: 'rcat_1', name: 'Security' }],
} as const satisfies Parameters<typeof draftFromCategories>[0];

describe('riskCategoryOptions', () => {
  const copy = en.projects.raid;

  it('offers every built-in before the list has loaded', () => {
    expect(riskCategoryOptions(copy, undefined, null).map((o) => o.value)).toEqual([
      'technical', 'schedule', 'budget', 'scope', 'resource', 'compliance', 'external',
    ]);
  });

  it('offers the shown built-ins (translated) and then the custom ones', () => {
    const options = riskCategoryOptions(copy, categories, null);
    expect(options.map((o) => o.value)).toEqual(['technical', 'schedule', 'scope', 'resource', 'compliance', 'Security']);
    expect(options[0]).toEqual({ value: 'technical', label: 'Technical' });
    expect(options.at(-1)).toEqual({ value: 'Security', label: 'Security' });
  });

  it('keeps the current value when it is hidden, deleted or typed by hand', () => {
    expect(riskCategoryOptions(copy, categories, 'budget').at(-1)).toEqual({ value: 'budget', label: 'Budget' });
    expect(riskCategoryOptions(copy, categories, 'Legal').at(-1)).toEqual({ value: 'Legal', label: 'Legal' });
    expect(riskCategoryOptions(copy, categories, 'Security').filter((o) => o.value === 'Security')).toHaveLength(1);
  });
});

describe('category draft', () => {
  const labels = ['Technisch', 'Planning'];

  it('round-trips the stored list into a save body', () => {
    const draft = draftFromCategories(categories);
    expect(draft.hidden).toEqual(['budget', 'external']);
    draft.custom.push({ uid: 'new_1', name: '  Vendor ' });
    expect(draftBody(draft)).toEqual({
      hidden: ['budget', 'external'],
      custom: [{ id: 'rcat_1', name: 'Security' }, { name: 'Vendor' }],
    });
  });

  it('flags empty names, built-in keys or labels, and repeats', () => {
    const errors = draftRowErrors(
      [
        { uid: 'a', name: 'Security' },
        { uid: 'b', name: ' security ' },
        { uid: 'c', name: '' },
        { uid: 'd', name: 'Budget' },
        { uid: 'e', name: 'technisch' },
        { uid: 'f', name: 'Vendor' },
      ],
      labels,
    );
    expect(Object.fromEntries(errors)).toEqual({ b: 'duplicate', c: 'empty', d: 'builtIn', e: 'builtIn' });
  });

  it('stops adding at the maximum', () => {
    const full = { hidden: [], custom: Array.from({ length: 50 }, (_, i) => ({ uid: `u${i}`, name: `C${i}` })) };
    expect(canAddCategory(full)).toBe(false);
    expect(canAddCategory({ hidden: [], custom: [] })).toBe(true);
  });

  it('has a manager label for every locale it ships in', () => {
    for (const locale of [en, nl]) expect(locale.projects.raid.categoryManager.title).toBeTruthy();
  });
});
