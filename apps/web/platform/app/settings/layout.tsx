
import { useInstalledApps } from '@/hooks/use-installed-apps';
import { SettingsLayoutClient } from './settings-layout-client';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { data: apps } = useInstalledApps();
  const installedAppCodes = (apps || [])
    .filter(app => app.status === 'active')
    .map(app => app.appCode);

  return (
    <SettingsLayoutClient installedAppCodes={installedAppCodes}>
      {children}
    </SettingsLayoutClient>
  );
}
