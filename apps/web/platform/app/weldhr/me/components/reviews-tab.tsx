/**
 * My HR → Performance → Evaluations and Coaching: what your manager and
 * coach shared with you, the ones to acknowledge first. Acknowledging sits in
 * the row menu and the panel; the panel shows the whole evaluation or session.
 */

import { useState } from 'react';
import { CheckCheck, ClipboardCheck, MessagesSquare } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { DropdownMenuItem } from '@weldsuite/ui/components/dropdown-menu';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrSelfCoachingLog, HrSelfEvaluation } from '@weldsuite/app-api-client/domains/weldhr';
import { useObjectPanel } from '@/components/object-panel';
import { MY_COACHING_PANEL_TYPE, MY_EVALUATION_PANEL_TYPE } from '@/components/objects/hr-my-hr/types';
import {
  PanelEntityList,
  type ActiveFilter,
  type ColumnDef,
  type FilterConfig,
  type GroupConfig,
} from '@/components/panel-entity-list';
import { useMyHrCoaching, useMyHrEvaluations } from '@/hooks/queries/use-weldhr-queries';
import { cn } from '@/lib/utils';
import { HR_COL, HrListContainer, emptyIcon } from '../../components/page-kit';
import { ScoreBadge, StatusBadge, errorMessage, formatDate } from '../../components/shared';
import { AcknowledgeDialog, type AcknowledgeTarget } from './acknowledge-dialog';

/** An evaluation shared with you that you have not acknowledged yet. */
export function evaluationToAcknowledge(evaluation: HrSelfEvaluation): boolean {
  return evaluation.status === 'submitted' && !evaluation.acknowledgedAt;
}

/** A coaching session you have not acknowledged yet. */
export function coachingToAcknowledge(log: HrSelfCoachingLog): boolean {
  return !log.acknowledgedAt;
}

/** "1 Oct 2026 – 31 Dec 2026", or a dash without a period. */
export function evaluationPeriod(evaluation: HrSelfEvaluation): string {
  return evaluation.periodStart || evaluation.periodEnd
    ? `${formatDate(evaluation.periodStart)} – ${formatDate(evaluation.periodEnd)}`
    : '—';
}

/** "Acknowledge" for the row and panel menus. */
export function AcknowledgeMenuItem({ onSelect }: Readonly<{ onSelect: () => void }>) {
  const t = useTranslations();
  return (
    <DropdownMenuItem onClick={onSelect}>
      <CheckCheck />
      {t('weldhr.me.reviews.acknowledge')}
    </DropdownMenuItem>
  );
}

/** Distinct non-empty values, sorted, as filter options. */
function optionsOf(values: Array<string | null>): Array<{ value: string; label: string }> {
  return [...new Set(values.filter((v): v is string => !!v))].sort().map((value) => ({ value, label: value }));
}

