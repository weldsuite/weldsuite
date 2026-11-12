import { useCallback } from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';

/** Copies text to the clipboard and says so (or that it could not). */
export function useCopy() {
  const { t } = useI18n();
  const tc = t.weldformsResults.common;
  return useCallback(
    async (text: string, successMessage?: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(successMessage ?? tc.copied);
      } catch {
        toast.error(tc.copyFailed);
      }
    },
    [tc.copied, tc.copyFailed],
  );
}
