/**
 * Lookups from the stored values of a RAID item (statuses, categories,
 * ratings, intervals) to their translated labels. A stored value the locale has
 * no label for (a category typed by hand, a future status) is shown as stored.
 */

import type { TranslationsType } from '@weldsuite/i18n/types';
import type { PluralForms } from '@weldsuite/i18n/plural';
import type { RaidKind, RiskBand } from '@weldsuite/app-api-client/domains/project-control';
import type { DueStatus, ReviewInterval } from './risk';

export type RaidCopy = TranslationsType['projects']['raid'];

export type Plural = (count: number, forms: PluralForms) => string;
export type Format = (template: string, values: Record<string, unknown>) => string;

export const PROBABILITY_KEYS = ['rare', 'unlikely', 'possible', 'likely', 'almostCertain'] as const;
export const IMPACT_KEYS = ['negligible', 'minor', 'moderate', 'major', 'severe'] as const;

/** The name of a probability rating from 1 to 5 ("Likely"). */
export function probabilityName(copy: RaidCopy, rating: number): string {
  const key = PROBABILITY_KEYS[rating - 1];
  return key ? copy.probability.levels[key] : String(rating);
}

/** The name of an impact rating from 1 to 5 ("Major"). */
export function impactName(copy: RaidCopy, rating: number): string {
  const key = IMPACT_KEYS[rating - 1];
  return key ? copy.impact.levels[key] : String(rating);
}

export function statusLabel(copy: RaidCopy, kind: RaidKind, status: string): string {
  const labels = copy.status[kind] as Record<string, string>;
  return labels[status] ?? status;
}

export function bandLabel(copy: RaidCopy, band: RiskBand): string {
  return copy.bands[band];
}

export function categoryLabel(copy: RaidCopy, category: string | null): string | null {
  if (!category) return null;
  const labels = copy.categories as Record<string, string>;
  return labels[category.toLowerCase()] ?? category;
}

export function strategyLabel(copy: RaidCopy, strategy: string | null): string | null {
  if (!strategy) return null;
  const labels = copy.strategy as unknown as Record<string, { name: string } | undefined>;
  return labels[strategy]?.name ?? strategy;
}

export function severityLabel(copy: RaidCopy, severity: string | null): string | null {
  if (!severity) return null;
  const labels = copy.severity as unknown as Record<string, string>;
  return labels[severity] ?? severity;
}

export function confidenceLabel(copy: RaidCopy, confidence: string | null): string | null {
  if (!confidence) return null;
  const labels = copy.confidence as unknown as Record<string, string>;
  return labels[confidence] ?? confidence;
}

export function directionLabel(copy: RaidCopy, direction: string | null): string | null {
  if (!direction) return null;
  const labels = copy.direction as unknown as Record<string, string>;
  return labels[direction] ?? direction;
}

export function partyTypeLabel(copy: RaidCopy, partyType: string | null): string | null {
  if (!partyType) return null;
  const labels = copy.partyType as unknown as Record<string, string>;
  return labels[partyType] ?? partyType;
}

/** "every 2 weeks" for a review interval. */
export function reviewEveryLabel(copy: RaidCopy, interval: ReviewInterval, format: Format): string {
  if (interval.unit === 'days') return format(copy.due.every.days, { count: interval.days });
  return copy.due.every[interval.unit];
}

/** The text of a due date: "Overdue 2 days", "Today", "Tomorrow", "In 5 days". */
export function dueText(copy: RaidCopy, due: DueStatus, plural: Plural, format: Format): string {
  switch (due.kind) {
    case 'none':
      return copy.due.none;
    case 'overdue':
      return plural(due.days, copy.due.overdue);
    case 'today':
      return copy.due.today;
    case 'tomorrow':
      return copy.due.tomorrow;
    case 'in':
      return format(copy.due.inDays, { count: due.days });
  }
}