export function MyEvaluationsList() {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrEvaluations();
  const { open: openPanel } = useObjectPanel();
  const [acknowledging, setAcknowledging] = useState<AcknowledgeTarget | null>(null);
  const evaluations = data ?? [];

  const groups: GroupConfig<HrSelfEvaluation>[] = [
    { id: 'toAcknowledge', label: t('weldhr.me.reviews.groups.toAcknowledge'), sortOrder: 1, filter: evaluationToAcknowledge },
    { id: 'earlier', label: t('weldhr.me.reviews.groups.earlier'), sortOrder: 2, filter: (e) => !evaluationToAcknowledge(e) },
  ];

  const evaluators = optionsOf(evaluations.map((e) => e.evaluatorName));
  const filters: FilterConfig[] = [
    {
      field: 'status',
      label: t('weldhr.me.reviews.evaluations.table.status'),
      operators: ['is'],
      options: (['submitted', 'acknowledged'] as const).map((status) => ({ value: status, label: t(`weldhr.status.evaluation.${status}`) })),
    },
    ...(evaluators.length > 0
      ? [{ field: 'evaluator', label: t('weldhr.me.reviews.evaluations.table.evaluator'), operators: ['is'], options: evaluators }]
      : []),
  ];

  const applyFilters = (rows: HrSelfEvaluation[], active: ActiveFilter[]) =>
    active.reduce((list, filter) => {
      if (!filter.value) return list;
      if (filter.field === 'status') return list.filter((e) => e.status === filter.value);
      if (filter.field === 'evaluator') return list.filter((e) => e.evaluatorName === filter.value);
      return list;
    }, rows);

  const columns: ColumnDef<HrSelfEvaluation>[] = [
    {
      id: 'evaluation',
      header: t('weldhr.me.reviews.evaluations.table.evaluation'),
      width: HR_COL.main,
      render: (e) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{e.formName ?? t('weldhr.me.reviews.evaluations.untitled')}</p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground tabular-nums @lg:hidden">{evaluationPeriod(e)}</p>
        </div>
      ),
    },
    {
      id: 'evaluator',
      header: t('weldhr.me.reviews.evaluations.table.evaluator'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[160px]'),
      render: (e) => <span className="block truncate text-muted-foreground">{e.evaluatorName ?? '—'}</span>,
    },
    {
      id: 'period',
      header: t('weldhr.me.reviews.evaluations.table.period'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[200px]'),
      render: (e) => <span className="block truncate tabular-nums">{evaluationPeriod(e)}</span>,
    },
    {
      id: 'score',
      header: t('weldhr.me.reviews.evaluations.table.score'),
      width: cn(HR_COL.fixed, HR_COL.hideMd, 'w-[80px]'),
      render: (e) => <ScoreBadge score={e.overallScore} />,
    },
    {
      id: 'status',
      header: t('weldhr.me.reviews.evaluations.table.status'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[120px]'),
      render: (e) => <StatusBadge group="evaluation" status={e.status} />,
    },
  ];

  return (
    <>
      <HrListContainer>
        <PanelEntityList<HrSelfEvaluation>
          items={evaluations}
          isLoading={isLoading}
          error={data ? null : error ? new Error(errorMessage(error, t('weldhr.me.reviews.evaluations.loadFailed'))) : null}
          columns={columns}
          onRowClick={(e) => openPanel({ type: MY_EVALUATION_PANEL_TYPE, id: e.id })}
          objectPanel={{ type: MY_EVALUATION_PANEL_TYPE }}
          // The row's "⋮" menu (on hover): acknowledging one shared with you.
          rowMenu={(e) =>
            evaluationToAcknowledge(e) ? <AcknowledgeMenuItem onSelect={() => setAcknowledging({ kind: 'evaluation', id: e.id })} /> : null
          }
          groups={groups}
          filters={filters}
          applyFilters={applyFilters}
          searchFields={['formName', 'evaluatorName', 'summary']}
          searchPlaceholder={t('weldhr.me.reviews.evaluations.searchPlaceholder')}
          emptyState={{
            icon: emptyIcon(ClipboardCheck),
            title: t('weldhr.me.reviews.evaluations.listEmpty.title'),
            description: t('weldhr.me.reviews.evaluations.listEmpty.description'),
          }}
        />
      </HrListContainer>
      {acknowledging && <AcknowledgeDialog target={acknowledging} onClose={() => setAcknowledging(null)} />}
    </>
  );
}

export function MyCoachingList() {
  const t = useTranslations();
  const { data, isLoading, error } = useMyHrCoaching();
  const { open: openPanel } = useObjectPanel();
  const [acknowledging, setAcknowledging] = useState<AcknowledgeTarget | null>(null);
  const logs = [...(data ?? [])].sort((a, b) => b.sessionDate.localeCompare(a.sessionDate));

  const groups: GroupConfig<HrSelfCoachingLog>[] = [
    { id: 'toAcknowledge', label: t('weldhr.me.reviews.groups.toAcknowledge'), sortOrder: 1, filter: coachingToAcknowledge },
    { id: 'acknowledged', label: t('weldhr.me.reviews.groups.acknowledged'), sortOrder: 2, filter: (l) => !coachingToAcknowledge(l) },
  ];

  const topicOf = (log: HrSelfCoachingLog) => log.topic || t(`weldhr.status.coachingCategory.${log.category}`);
  const categories = [...new Set(logs.map((l) => l.category))];
  const coaches = optionsOf(logs.map((l) => l.coachName));
  const filters: FilterConfig[] = [
    {
      field: 'category',
      label: t('weldhr.me.reviews.coaching.table.category'),
      operators: ['is'],
      options: categories.map((category) => ({ value: category, label: t(`weldhr.status.coachingCategory.${category}`) })),
    },
    {
      field: 'status',
      label: t('weldhr.me.reviews.coaching.table.status'),
      operators: ['is'],
      options: (['open', 'acknowledged', 'closed'] as const).map((status) => ({ value: status, label: t(`weldhr.status.coaching.${status}`) })),
    },
    ...(coaches.length > 0 ? [{ field: 'coach', label: t('weldhr.me.reviews.coaching.table.coach'), operators: ['is'], options: coaches }] : []),
  ];

  const applyFilters = (rows: HrSelfCoachingLog[], active: ActiveFilter[]) =>
    active.reduce((list, filter) => {
      if (!filter.value) return list;
      if (filter.field === 'category') return list.filter((l) => l.category === filter.value);
      if (filter.field === 'status') return list.filter((l) => l.status === filter.value);
      if (filter.field === 'coach') return list.filter((l) => l.coachName === filter.value);
      return list;
    }, rows);

  const columns: ColumnDef<HrSelfCoachingLog>[] = [
    {
      id: 'topic',
      header: t('weldhr.me.reviews.coaching.table.topic'),
      width: HR_COL.main,
      render: (l) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{topicOf(l)}</p>
          {/* What the hidden columns would show, once the list is too narrow for them. */}
          <p className="truncate text-xs text-muted-foreground tabular-nums @lg:hidden">
            {[formatDate(l.sessionDate), l.coachName].filter(Boolean).join(' · ')}
          </p>
        </div>
      ),
    },
    {
      id: 'date',
      header: t('weldhr.me.reviews.coaching.table.date'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[110px]'),
      render: (l) => <span className="tabular-nums">{formatDate(l.sessionDate)}</span>,
    },
    {
      id: 'category',
      header: t('weldhr.me.reviews.coaching.table.category'),
      width: cn(HR_COL.fixed, HR_COL.hideMd, 'w-[130px]'),
      render: (l) => <Badge variant="secondary">{t(`weldhr.status.coachingCategory.${l.category}`)}</Badge>,
    },
    {
      id: 'coach',
      header: t('weldhr.me.reviews.coaching.table.coach'),
      width: cn(HR_COL.fixed, HR_COL.hideLg, 'w-[150px]'),
      render: (l) => <span className="block truncate text-muted-foreground">{l.coachName ?? '—'}</span>,
    },
    {
      id: 'followUp',
      header: t('weldhr.me.reviews.coaching.table.followUp'),
      width: cn(HR_COL.fixed, HR_COL.hideXl, 'w-[110px]'),
      render: (l) => <span className="tabular-nums text-muted-foreground">{l.followUpDate ? formatDate(l.followUpDate) : '—'}</span>,
    },
    {
      id: 'status',
      header: t('weldhr.me.reviews.coaching.table.status'),
      width: cn(HR_COL.fixed, HR_COL.hideSm, 'w-[120px]'),
      render: (l) => <StatusBadge group="coaching" status={l.status} />,
    },
  ];

  return (
    <>
      <HrListContainer>
        <PanelEntityList<HrSelfCoachingLog>
          items={logs}
          isLoading={isLoading}
          error={data ? null : error ? new Error(errorMessage(error, t('weldhr.me.reviews.coaching.loadFailed'))) : null}
          columns={columns}
          onRowClick={(l) => openPanel({ type: MY_COACHING_PANEL_TYPE, id: l.id })}
          objectPanel={{ type: MY_COACHING_PANEL_TYPE }}
          // The row's "⋮" menu (on hover): acknowledging a session.
          rowMenu={(l) =>
            coachingToAcknowledge(l) ? <AcknowledgeMenuItem onSelect={() => setAcknowledging({ kind: 'coaching', id: l.id })} /> : null
          }
          groups={groups}
          filters={filters}
          applyFilters={applyFilters}
          searchFields={['topic', 'notes', 'coachName']}
          searchPlaceholder={t('weldhr.me.reviews.coaching.searchPlaceholder')}
          emptyState={{
            icon: emptyIcon(MessagesSquare),
            title: t('weldhr.me.reviews.coaching.listEmpty.title'),
            description: t('weldhr.me.reviews.coaching.listEmpty.description'),
          }}
        />
      </HrListContainer>
      {acknowledging && <AcknowledgeDialog target={acknowledging} onClose={() => setAcknowledging(null)} />}
    </>
  );
}
