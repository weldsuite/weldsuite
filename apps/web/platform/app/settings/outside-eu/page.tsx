import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { hasOutsideEuServices, useOutsideEuServices } from '@/hooks/queries/use-outside-eu-queries';
import { hasAiSettings } from '@/lib/edition';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { groupServices } from './outside-eu-view';
import { OutsideEuServiceCard } from './service-card';

/**
 * Settings > Services outside the EU (the EU edition, ADR OPS-026): every
 * service outside the EU the platform can call for the workspace, each off
 * until a workspace owner or admin (`settings:manage`) switches it on behind
 * an acknowledgement. The backend refuses calls to a service that is off.
 * AI providers have their own switches in the AI settings (ADR AI-012).
 */
export default function OutsideEuSettingsPage() {
  const { t } = useI18n();
  const to = t.settings.outsideEu;
  const available = hasOutsideEuServices();
  const { data, isLoading, isError, refetch } = useOutsideEuServices();

  const header = (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">{to.title}</h1>
      <p className="text-muted-foreground">{to.description}</p>
    </div>
  );

  if (!available) {
    return (
      <div className="max-w-4xl space-y-6">
        {header}
        <InfoBanner variant="neutral">{to.notEnforcedNotice}</InfoBanner>
      </div>
    );
  }

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  if (isError || !data) {
    return <ErrorState message={to.loadFailed} onRetry={() => void refetch()} retryLabel={to.retry} />;
  }

  const groups = groupServices(data.services);

  return (
    <div className="max-w-4xl space-y-8">
      {header}

      {!data.enforced && <InfoBanner variant="neutral">{to.notEnforcedNotice}</InfoBanner>}
      {!data.canManage && <InfoBanner variant="neutral">{to.readOnlyNotice}</InfoBanner>}
      {hasAiSettings() && (
        <InfoBanner
          variant="neutral"
          action={
            <Link href="/settings/ai" className="text-sm font-medium underline underline-offset-4">
              {to.aiLink}
            </Link>
          }
        >
          {to.aiNote}
        </InfoBanner>
      )}

      {(
        [
          ['weldsuite', groups.weldsuite],
          ['workspace', groups.workspace],
        ] as const
      ).map(([group, services]) =>
        services.length > 0 ? (
          <SettingsSection key={group} title={to.sections[group].title} description={to.sections[group].description}>
            <div className="space-y-3">
              {services.map((service) => (
                <OutsideEuServiceCard key={service.id} service={service} canManage={data.canManage} />
              ))}
            </div>
          </SettingsSection>
        ) : null,
      )}

      <InfoBanner variant="neutral">{to.disabledNote}</InfoBanner>
    </div>
  );
}
