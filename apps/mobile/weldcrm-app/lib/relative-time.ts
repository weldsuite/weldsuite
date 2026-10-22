/**
 * "Today", "3 days ago", "2 weeks ago", "1 month ago" for list rows, in the
 * app language. Takes the translation catalog and a clock so it can be tested.
 */

import { interpolate } from './i18n/interpolate';
import type { Translations } from './i18n/locales/en';

const DAY_MS = 24 * 60 * 60 * 1000;

export function formatRelativeTime(
  value: string | null | undefined,
  t: Pick<Translations, 'common'>,
  locale: string,
  now: Date = new Date(),
): string {
  if (!value) return t.common.dash;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t.common.dash;

  const days = Math.floor((now.getTime() - date.getTime()) / DAY_MS);
  if (days <= 0) return t.common.today;
  if (days === 1) return t.common.yesterday;
  if (days < 7) return interpolate(t.common.daysAgo, { count: days });
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? t.common.weekAgo : interpolate(t.common.weeksAgo, { count: weeks });
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return months === 1 ? t.common.monthAgo : interpolate(t.common.monthsAgo, { count: months });
  }
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}
