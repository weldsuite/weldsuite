import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import storage from '../utils/storage';
import { Colors } from '../constants/theme';

type ThemeType = 'light' | 'dark';

interface ThemeContextType {
  theme: ThemeType;
  colors: typeof Colors.light;
  setTheme: (theme: ThemeType) => Promise<void>;
  toggleTheme: () => Promise<void>;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeType>('light');

  useEffect(() => {
    loadTheme();
  }, []);

  const loadTheme = async () => {
    try {
      const savedTheme = await storage.getItem('theme');
      if (savedTheme === 'dark' || savedTheme === 'light') {
        setThemeState(savedTheme);
      }
    } catch (error) {
      console.error('Error loading theme:', error);
    }
  };

  const setTheme = async (newTheme: ThemeType) => {
    try {
      setThemeState(newTheme);
      await storage.setItem('theme', newTheme);
    } catch (error) {
      console.error('Error saving theme:', error);
    }
  };

  const toggleTheme = async () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    await setTheme(newTheme);
  };

  const value = {
    theme,
    colors: Colors[theme],
    setTheme,
    toggleTheme,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

const defaultThemeContext: ThemeContextType = {
  theme: 'light',
  colors: Colors.light,
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
