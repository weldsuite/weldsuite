
import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

interface WidgetPageSettings {
  pageHelp: boolean;
  pageChangelog: boolean;
  pageNews: boolean;
  pageAnnouncements: boolean;
}

interface WidgetSettingsContextType {
  settings: WidgetPageSettings;
  updateSettings: (settings: Partial<WidgetPageSettings>) => void;
}

const WidgetSettingsContext = createContext<WidgetSettingsContextType | null>(null);

const defaultSettings: WidgetPageSettings = {
  pageHelp: true,
  pageChangelog: false,
  pageNews: false,
  pageAnnouncements: false,
};

interface WidgetSettingsProviderProps {
  children: ReactNode;
  initialSettings?: WidgetPageSettings;
}

export function WidgetSettingsProvider({ children, initialSettings }: WidgetSettingsProviderProps) {
  const [settings, setSettings] = useState<WidgetPageSettings>(initialSettings ?? defaultSettings);

  const updateSettings = useCallback((newSettings: Partial<WidgetPageSettings>) => {
    setSettings(prev => ({ ...prev, ...newSettings }));
  }, []);

  return (
    <WidgetSettingsContext.Provider value={{ settings, updateSettings }}>
      {children}
    </WidgetSettingsContext.Provider>
  );
}

export function useWidgetSettings() {
  const context = useContext(WidgetSettingsContext);
  if (!context) {
    throw new Error('useWidgetSettings must be used within a WidgetSettingsProvider');
  }
  return context;
}
