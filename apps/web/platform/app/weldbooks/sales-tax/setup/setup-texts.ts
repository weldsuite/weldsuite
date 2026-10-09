import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import type { TranslationsType } from '@/lib/i18n/types';

/** The sales tax setup strings: `t.weldbooksUs.salesTax.setup`. */
export type SetupTexts = TranslationsType['weldbooksUs']['salesTax']['setup'];
export type ValidationTexts = SetupTexts['validation'];

export type FormatText = (template: string, values: Record<string, unknown>) => string;
export type PluralText = (count: number, forms: { other: string; one?: string }) => string;

/** The setup strings with the helpers every screen needs next to them. */
export function useSetupTexts() {
  const { t, language, format, plural } = useI18n();
  const texts = t.weldbooksUs.salesTax.setup;
  return useMemo(
    () => ({ t: texts, language, format: format as FormatText, plural: plural as PluralText }),
    [texts, language, format, plural],
  );
}
