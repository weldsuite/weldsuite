/**
 * Password health: weak, reused and old logins across the caller's vaults.
 *
 * The API opens the logins in memory to compare them and returns verdicts only,
 * so nothing on this page is a secret. Each flagged row links to the item.
 */

import { useMemo } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { SearchX, ShieldCheck } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import type {
  WeldPassHealthEntry,
  WeldPassPasswordIssue,
  WeldPassVault,
} from '@weldsuite/app-api-client/domains/weldpass-passwords';
import { PageLoader } from '@/components/page-loader';
import {
  PanelEntityList,
  type ColumnDef,
  type GroupConfig,
} from '@/components/panel-entity-list';
import {
  useWeldPassHealth,
  useWeldPassVaults,
} from '@/hooks/queries/use-weldpass-passwords-queries';
import { formatDateTime } from '@/lib/utils';
import { ErrorBanner, errorMessage } from '../../components/shared';
import { emptyIcon, usePassBreadcrumbs } from '../../components/page-kit';
import { PasswordsGate } from '../components/passwords-gate';
import { usePasswordsT } from '../lib/use-passwords-t';

const ISSUE_VARIANT: Record<WeldPassPasswordIssue, 'destructive' | 'warning' | 'secondary'> = {
  weak: 'destructive',
  reused: 'warning',
  old: 'secondary',
};

/** Worst first. A login with several issues is listed under its worst one. */
const ISSUE_ORDER: WeldPassPasswordIssue[] = ['weak', 'reused', 'old'];

function worstIssue(entry: WeldPassHealthEntry): WeldPassPasswordIssue | undefined {
  return ISSUE_ORDER.find((issue) => entry.issues.includes(issue));
}

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

  const navigate = useNavigate();
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

  const columns: ColumnDef<WeldPassHealthEntry>[] = [
    {
      id: 'title',
      header: tp('table.name'),
      width: 'flex-1',
      render: (entry) => <span className="block truncate font-medium">{entry.title}</span>,
    },
    {
      id: 'issues',
      header: tp('health.issuesColumn'),
      width: 'w-[240px]',
      render: (entry) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {entry.issues.map((issue) => (
            <Badge key={issue} variant={ISSUE_VARIANT[issue]}>
              {issue === 'reused'
                ? tp('health.issues.reused', { count: entry.reuseCount })
                : tp(`health.issues.${issue}`)}
            </Badge>
          ))}
        </span>
      ),
    },
    {
      id: 'site',
      header: tp('table.site'),
      width: 'hidden md:block md:w-[200px]',
      render: (entry) => (
        <span className="block truncate text-muted-foreground">{entry.host ?? '—'}</span>
      ),
    },
    {
      id: 'vault',
      header: tp('table.vault'),
      width: 'hidden lg:block lg:w-[160px]',
      render: (entry) => (
        <span className="block truncate text-muted-foreground">
          {vaultName(entry.vaultId) || '—'}
        </span>
      ),
    },
    {
      id: 'changed',
      header: tp('health.changed'),
      width: 'hidden md:block md:w-[200px]',
      render: (entry) => (
        <span className="whitespace-nowrap font-mono text-sm text-muted-foreground">
          {entry.passwordChangedAt ? formatDateTime(entry.passwordChangedAt) : '—'}
        </span>
      ),
    },
  ];

  // One section per issue, each with its count, in place of summary cards.
  const groups: GroupConfig<WeldPassHealthEntry>[] = ISSUE_ORDER.map((issue, index) => ({
    id: issue,
    label: tp(`health.${issue}`),
    filter: (entry) => worstIssue(entry) === issue,
    sortOrder: index,
  }));

  if (isLoading) return <PageLoader fullScreen={false} />;

  // Nothing checked yet reads differently from everything checked and fine.
  const emptyState =
    report && report.checked > 0
      ? {
          icon: emptyIcon(ShieldCheck),
          title: tp('health.attentionTitle'),
          description: tp('health.allHealthy'),
        }
      : {
          icon: emptyIcon(ShieldCheck),
          title: tp('health.attentionTitle'),
          description: tp('health.emptyDescription'),
        };

  if (error || !report) {
    return (
      <div className="space-y-3 p-6">
        <ErrorBanner error={errorMessage(error, tp('health.loadFailed'))} />
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          {tp('retry')}
        </Button>
      </div>
    );
  }

  return (
    <PanelEntityList<WeldPassHealthEntry>
      items={report.items}
      isLoading={false}
      columns={columns}
      groups={groups}
      onRowClick={(entry) =>
        void navigate({ to: '/weldpass/passwords', search: { item: entry.id } })
      }
      searchFields={['title']}
      searchPlaceholder={tp('toolbar.search')}
      leftActionButtons={<span className="text-sm font-medium">{tp('health.attentionTitle')}</span>}
      actionButtons={
        <Button asChild variant="outline" size="sm" className="h-8">
          <Link to="/weldpass/passwords">{tp('health.goToPasswords')}</Link>
        </Button>
      }
      emptyState={emptyState}
      noResultsState={{
        icon: emptyIcon(SearchX),
        title: tp('empty.noResultsTitle'),
        description: tp('empty.noResultsDescription'),
      }}
    />
  );
}
