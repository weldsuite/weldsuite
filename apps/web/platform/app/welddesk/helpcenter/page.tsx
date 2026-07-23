import { HelpcenterSettingsClient } from './helpcenter-settings-client';
import { useHelpcenterSettings } from '@/hooks/queries/use-helpdesk-queries';
import { PageLoader } from '@/components/page-loader';

export default function HelpcenterPage() {
  const { data, isLoading } = useHelpcenterSettings();

  if (isLoading) return <PageLoader fullScreen={false} />;

  return <HelpcenterSettingsClient initialSettings={data} />;
}
