import { Loader2 } from 'lucide-react';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ReachDomain } from '@weldsuite/app-api-client/schemas/reach';
import { useReachAccess, useReachDomainCandidates } from '@/hooks/queries/use-reach-queries';
import { DomainCandidateList, WeldHostDomainShortcuts } from '../components/domain-candidates';
import { DomainStatusBadge } from '../components/status';
import { ErrorPanel } from '../components/page-kit';
import { StepFooter, StepFrame } from './setup-shell';

export function DomainsStep({
  domains,
  canConnect,
  onBack,
  onNext,
  onSkip,
}: Readonly<{
  domains: ReachDomain[];
  canConnect: boolean;
  onBack: () => void;
  onNext: () => void;
  onSkip: () => void;
}>) {
  const t = useTranslations();
  const candidates = useReachDomainCandidates();
  const access = useReachAccess();
  const limit = access.data?.limits.maxDomains;
  const hasDomain = domains.length > 0;

  return (
    <StepFrame title={t('reach.setup.domains.title')} description={t('reach.setup.domains.description')}>
      <WeldHostDomainShortcuts onRefresh={() => void candidates.refetch()} refreshing={candidates.isFetching} />
      <p className="text-xs text-muted-foreground">{t('reach.setup.domains.bringHint')}</p>

      {hasDomain && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('reach.setup.domains.connectedList')}</h3>
          <ul className="divide-y rounded-lg border">
            {domains.map((domain) => (
              <li key={domain.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="truncate font-medium">{domain.name}</span>
                <DomainStatusBadge status={domain.status} />
              </li>
            ))}
          </ul>
          {limit !== undefined && (
            <p className="text-xs text-muted-foreground">
              {t('reach.setup.domains.limitHint', { used: domains.length, limit })}
            </p>
          )}
        </div>
      )}
      {!hasDomain && (
        <InfoBanner variant="info">{t('reach.setup.domains.noneConnected')}</InfoBanner>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t('reach.setup.domains.candidatesTitle')}</h3>
        {candidates.isPending && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('reach.common.loading')}
          </div>
        )}
        {candidates.isError && <ErrorPanel onRetry={() => void candidates.refetch()} />}
        {candidates.data && <DomainCandidateList candidates={candidates.data} canConnect={canConnect} />}
      </div>

      <StepFooter onBack={onBack} onNext={onNext} nextDisabled={!hasDomain} onSkip={hasDomain ? undefined : onSkip} />
    </StepFrame>
  );
}
