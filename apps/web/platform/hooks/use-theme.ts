import { useState, useEffect, useCallback } from 'react';

type Theme = 'light' | 'dark' | 'system';

/**
 * Drop-in replacement for `useTheme()` from `next-themes`.
 * Reads/writes theme from localStorage and applies the class to `<html>`.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'system';
    return (localStorage.getItem('theme') as Theme) || 'system';
  });

  const resolvedTheme =
    theme === 'system'
      ? typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;

  const setTheme = useCallback((newTheme: string) => {
    const t = newTheme as Theme;
    setThemeState(t);
    localStorage.setItem('theme', t);

    const root = document.documentElement;
    root.classList.remove('light', 'dark');

    if (t === 'system') {
      const sys = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
      root.classList.add(sys);
    } else {
      root.classList.add(t);
    }
  }, []);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => setTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme, setTheme]);

  return {
    theme,
    setTheme,
    resolvedTheme,
    themes: ['light', 'dark', 'system'] as const,
  };
}
