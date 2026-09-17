import { useMemo } from 'react';
import { useI18n } from '@weldsuite/i18n/provider';
import type { en } from '@weldsuite/i18n/locales/en';

type DeveloperT = (typeof en)['developer'];

/** Portal strings from the shared `developer` i18n namespace. */
export function useDeveloperI18n() {
  const { t, language, setLanguage, format } = useI18n();
  const developer = useMemo(() => t.developer as DeveloperT, [t]);
  return { t: developer, language, setLanguage, format };
}
