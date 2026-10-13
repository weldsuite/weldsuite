/**
 * Connecting a WeldHost domain to WeldReach: the shortcuts to buy or bring a
 * domain in WeldHost, and the list of the workspace's WeldHost domains with
 * the reason a domain cannot be connected (already connected, not active yet,
 * has email or a website, limit reached). Used by the setup wizard and the
 * "Connect domain" dialog.
 */

import { Loader2, ExternalLink, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import type { ReachDomain, ReachDomainCandidate } from '@weldsuite/app-api-client/schemas/reach';
import { Link } from '@/lib/router';
import { useConnectReachDomain } from '@/hooks/queries/use-reach-queries';
import { reachErrorMessage } from '@/lib/reach/errors';
import { EmptyPanel } from './page-kit';

/** WeldHost's own screens for getting a domain: buying one, or bringing one you already have. */
export const WELDHOST_BUY_DOMAIN_PATH = '/weldhost/domains/register';
export const WELDHOST_BRING_DOMAIN_PATH = '/weldhost/domains/external';

export function WeldHostDomainShortcuts({
  onRefresh,
  refreshing,
}: Readonly<{ onRefresh?: () => void; refreshing?: boolean }>) {
  const t = useTranslations();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild variant="outline" size="sm">
        <Link href={WELDHOST_BUY_DOMAIN_PATH}>
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
          {t('reach.setup.domains.buy')}
        </Link>
      </Button>
      <Button asChild variant="outline" size="sm">
        <Link href={WELDHOST_BRING_DOMAIN_PATH} title={t('reach.setup.domains.bringHint')}>
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
          {t('reach.setup.domains.bring')}
        </Link>
      </Button>
      {onRefresh && (
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={refreshing ? 'mr-1.5 h-3.5 w-3.5 animate-spin' : 'mr-1.5 h-3.5 w-3.5'} />
          {t('reach.setup.domains.refresh')}
        </Button>
      )}
    </div>
  );
}

export function DomainCandidateList({
  candidates,
  canConnect,
  onConnected,
}: Readonly<{
  candidates: ReachDomainCandidate[];
  canConnect: boolean;
  onConnected?: (domain: ReachDomain) => void;
}>) {
  const t = useTranslations();
  const connect = useConnectReachDomain();
  const connectingId = connect.isPending ? connect.variables?.hostDomainId : undefined;

  if (candidates.length === 0) {
    return <EmptyPanel title={t('reach.setup.domains.candidatesEmpty')} />;
  }

  const handleConnect = async (candidate: ReachDomainCandidate) => {
    try {
      const res = await connect.mutateAsync({ hostDomainId: candidate.hostDomainId });
      toast.success(t('reach.setup.domains.connected'));
      onConnected?.(res.data);
    } catch (error) {
      toast.error(reachErrorMessage(error, t));
    }
  };

  return (
    <ul className="divide-y rounded-lg border">
      {candidates.map((candidate) => (
        <li key={candidate.hostDomainId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0 space-y-0.5">
            <p className="truncate font-medium">{candidate.name}</p>
            {!candidate.eligible && candidate.reason && (
              <p className="max-w-xl text-sm text-muted-foreground">
                {t(`reach.mailboxes.reasons.${candidate.reason}`)}
              </p>
            )}
          </div>
          {candidate.eligible ? (
            <Button
              size="sm"
              disabled={!canConnect || connect.isPending}
              onClick={() => void handleConnect(candidate)}
            >
              {connectingId === candidate.hostDomainId && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {connectingId === candidate.hostDomainId ? t('reach.setup.domains.connecting') : t('reach.setup.domains.connect')}
            </Button>
          ) : (
            candidate.reason === 'already_connected' && (
              <Badge variant="success">{t('reach.status.domain.active')}</Badge>
            )
          )}
        </li>
      ))}
    </ul>
  );
}
