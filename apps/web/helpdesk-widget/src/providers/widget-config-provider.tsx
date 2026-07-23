/**
 * WidgetConfigProvider — Provides widget configuration to all child components.
 *
 * Replaces prop drilling of widgetId, themeSettings, enabledPages, branding,
 * office hours, bot agent, team info through 5+ layers of components.
 */

import { createContext, useContext } from 'react';
import type { PageConfig, OpenTeam, OpenWelcomeWorkflow } from '@/lib/api/types';

export interface WidgetThemeSettings {
  primaryColor?: string;
  backgroundColor?: string;
  textColor?: string;
  buttonColor?: string;
  buttonTextColor?: string;
  borderRadius?: string;
  fontSize?: string;
  launcherColor?: string;
  headerColor?: string;
  accentColor?: string;
  startingPage?: string;
  chatBackgroundColor?: string;
  userBubbleColor?: string;
  userBubbleTextColor?: string;
  agentBubbleColor?: string;
  agentBubbleTextColor?: string;
}

export interface WidgetConfig {
  widgetId: string;
  workspaceId?: string;
  themeSettings?: WidgetThemeSettings;
  enabledPages: string[];
  pageConfigs?: PageConfig[];
  showBranding?: boolean;
  disableBackNavigation?: boolean;
  parentOrigin?: string;
  // Office hours
  replyTimeText?: string;
  isWithinOfficeHours?: boolean;
  nextOpenTime?: string | null;
  officeHoursTimezone?: string | null;
  officeHours?: Record<string, { isOpen: boolean; openTime?: string; closeTime?: string }> | null;
  // Bot & team
  botAgent?: { name: string; avatarUrl: string | null } | null;
  team?: OpenTeam;
  welcomeWorkflow?: OpenWelcomeWorkflow | null;
}

const WidgetConfigContext = createContext<WidgetConfig | null>(null);

export function WidgetConfigProvider({
  children,
  ...config
}: WidgetConfig & { children: React.ReactNode }) {
  return (
    <WidgetConfigContext.Provider value={config}>
      {children}
    </WidgetConfigContext.Provider>
  );
}

export function useWidgetConfig(): WidgetConfig {
  const ctx = useContext(WidgetConfigContext);
  if (!ctx) throw new Error('useWidgetConfig must be used within WidgetConfigProvider');
  return ctx;
}
