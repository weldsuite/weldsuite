import { useMemo } from 'react';
import type { RaidKind } from '@weldsuite/app-api-client/domains/project-control';
import { useI18n } from '@/lib/i18n/provider';
import {
  SHOWS_CLOSED_ALWAYS,
  applyRegisterFilters,
  itemsOfKind,
  sortRegister,
} from '../_lib/raid';
import { isOpenItem } from '../_lib/risk';
import { useRaid } from './raid-context';
import { RaidEmptyState, RaidErrorState, RaidLoadingState } from './raid-states';
import { AssumptionsList, DependenciesList, IssuesList } from './register-lists';

type RegisterKind = Exclude<RaidKind, 'risk'>;

/** RAID › Assumptions, Issues or Dependencies: the register as the standard list, under the toolbar of the layout. */
export function RegisterPage({ kind }: Readonly<{ kind: RegisterKind }>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const { items, isLoading, isError, filters, showClosed } = useRaid();

  const all = useMemo(() => itemsOfKind(items, kind), [items, kind]);
  const alwaysShowClosed = SHOWS_CLOSED_ALWAYS[kind];

  const visible = useMemo(() => {
    const pool = alwaysShowClosed || showClosed ? all : all.filter(isOpenItem);
    return sortRegister(kind, applyRegisterFilters(pool, filters));
  }, [all, alwaysShowClosed, showClosed, filters, kind]);

  if (isLoading) return <RaidLoadingState />;
  if (isError) return <RaidErrorState />;
  if (all.length === 0) return <RaidEmptyState kind={kind} />;

  if (kind === 'assumption') return <AssumptionsList items={visible} emptyText={copy.register.noMatches} />;
  if (kind === 'issue') return <IssuesList items={visible} emptyText={copy.register.noMatches} />;
  return <DependenciesList items={visible} emptyText={copy.register.noMatches} />;
}

