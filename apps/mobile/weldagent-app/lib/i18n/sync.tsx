import { useEffect } from 'react';

import { useI18n } from './provider';
import { persistLanguage } from './storage';

/** Cache the last resolved language so the next cold start can render it first. */
export function ProfileLanguageSync() {
  const { language } = useI18n();

  useEffect(() => {
    void persistLanguage(language);
  }, [language]);

  return null;
}
