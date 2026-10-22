import React, { createContext, useCallback, useContext, useMemo, useState, useEffect, ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import storage from '../utils/storage';
import { Colors } from '../constants/theme';

type ThemeType = 'light' | 'dark';

/** What the user picked. `system` follows the phone's light/dark setting. */
export type ThemePreference = 'system' | ThemeType;

interface ThemeContextType {
  /** The theme being rendered, with `system` already resolved. */
  theme: ThemeType;
  preference: ThemePreference;
  colors: typeof Colors.light;
  setPreference: (preference: ThemePreference) => Promise<void>;
  /** Pins light or dark, ignoring the phone setting from then on. */
  setTheme: (theme: ThemeType) => Promise<void>;
  toggleTheme: () => Promise<void>;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function ThemeProvider({ children }: Readonly<{ children: ReactNode }>) {
  const systemScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    void loadPreference();
  }, []);

  const loadPreference = async () => {
    try {
      const saved = await storage.getItem('theme');
      if (isThemePreference(saved)) {
        setPreferenceState(saved);
      }
    } catch (error) {
      console.error('Error loading theme:', error);
    }
  };

  const systemTheme: ThemeType = systemScheme === 'dark' ? 'dark' : 'light';
  const theme: ThemeType = preference === 'system' ? systemTheme : preference;

  const setPreference = useCallback(async (next: ThemePreference) => {
    try {
      setPreferenceState(next);
      await storage.setItem('theme', next);
    } catch (error) {
      console.error('Error saving theme:', error);
    }
  }, []);

  const toggleTheme = useCallback(async () => {
    await setPreference(theme === 'light' ? 'dark' : 'light');
  }, [theme, setPreference]);

  const value = useMemo(
    () => ({
      theme,
      preference,
      colors: Colors[theme],
      setPreference,
      setTheme: setPreference,
      toggleTheme,
    }),
    [theme, preference, setPreference, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

const defaultThemeContext: ThemeContextType = {
  theme: 'light',
  preference: 'system',
  colors: Colors.light,
  setPreference: async () => {},
  setTheme: async () => {},
  toggleTheme: async () => {},
};

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    return defaultThemeContext;
  }
  return context;
}
