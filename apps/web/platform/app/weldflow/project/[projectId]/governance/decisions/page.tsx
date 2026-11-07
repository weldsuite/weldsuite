import { useCallback, useMemo, useState } from 'react';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import type { ActiveFilter, FilterConfig } from '@weldsuite/ui/components/list-toolbar';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SubNavToolbar } from '@/app/weldflow/components/sub-nav';
import { useObjectPanel } from '@/components/object-panel';
import { useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useDecisions } from '@/hooks/queries/use-project-governance-queries';
import { useGovernance } from '../_lib/use-governance';
import { DecisionDialogs, type DecisionDialogState } from './_components/decision-dialogs';
import { DecisionList } from './_components/decision-list';
import { DECISION_PANEL_TYPE } from './_components/decision-panel-type';
import { useMemberName } from './_components/decision-parts';
import {
  DECISION_STATUSES,
  FILTER_FIELDS,
  NO_DECIDER,
  applyDecisionFilters,
  deciderIdsOf,
  deciderOf,
} from './_lib/decision-filters';

/**
 * Governance › Decisions: the decision log as the standard list, under the
 * toolbar of the Governance tab. A row opens the decision's object panel.
 */
export default function DecisionsPage() {
  const { t } = useI18n();
  const copy = t.flowGovernance.decisions;
  const common = t.flowGovernance.common;
  const params = useParams();
  const projectId = String(params.projectId ?? '');
  const { abilities, memberOptions, memberOf } = useGovernance(projectId);
  const decisionsQuery = useDecisions(projectId);
  const memberName = useMemberName(memberOf);
  const { stack, open, closeAll } = useObjectPanel();

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [dialog, setDialog] = useState<DecisionDialogState | null>(null);

  const decisions = useMemo(() => decisionsQuery.data ?? [], [decisionsQuery.data]);
  const visible = useMemo(() => applyDecisionFilters(decisions, search, filters), [decisions, search, filters]);

  // A decision opens in the platform's object panel, like a task; its row stays highlighted.
  const top = stack.at(-1);
  const selectedId = top?.type === DECISION_PANEL_TYPE ? top.id : null;
  const select = useCallback(
    (id: string | null) => (id ? open({ type: DECISION_PANEL_TYPE, id }) : closeAll()),
    [open, closeAll],
  );

  const filterConfigs = useMemo<FilterConfig[]>(
    () => [
      {
        field: FILTER_FIELDS.status,
        label: common.status,
        options: DECISION_STATUSES.map((status) => ({ value: status, label: copy.statuses[status] })),
      },
      {
        field: FILTER_FIELDS.decider,
        label: copy.columns.decider,
        searchable: true,
        options: [
          ...(decisions.some((decision) => !deciderOf(decision)) ? [{ value: NO_DECIDER, label: common.unassigned }] : []),
          ...deciderIdsOf(decisions).map((id) => ({ value: id, label: memberName(id) })),
        ],
      },
    ],
    [common.status, common.unassigned, copy.statuses, copy.columns.decider, decisions, memberName],
  );

  const toolbar = (
    <SubNavToolbar
      filterConfigs={filterConfigs}
      filters={filters}
      onFiltersChange={setFilters}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder={copy.searchPlaceholder}
      createButton={abilities.create ? { label: copy.form.createTitle, onClick: () => setDialog({ kind: 'create' }) } : undefined}
    />
  );

  const dialogs = (
    <DecisionDialogs
      projectId={projectId}
      memberOptions={memberOptions}
      decisions={decisions}
      state={dialog}
      onClose={() => setDialog(null)}
      onSaved={(id) => {
        // A decision just written down opens in its panel.
        const created = dialog?.kind === 'create';
        setDialog(null);
        if (created) select(id);
      }}
    />
  );

  let body = (
    <DecisionList
      decisions={visible}
      search={search}
      onSearchChange={setSearch}
      filters={filters}
      onFiltersChange={setFilters}
      abilities={abilities}
      memberOf={memberOf}
      selectedId={selectedId}
      onSelect={select}
      onDialog={setDialog}
    />
  );
  if (decisionsQuery.isLoading) body = <PageLoader fullScreen={false} label={copy.title} />;
  else if (decisionsQuery.isError && !decisionsQuery.data) {
    body = (
      <ErrorState
        message={common.loadFailedTitle}
        retryLabel={common.retry}
        onRetry={() => void decisionsQuery.refetch()}
        className="m-3 md:m-4"
      />
    );
  }

  return (
    <>
      {toolbar}
      {body}
      {dialogs}
    </>
  );
}
