import { useMemo, useState } from 'react';
import type { RaidItem, RaidKind } from '@weldsuite/app-api-client/domains/project-control';
import { useI18n } from '@/lib/i18n/provider';
import {
  EMPTY_FILTERS,
  applyRegisterFilters,
  assumptionStats,
  dependencyStats,
  issueStats,
  itemsOfKind,
  ownerIdsOf,
  sortRegister,
  statusesOf,
  type RegisterFilters,
} from '../_lib/raid';
import { isOpenItem } from '../_lib/risk';
import { useRaid } from './raid-context';
import { SummaryTile } from './raid-parts';
import { RaidEmptyState, RaidErrorState, RaidLoadingState } from './raid-states';
import { RaidToolbar } from './raid-toolbar';
import { AssumptionsTable, DependenciesTable, IssuesTable } from './register-tables';

type RegisterKind = Exclude<RaidKind, 'risk'>;

/** Assumptions stay in the list once validated or proved wrong; the other registers hide closed items on request. */
const SHOWS_CLOSED_ALWAYS: Readonly<Record<RegisterKind, boolean>> = {
  assumption: true,
  issue: false,
  dependency: false,
};

/** The summary tiles of a register. */
function RegisterTiles({ kind, items }: Readonly<{ kind: RegisterKind; items: RaidItem[] }>) {
  const { t, plural } = useI18n();
  const copy = t.projects.raid.tiles;
  const { now } = useRaid();

  if (kind === 'assumption') {
    const stats = assumptionStats(items, now);
    return (
      <>
        <SummaryTile label={copy.assumptions} value={stats.total} />
        <SummaryTile label={copy.toValidate} value={stats.toValidate} />
        <SummaryTile label={copy.dueSoon} value={stats.dueSoon} tone={stats.dueSoon > 0 ? 'warning' : undefined} />
        <SummaryTile label={copy.provedWrong} value={stats.provedWrong} tone={stats.provedWrong > 0 ? 'danger' : undefined} />
      </>
    );
  }
  if (kind === 'issue') {
    const stats = issueStats(items, now);
    return (
      <>
        <SummaryTile label={copy.openIssues} value={stats.open} />
        <SummaryTile label={copy.critical} value={stats.critical} tone={stats.critical > 0 ? 'danger' : undefined} />
        <SummaryTile label={copy.escalated} value={stats.escalated} tone={stats.escalated > 0 ? 'danger' : undefined} />
        <SummaryTile label={copy.averageAge} value={stats.averageAgeDays === null ? '—' : plural(stats.averageAgeDays, copy.days)} />
      </>
    );
  }
  const stats = dependencyStats(items, now);
  return (
    <>
      <SummaryTile label={copy.weNeed} value={stats.weNeed} />
      <SummaryTile label={copy.theyNeed} value={stats.theyNeed} />
      <SummaryTile label={copy.late} value={stats.late} tone={stats.late > 0 ? 'danger' : undefined} />
      <SummaryTile label={copy.atRisk} value={stats.atRisk} tone={stats.atRisk > 0 ? 'warning' : undefined} />
    </>
  );
}

/** RAID › Assumptions, Issues or Dependencies: a toolbar, summary tiles and the table. */
export function RegisterPage({ kind }: Readonly<{ kind: RegisterKind }>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const { items, isLoading, isError } = useRaid();

  const [filters, setFilters] = useState<RegisterFilters>(EMPTY_FILTERS);
  const [showClosed, setShowClosed] = useState(false);

  const all = useMemo(() => itemsOfKind(items, kind), [items, kind]);
  const closedCount = all.filter((item) => !isOpenItem(item)).length;
  const alwaysShowClosed = SHOWS_CLOSED_ALWAYS[kind];

  const visible = useMemo(() => {
    const pool = alwaysShowClosed || showClosed ? all : all.filter(isOpenItem);
    return sortRegister(kind, applyRegisterFilters(pool, filters));
  }, [all, alwaysShowClosed, showClosed, filters, kind]);

  if (isLoading) return <RaidLoadingState />;
  if (isError) return <RaidErrorState />;
  if (all.length === 0) return <RaidEmptyState kind={kind} />;

  return (
    <div className="flex flex-col gap-4">
      <RaidToolbar
        kind={kind}
        filters={filters}
        onFiltersChange={setFilters}
        statuses={statusesOf(kind)}
        ownerIds={ownerIdsOf(all)}
        hasUnowned={all.some((item) => !item.ownerId)}
        closedCount={closedCount}
        showClosed={showClosed}
        onToggleClosed={alwaysShowClosed ? undefined : () => setShowClosed((value) => !value)}
      />

      <p className="max-w-3xl text-[13px] leading-relaxed text-muted-foreground">{copy.intro[kind]}</p>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(11.5rem,1fr))]">
        <RegisterTiles kind={kind} items={all} />
      </div>

      {kind === 'assumption' ? <AssumptionsTable items={visible} emptyText={copy.register.noMatches} /> : null}
      {kind === 'issue' ? <IssuesTable items={visible} emptyText={copy.register.noMatches} /> : null}
      {kind === 'dependency' ? <DependenciesTable items={visible} emptyText={copy.register.noMatches} /> : null}
    </div>
  );
}
