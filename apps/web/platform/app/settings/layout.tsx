import { SettingsLayoutClient } from './settings-layout-client';

export default function SettingsLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <SettingsLayoutClient>{children}</SettingsLayoutClient>;
}
