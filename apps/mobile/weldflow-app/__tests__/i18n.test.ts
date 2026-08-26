import { interpolate, plural } from '@/lib/i18n/interpolate';
import { resolveAppLanguage } from '@/lib/i18n/language';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';
import { BRAND, tint } from '@/lib/brand';
import { isTaskOverdue } from '@/lib/date';

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      leafKeys(nested, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

describe('resolveAppLanguage', () => {
  it('keeps English and Dutch as-is', () => {
    expect(resolveAppLanguage('en')).toBe('en');
    expect(resolveAppLanguage('nl')).toBe('nl');
  });

  it('maps regional tags onto the base language', () => {
    expect(resolveAppLanguage('nl-NL')).toBe('nl');
    expect(resolveAppLanguage('en_GB')).toBe('en');
  });

  it('falls back to English for unsupported or empty profile values', () => {
    expect(resolveAppLanguage('es')).toBe('en');
    expect(resolveAppLanguage(undefined)).toBe('en');
  });
});

describe('interpolate and plural', () => {
  it('substitutes named placeholders', () => {
    expect(interpolate('Due {date}', { date: '5 Aug' })).toBe('Due 5 Aug');
  });

  it('picks one vs other and injects the count', () => {
    expect(plural(1, { one: '{count} task', other: '{count} tasks' })).toBe('1 task');
    expect(plural(3, { one: '{count} task', other: '{count} tasks' })).toBe('3 tasks');
  });
});

describe('English and Dutch catalogs', () => {
  it('expose the same keys so a locale switch cannot miss a string', () => {
    expect(leafKeys(nl).sort()).toEqual(leafKeys(en).sort());
  });

  it('actually translates a representative sample rather than copying English', () => {
    expect(nl.projects.title).toBe('Projecten');
    expect(nl.myTasks.title).toBe('Mijn taken');
    expect(nl.settings.language).toBe('Taal');
    expect(nl.projects.title).not.toBe(en.projects.title);
  });
});

describe('brand tokens', () => {
  it('uses the WeldFlow coral from the platform icon', () => {
    expect(BRAND).toBe('#E84C3D');
    expect(tint(BRAND)).toBe('rgba(232,76,61,0.12)');
  });
});

describe('isTaskOverdue', () => {
  it('marks past due open tasks as overdue', () => {
    expect(isTaskOverdue('2000-01-01', 'todo')).toBe(true);
    expect(isTaskOverdue('2000-01-01', 'done')).toBe(false);
    expect(isTaskOverdue(null, 'todo')).toBe(false);
  });
});
