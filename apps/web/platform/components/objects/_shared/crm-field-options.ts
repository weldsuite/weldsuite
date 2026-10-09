/**
 * Option lists for the CRM Details-tab pickers shared by the company and
 * person panels.
 */

import { useMemo } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useI18n } from '@/lib/i18n/provider';
import { LIFECYCLE_STAGES } from '@weldsuite/app-api-client/schemas/companies';
import type { SelectPropertyOption } from './select-property-row';

/**
 * Lifecycle stages, in funnel order. The values are the canonical list the
 * API validates writes against (`LIFECYCLE_STAGES`); labels are translated.
 */
export function useLifecycleStageOptions(): SelectPropertyOption[] {
  const st = useTranslations();
  return useMemo(
    () =>
      LIFECYCLE_STAGES.map((stage) => ({
        value: stage,
        label: st(`crm.customers.customerSections.lifecycleStages.${stage}`),
      })),
    [st],
  );
}

/** ISO 639-1 codes offered by the preferred-language picker. */
export const PREFERRED_LANGUAGE_CODES = [
  'en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'sv', 'da', 'nb', 'fi',
  'cs', 'sk', 'hu', 'ro', 'bg', 'el', 'hr', 'sl', 'sr', 'lt', 'lv', 'et',
  'tr', 'ru', 'uk', 'ar', 'he', 'fa', 'hi', 'zh', 'ja', 'ko', 'th', 'vi',
  'id', 'ms',
] as const;

function languageLabel(code: string, locale: string): string {
  try {
    const label = new Intl.DisplayNames([locale], { type: 'language' }).of(code);
    return label ? label.charAt(0).toLocaleUpperCase(locale) + label.slice(1) : code;
  } catch {
    return code;
  }
}

/** Languages as `{ value: code, label: localized name }`, sorted by name. */
export function useLanguageOptions(): SelectPropertyOption[] {
  const { language } = useI18n();
  const locale = language || 'en';
  return useMemo(() => {
    const collator = new Intl.Collator(locale);
    return PREFERRED_LANGUAGE_CODES.map((code) => ({ value: code, label: languageLabel(code, locale) })).sort(
      (a, b) => collator.compare(a.label, b.label),
    );
  }, [locale]);
}
