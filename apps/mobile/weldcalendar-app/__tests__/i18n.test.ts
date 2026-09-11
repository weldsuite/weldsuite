import { interpolate, plural } from '@/lib/i18n/interpolate';
import { resolveAppLanguage } from '@/lib/i18n/language';
import { en } from '@/lib/i18n/locales/en';
import { nl } from '@/lib/i18n/locales/nl';
import { BRAND, EVENT_TYPE_COLORS, eventColor, tint } from '@/lib/brand';

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
    expect(interpolate('{count} events', { count: 3 })).toBe('3 events');
  });

  it('picks one vs other and injects the count', () => {
    expect(plural(1, en.agenda.eventCount)).toBe('1 event');
    expect(plural(3, en.agenda.eventCount)).toBe('3 events');
  });
});

describe('English and Dutch catalogs', () => {
  it('expose the same keys so a locale switch cannot miss a string', () => {
    expect(leafKeys(nl).sort()).toEqual(leafKeys(en).sort());
  });

  it('actually translates a representative sample rather than copying English', () => {
    expect(nl.tabs.month).toBe('Maand');
    expect(nl.eventType.meeting).toBe('Vergadering');
    expect(nl.settings.language).toBe('Taal');
    expect(nl.tabs.month).not.toBe(en.tabs.month);
  });
});

describe('brand tokens', () => {
  it('uses the WeldCalendar pink from the platform icon', () => {
    expect(BRAND).toBe('#FE466C');
    expect(tint(BRAND)).toBe('rgba(254,70,108,0.12)');
  });

  it('falls back to the type colour when an event has no override', () => {
    expect(eventColor('#123456', 'meeting')).toBe('#123456');
    expect(eventColor(null, 'call')).toBe(EVENT_TYPE_COLORS.call);
    expect(eventColor(null, 'something-new')).toBe(EVENT_TYPE_COLORS.other);
  });
});
