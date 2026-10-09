import { getLoadedTranslations } from '@weldsuite/i18n/locales';
import { useI18n } from '@/lib/i18n/provider';

/** The texts of sales tax on documents (`weldbooksUs.salesTax.documents`). */
export type DocumentTexts = ReturnType<typeof getLoadedTranslations>['weldbooksUs']['salesTax']['documents'];

/**
 * The sales tax on documents texts in the user's language. Spanish and French
 * have no US bookkeeping texts yet, and the invoice, bill and journal screens
 * they already use must not fail on that: those fall back to English.
 */
export function useDocumentTexts(): DocumentTexts {
  const { t } = useI18n();
  // `weldbooksUs` is missing from the partial locales although the type says it is there.
  const own = (t as { weldbooksUs?: { salesTax?: { documents?: DocumentTexts } } }).weldbooksUs?.salesTax?.documents;
  return own ?? getLoadedTranslations('en').weldbooksUs.salesTax.documents;
}
