
import { SettingsClient } from './settings-client';
import { useHelpdeskSettings } from '@/hooks/queries/use-app-settings-queries';
import { PageLoader } from '@/components/page-loader';
import type { HelpdeskSettingsData } from '@/hooks/queries/use-helpdesk-queries';

// `useHelpdeskSettings` only ever returns the server-persisted subset
// (tickets/satisfaction/automation/widgetSettings) — notifications and
// appearance have no backend storage yet, so they're seeded with sane
// client-side defaults here.
const DEFAULT_SETTINGS: HelpdeskSettingsData = {
  notifications: {
    emailNotifications: true,
    pushNotifications: true,
    soundNotifications: true,
  },
  appearance: {
    compactMode: false,
    enableAnimations: true,
  },
};

export default function SettingsPage() {
  const { data, isLoading } = useHelpdeskSettings();

  if (isLoading) return <PageLoader fullScreen={false} />;

  const initialSettings: HelpdeskSettingsData = {
    ...DEFAULT_SETTINGS,
    ...data?.data,
  };

  return <SettingsClient initialSettings={initialSettings} />;
}
