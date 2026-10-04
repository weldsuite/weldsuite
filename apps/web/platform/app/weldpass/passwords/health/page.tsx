/**
 * Password health: weak, reused and old logins across the caller's vaults.
 *
 * The API opens the logins in memory to compare them and returns verdicts only,
 * so nothing on this page is a secret. Each flagged row links to the item.
 */

import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, Clock, Copy, ListChecks, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import type {
  WeldPassPasswordIssue,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { PageLoader } from '@/components/page-loader';
import {
  useWeldPassHealth,
  useWeldPassVaults,
} from '@/hooks/queries/use-weldpass-passwords-queries';
import { ErrorBanner, TimeAgo, errorMessage } from '../../components/shared';
import {
  DashboardPage,
  EmptyText,
  KpiCard,
  KpiGrid,
  SectionCard,
  usePassBreadcrumbs,
} from '../../components/page-kit';
import { ItemTypeIcon } from '../components/item-type-icon';
import { PasswordsGate } from '../components/passwords-gate';
import { usePasswordsT } from '../lib/use-passwords-t';

const ISSUE_VARIANT: Record<WeldPassPasswordIssue, 'destructive' | 'warning' | 'secondary'> = {
  weak: 'destructive',
  reused: 'warning',
  old: 'secondary',
};

export default function WeldPassPasswordHealthPage() {
  return (
    <PasswordsGate pageLabel="WeldPass password health">
      <HealthReport />
    </PasswordsGate>
  );
}

function HealthReport() {
  const tp = usePasswordsT();
  usePassBreadcrumbs(
    { label: tp('title'), href: '/weldpass/passwords' },
    { label: tp('health.title') },
  );

  const { data: report, isLoading, error, refetch } = useWeldPassHealth();
  const { data: vaults } = useWeldPassVaults();

  const vaultsById = useMemo(
    () => new Map<string, WeldPassVault>((vaults ?? []).map((vault) => [vault.id, vault])),
    [vaults],
  );

  function vaultName(vaultId: string) {
    const vault = vaultsById.get(vaultId);
    if (!vault) return '';
    return vault.kind === 'personal' ? tp('vaults.personal') : vault.name;
  }

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <DashboardPage title={tp('health.title')} description={tp('health.subtitle')}>
      {(error || !report) && (
        <div className="space-y-3">
          <ErrorBanner error={errorMessage(error, tp('health.loadFailed'))} />
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            {tp('retry')}
          </Button>
        </div>
      )}

      {report && (
        <>
          <KpiGrid>
            <KpiCard label={tp('health.checked')} value={report.checked} icon={ListChecks} />
            <KpiCard
              label={tp('health.healthy')}
              value={report.healthy}
              icon={ShieldCheck}
              tone={report.healthy > 0 ? 'success' : 'default'}
            />
            <KpiCard
              label={tp('health.weak')}
              value={report.weak}
              icon={ShieldAlert}
              tone={report.weak > 0 ? 'danger' : 'default'}
            />
            <KpiCard
              label={tp('health.reused')}
              value={report.reused}
              icon={Copy}
              tone={report.reused > 0 ? 'warning' : 'default'}
            />
            <KpiCard label={tp('health.old')} value={report.old} icon={Clock} />
          </KpiGrid>

          <SectionCard
            title={tp('health.attentionTitle')}
            description={report.items.length > 0 ? tp('health.attentionHint') : undefined}
            action={
              <Button asChild variant="ghost" size="sm">
                <Link to="/weldpass/passwords">{tp('health.goToPasswords')}</Link>
              </Button>
            }
          >
            {report.checked === 0 && <EmptyText>{tp('health.emptyDescription')}</EmptyText>}

            {report.checked > 0 && report.items.length === 0 && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                {tp('health.allHealthy')}
              </div>
            )}

            {report.items.length > 0 && (
              <ul className="space-y-2">
                {report.items.map((entry) => (
                  <li key={entry.id}>
                    <Link
                      to="/weldpass/passwords"
                      search={{ item: entry.id }}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md px-2 py-2 text-sm transition-colors hover:bg-muted/40"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <ItemTypeIcon type={entry.type} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{entry.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[entry.subtitle || entry.host, vaultName(entry.vaultId)]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {entry.issues.map((issue) => (
                          <Badge key={issue} variant={ISSUE_VARIANT[issue]}>
                            {issue === 'reused'
                              ? tp('health.issues.reused', { count: entry.reuseCount })
                              : tp(`health.issues.${issue}`)}
                          </Badge>
                        ))}
                      </span>
                      {entry.passwordChangedAt && (
                        <span className="w-full text-xs text-muted-foreground sm:w-auto">
                          {tp('health.changed')} <TimeAgo value={entry.passwordChangedAt} />
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </>
      )}
    </DashboardPage>
  );
}
