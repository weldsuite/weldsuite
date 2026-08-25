import { useEffect, useRef } from 'react';

import { useClerkAuth } from '@weldsuite/mobile-ui/contexts/ClerkAuthContext';

import api from '@/services/api';

import { resolveAppLanguage } from './language';
import { useI18n } from './provider';
import { persistLanguage } from './storage';

/**
 * After sign-in, adopt the language stored on the user's WeldSuite profile
 * (`GET /api/user-preferences`). English and Dutch are honoured; anything else
 * falls back to English. The last resolved language is cached locally so the
 * next cold start can render in that language before the API responds.
 */
export function ProfileLanguageSync() {
  const { user } = useClerkAuth();
  const { language, setLanguage } = useI18n();
  const lastUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!user) {
      lastUserId.current = null;
      return;
    }
    const userId = user.id ?? 'signed-in';
    if (lastUserId.current === userId) return;
    lastUserId.current = userId;

    let cancelled = false;
    void (async () => {
      try {
        const preferences = await api.getUserPreferences();
        if (cancelled) return;
        const next = resolveAppLanguage(preferences.language);
        if (next !== language) setLanguage(next);
        await persistLanguage(next);
      } catch {
        await persistLanguage(language);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, language, setLanguage]);

  useEffect(() => {
    if (!user) return;
    void persistLanguage(language);
  }, [language, user]);

  return null;
}
