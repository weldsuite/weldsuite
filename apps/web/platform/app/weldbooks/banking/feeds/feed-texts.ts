import { useCallback, useMemo } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import type { TranslationsType } from '@/lib/i18n/types';

export type FeedTexts = TranslationsType['weldbooksUs']['bankFeeds'];

export type FormatText = (template: string, values: Record<string, unknown>) => string;
export type PluralText = (count: number, forms: { other: string; one?: string }) => string;

/** The bank feed strings with the helpers every screen needs next to them. */
export function useFeedTexts() {
  const { t, language, format, plural } = useI18n();
  const texts = t.weldbooksUs.bankFeeds;

  /** "Plaid", "Enable Banking"; an unknown provider id shows as it is. */
  const providerName = useCallback(
    (id: string): string => (texts.providers as Record<string, string>)[id] ?? id,
    [texts],
  );

  return useMemo(
    () => ({ t: texts, language, format: format as FormatText, plural: plural as PluralText, providerName }),
    [texts, language, format, plural, providerName],
  );
}
