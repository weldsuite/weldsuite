import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import { interpolate } from '@weldsuite/i18n/provider';
import { plural as pluralFor } from '@weldsuite/i18n/plural';
import { RAID_STATUSES } from '@weldsuite/app-api-client/schemas/project-control';
import {
  bandLabel,
  categoryLabel,
  dueText,
  impactName,
  probabilityName,
  reviewEveryLabel,
  statusLabel,
  strategyLabel,
} from './copy';
import { RATINGS, RISK_BANDS, RISK_CATEGORIES } from './risk';

/** Every leaf of a translation tree as a dotted path. */
function leafPaths(tree: unknown, prefix = ''): string[] {
  if (tree === null || typeof tree !== 'object') return [prefix];
  return Object.entries(tree).flatMap(([key, value]) => leafPaths(value, prefix ? `${prefix}.${key}` : key));
}

describe('RAID translations', () => {
  it('has the same keys in English and Dutch', () => {
    const english = leafPaths(en.projects.raid).sort();
    const dutch = leafPaths(nl.projects.raid).sort();
    expect(dutch).toEqual(english);
  });

  it('leaves no placeholder or empty string in Dutch', () => {
    for (const path of leafPaths(nl.projects.raid)) {
      const value = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], nl.projects.raid);
      expect(typeof value === 'string' && value.trim().length > 0, path).toBe(true);
      expect(String(value), path).not.toMatch(/\[TRANSLATE\]|\[REVIEW\]|TODO|FIXME/);
    }
  });

  it('keeps the same {placeholders} in both languages', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const path of leafPaths(en.projects.raid)) {
      const read = (tree: unknown) => path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], tree);
      expect(placeholders(String(read(nl.projects.raid))), path).toEqual(placeholders(String(read(en.projects.raid))));
    }
  });

  it('labels the RAID tab and its breadcrumbs', () => {
    expect(en.projects.projectLayout.tabs.raid).toBe('RAID');
    expect(nl.projects.projectLayout.tabs.raid).toBe('RAID');
    for (const key of ['raid', 'assumptions', 'issues', 'dependencies'] as const) {
      expect(en.projects.projectLayout.routeLabels[key]).toBeTruthy();
      expect(nl.projects.projectLayout.routeLabels[key]).toBeTruthy();
    }
  });

  it('has a label for every status of every kind', () => {
    for (const copy of [en.projects.raid, nl.projects.raid]) {
      for (const [kind, statuses] of Object.entries(RAID_STATUSES)) {
        for (const status of statuses) {
          expect((copy.status as Record<string, Record<string, string>>)[kind][status], `${kind}.${status}`).toBeTruthy();
        }
      }
    }
  });

  it('has a label for every band, rating and category', () => {
    for (const copy of [en.projects.raid, nl.projects.raid]) {
      for (const band of RISK_BANDS) expect(bandLabel(copy, band)).toBeTruthy();
      for (const rating of RATINGS) {
        expect(probabilityName(copy, rating)).not.toBe(String(rating));
        expect(impactName(copy, rating)).not.toBe(String(rating));
      }
      for (const category of RISK_CATEGORIES) expect(categoryLabel(copy, category)).not.toBe(category);
    }
  });
});

describe('copy lookups', () => {
  const copy = en.projects.raid;

  it('shows a value the locale does not know as it was stored', () => {
    expect(statusLabel(copy, 'risk', 'mitigating')).toBe('Mitigating');
    expect(statusLabel(copy, 'risk', 'brand-new')).toBe('brand-new');
    expect(categoryLabel(copy, 'Technical')).toBe('Technical');
    expect(categoryLabel(copy, 'Legal')).toBe('Legal');
    expect(categoryLabel(copy, null)).toBeNull();
    expect(strategyLabel(copy, 'accept')).toBe('Accept');
    expect(strategyLabel(copy, 'unknown')).toBe('unknown');
    expect(probabilityName(copy, 4)).toBe('Likely');
    expect(impactName(copy, 5)).toBe('Severe');
    expect(probabilityName(copy, 9)).toBe('9');
  });

  it('words due dates and review intervals in both languages', () => {
    for (const [language, text] of [['en', en.projects.raid], ['nl', nl.projects.raid]] as const) {
      const plural = (count: number, forms: Parameters<typeof pluralFor>[1]) => pluralFor(count, forms, language);
      expect(dueText(text, { kind: 'overdue', days: 2 }, plural, interpolate)).toContain('2');
      expect(dueText(text, { kind: 'in', days: 5 }, plural, interpolate)).toContain('5');
      expect(dueText(text, { kind: 'today' }, plural, interpolate)).toBe(text.due.today);
      expect(dueText(text, { kind: 'none' }, plural, interpolate)).toBe(text.due.none);
      expect(reviewEveryLabel(text, { unit: 'days', days: 10 }, interpolate)).toContain('10');
      expect(reviewEveryLabel(text, { unit: 'twoWeeks' }, interpolate)).toBe(text.due.every.twoWeeks);
    }
    const plural = (count: number, forms: Parameters<typeof pluralFor>[1]) => pluralFor(count, forms, 'en');
    expect(dueText(copy, { kind: 'overdue', days: 1 }, plural, interpolate)).toBe('Overdue 1 day');
    expect(dueText(copy, { kind: 'overdue', days: 3 }, plural, interpolate)).toBe('Overdue 3 days');
  });
});
