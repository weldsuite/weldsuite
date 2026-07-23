
import { useEffect } from 'react';

interface ThemeProviderProps {
  children: React.ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  useEffect(() => {
    // Read from localStorage (inline script in root layout already applied theme to prevent FOUC)
    const storedTheme = localStorage.getItem('theme') || 'system';
    const storedFontSize = localStorage.getItem('fontSize');

    applyTheme(storedTheme);
    if (storedFontSize) {
      document.documentElement.style.fontSize = `${storedFontSize}px`;
    }

    // Setup system theme listener for 'system' preference
    if (storedTheme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = (e: MediaQueryListEvent) => {
        document.documentElement.classList.remove('light', 'dark');
        document.documentElement.classList.add(e.matches ? 'dark' : 'light');
      };
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
  }, []);

  return <>{children}</>;
}

function applyTheme(theme: string) {
  const root = document.documentElement;

  if (theme === 'system') {
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    root.classList.remove('light', 'dark');
    root.classList.add(systemTheme);
  } else {
    root.classList.remove('light', 'dark');
    root.classList.add(theme);
  }
}
