import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n/provider';

/** Formats an ISO timestamp as a localized date and time ('' for null). */
export function useDateTime(timeStyle: 'short' | 'medium' = 'short'): (iso: string | null) => string {
  const { language } = useI18n();
  return useMemo(() => {
    const formatter = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle });
    return (iso) => (iso ? formatter.format(new Date(iso)) : '');
  }, [language, timeStyle]);
}
