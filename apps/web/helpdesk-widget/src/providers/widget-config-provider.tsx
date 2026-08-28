import { createContext, useContext, type ReactNode } from 'react';

export interface WidgetConfig {
  widgetId: string;
  greeting: string;
  primaryColor: string;
  backgroundColor: string;
  position: 'right' | 'left';
  showBranding: boolean;
  parentOrigin?: string;
  realtimeUrl?: string;
}

const WidgetConfigContext = createContext<WidgetConfig | null>(null);

export function WidgetConfigProvider({
  value,
  children,
}: {
  value: WidgetConfig;
  children: ReactNode;
}) {
  return <WidgetConfigContext.Provider value={value}>{children}</WidgetConfigContext.Provider>;
}

export function useWidgetConfig(): WidgetConfig {
  const ctx = useContext(WidgetConfigContext);
  if (!ctx) throw new Error('useWidgetConfig must be used within WidgetConfigProvider');
  return ctx;
}
