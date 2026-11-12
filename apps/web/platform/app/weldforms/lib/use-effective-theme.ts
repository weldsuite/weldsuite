import { useMemo } from 'react';
import type { FormTheme } from '@weldsuite/app-api-client/schemas/weldforms';
import { useFormsSettings, useFormThemes } from '@/hooks/queries/use-weldforms-queries';

/**
 * The theme a form shows: the one it picked, else the workspace default, else
 * nothing (the renderer's own default look).
 */
export function useEffectiveTheme(themeId: string | null) {
  const themes = useFormThemes();
  const settings = useFormsSettings();
  return useMemo(() => {
    const list: FormTheme[] = themes.data ?? [];
    const picked = themeId ? list.find((th) => th.id === themeId) : undefined;
    const fallback = list.find((th) => th.id === settings.data?.defaultThemeId) ?? list.find((th) => th.isDefault);
    const theme = picked ?? fallback;
    return { theme, tokens: theme?.tokens, themes: list, defaultThemeId: settings.data?.defaultThemeId ?? fallback?.id ?? null, isLoading: themes.isLoading };
  }, [themes.data, themes.isLoading, settings.data, themeId]);
}
