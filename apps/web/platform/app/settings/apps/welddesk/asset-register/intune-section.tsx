import { useCan } from '@weldsuite/permissions/react';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { useAssetSources } from '@/hooks/queries/use-asset-source-queries';
import { useCustomObjectTemplates } from '@/hooks/queries/use-custom-objects-queries';
import { useI18n } from '@/lib/i18n/provider';
import { IntuneConnectForm } from './intune-connect-form';
import { IntuneConnected } from './intune-connected';

/**
 * Settings → Apps → WeldDesk → Asset register → Microsoft Intune. Needs
 * `weldobjects:manage` (the API refuses everything else), so other members see
 * nothing. Not connected: the setup steps and the form. Connected: the status
 * of the import. One Intune source per workspace is shown; the API allows one
 * per app registration.
 */
export function IntuneSection() {
  const canManage = useCan('weldobjects:manage');
  if (!canManage) return null;
  return <IntuneContent />;
}

function IntuneContent() {
  const { t } = useI18n();
  const ta = t.assetSources;
  const templates = useCustomObjectTemplates();
  const sources = useAssetSources();

  const registerInstalled = templates.data?.some((template) => template.key === 'asset' && template.installed) ?? false;
  const source = sources.data?.[0] ?? null;

  let body: React.ReactNode;
  if (sources.isLoading || templates.isLoading) {
    body = (
      <div className="flex justify-center py-6">
        <InlineSpinner />
      </div>
    );
  } else if (sources.isError) {
    body = <ErrorState message={ta.loadFailed} onRetry={() => void sources.refetch()} />;
  } else if (source) {
    return <IntuneConnected source={source} />;
  } else if (!registerInstalled) {
    body = <InfoBanner variant="info">{ta.registerMissing}</InfoBanner>;
  } else {
    body = <IntuneConnectForm />;
  }

  return (
    <SectionCard title={ta.intune.title} description={ta.intune.description}>
      {body}
    </SectionCard>
  );
}
