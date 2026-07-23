
import { SettingsClient } from './settings-client';
import { useHelpdeskSettings } from '@/hooks/queries/use-app-settings-queries';
import { PageLoader } from '@/components/page-loader';

export default function SettingsPage() {
  const { data, isLoading } = useHelpdeskSettings();

  if (isLoading) return <PageLoader fullScreen={false} />;

  return <SettingsClient initialSettings={data?.data || null} />;
}
