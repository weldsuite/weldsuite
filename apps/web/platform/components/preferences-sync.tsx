import { useEffect, useRef } from 'react';
import { useUserPreferences, useWorkspaceSettings } from '@/hooks/queries/use-settings-queries';
import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/lib/i18n/provider';
import { languages, type Language } from '@/lib/i18n/locales';

/**
 * Syncs user preferences from the API to local state on app startup.
 * Resolution chain for language: user preference → workspace default → cookie/browser detection.
 * Renders nothing; runs once after the first successful fetch.
 */
export function PreferencesSync() {
  const { data: preferences } = useUserPreferences();
  const { data: workspaceSettings } = useWorkspaceSettings();
  const { setTheme } = useTheme();
  const { language, setLanguage } = useI18n();
  const hasSynced = useRef(false);

  useEffect(() => {
    if (!preferences || hasSynced.current) return;
    hasSynced.current = true;

    // Sync theme
    if (preferences.theme) {
      const currentTheme = localStorage.getItem('theme');
      if (currentTheme !== preferences.theme) {
        setTheme(preferences.theme);
      }
    }

    // Sync font size
    if (preferences.fontSize) {
      const currentFontSize = localStorage.getItem('fontSize');
      if (currentFontSize !== String(preferences.fontSize)) {
        localStorage.setItem('fontSize', String(preferences.fontSize));
        document.documentElement.style.fontSize = `${preferences.fontSize}px`;
      }
    }

    // Sync language: user preference → workspace default → keep current
    const userLang = preferences.language;
    const workspaceLang = workspaceSettings?.data?.language;

    const resolvedLang = (
      userLang && (languages as string[]).includes(userLang) ? userLang :
      workspaceLang && (languages as string[]).includes(workspaceLang) ? workspaceLang :
      null
    ) as Language | null;

    if (resolvedLang && language !== resolvedLang) {
      setLanguage(resolvedLang);
    }
  }, [preferences, workspaceSettings]);

  return null;
}
