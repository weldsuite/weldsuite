/**
 * Password health: weak, reused and old logins across the caller's vaults.
 *
 * The API opens the logins in memory to compare them and returns verdicts only,
 * so nothing on this page is a secret. Each flagged row links to the item.
 */

import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { usePermissions } from '@weldsuite/permissions/react';
import type {
  WeldPassPasswordIssue,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { AccessDeniedEmptyState } from '@/components/access-denied-empty-state';
import { PageLoader } from '@/components/page-loader';
import {
  useWeldPassHealth,
  useWeldPassVaults,
} from '@/hooks/queries/use-weldpass-passwords-queries';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorBanner, InlineSpinner, TimeAgo, errorMessage } from '../../components/shared';
import { ItemTypeIcon } from '../components/item-type-icon';
import { usePasswordsT } from '../lib/use-passwords-t';

const ISSUE_VARIANT: Record<WeldPassPasswordIssue, 'destructive' | 'warning' | 'secondary'> = {
  weak: 'destructive',
  reused: 'warning',
  old: 'secondary',
};

function Stat({
  label,
  value,
  tone,
}: Readonly<{ label: string; value: number; tone?: string }>) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold tabular-nums', tone)}>{value}</p>
    </Card>
  );
}

export default function WeldPassPasswordHealthPage() {
  const tp = usePasswordsT();
  const { can, isLoading } = usePermissions();

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (!can('passwords:use')) {
    return (
      <AccessDeniedEmptyState
        description={tp('accessDenied')}
        permission="passwords:use"
        pageLabel="WeldPass password health"
      />
    );
  }
  return <HealthReport />;
}

function HealthReport() {
  const tp = usePasswordsT();
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

  let body: React.ReactNode;
  if (isLoading) {
    body = <InlineSpinner />;
  } else if (error || !report) {
    body = (
      <div className="space-y-3">
        <ErrorBanner error={errorMessage(error, tp('health.loadFailed'))} />
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          {tp('retry')}
        </Button>
      </div>
    );
  } else if (report.checked === 0) {
    body = (
      <EmptyState
        title={tp('health.emptyTitle')}
        description={tp('health.emptyDescription')}
        action={
          <Button asChild>
            <Link to="/weldpass/passwords">{tp('health.goToPasswords')}</Link>
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label={tp('health.checked')} value={report.checked} />
          <Stat
            label={tp('health.healthy')}
            value={report.healthy}
            tone="text-emerald-600 dark:text-emerald-400"
          />
          <Stat
            label={tp('health.weak')}
            value={report.weak}
            tone={report.weak > 0 ? 'text-red-600 dark:text-red-400' : undefined}
          />
          <Stat
            label={tp('health.reused')}
            value={report.reused}
            tone={report.reused > 0 ? 'text-amber-600 dark:text-amber-400' : undefined}
          />
          <Stat label={tp('health.old')} value={report.old} />
        </div>

        {report.items.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-6 text-sm">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            {tp('health.allHealthy')}
          </div>
        ) : (
          <Card className="divide-y">
            <p className="px-4 py-2.5 text-xs font-medium text-muted-foreground">
              {tp('health.needsAttention', { count: report.items.length })}
            </p>
            {report.items.map((entry) => (
              <Link
                key={entry.id}
                to="/weldpass/passwords"
                search={{ item: entry.id }}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-sm transition-colors hover:bg-muted/40"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
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
                <span className="w-full text-xs sm:w-auto">
                  {entry.passwordChangedAt ? (
                    <>
                      {tp('health.changed')} <TimeAgo value={entry.passwordChangedAt} />
                    </>
                  ) : null}
                </span>
              </Link>
            ))}
          </Card>
        )}
      </>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
      <header className="space-y-1">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/weldpass/passwords">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            {tp('title')}
          </Link>
        </Button>
        <h1 className="text-lg font-semibold">{tp('health.title')}</h1>
        <p className="text-sm text-muted-foreground">{tp('health.subtitle')}</p>
      </header>

      {body}
    </div>
  );
}
