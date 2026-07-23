
import { useCallback, createContext, useContext } from 'react';
import { useRouter, usePathname } from '@/lib/router';
import { useSettingsHotkey } from '@/hooks/use-settings-hotkey';
interface SettingsContextType {
  openSettings: (section?: string) => void;
  closeSettings: () => void;
}

interface SettingsProviderProps {
  children: React.ReactNode;
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within SettingsProvider');
  }
  return context;
}

// Map section IDs to routes
const sectionToRoute: Record<string, string> = {
  'profile': '/settings',
  'appearance': '/settings/appearance',
  'notifications': '/settings/notifications',
  'shortcuts': '/settings/shortcuts',
  'team': '/settings/team',
  'api-keys': '/settings/api-keys',
  'plans': '/settings/plans',
  'business': '/settings/business',
  'security': '/settings/security',
  'privacy': '/settings/privacy',
  'activity': '/settings/activity',
  'integrations': '/settings/integrations',
  'export': '/settings/export',
  'advanced': '/settings/advanced',
  'helpdesk-settings': '/settings/apps/welddesk',
};

export function SettingsProvider({ children }: SettingsProviderProps) {
  const router = useRouter();
  const pathname = usePathname();

  const openSettings = useCallback((section?: string) => {
    // Store current page so the settings back button can return here
    if (!pathname?.startsWith('/settings')) {
      sessionStorage.setItem('settings-return-url', pathname || '/');
    }
    const route = section ? sectionToRoute[section] || '/settings' : '/settings';
    router.push(route);
  }, [router, pathname]);

  const closeSettings = useCallback(() => {
    router.back();
  }, [router]);

  // Setup keyboard shortcut for settings (Cmd/Ctrl + ,)
  useSettingsHotkey(openSettings);

  return (
    <SettingsContext.Provider value={{ openSettings, closeSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}
