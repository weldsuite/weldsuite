import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import type { CheckPdfLabels } from '@/lib/weldbooks/check-pdf';

/** What is printed on a check and on the alignment test page, in the language of the screen. */
export function useCheckPdfLabels(): CheckPdfLabels {
  const { t } = useI18n();
  const labels = t.weldbooksUs.payments.checkPdf;
  return useMemo(() => ({ ...labels }), [labels]);
}
