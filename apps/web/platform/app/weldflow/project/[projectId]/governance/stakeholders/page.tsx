import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Grid3x3, MessageSquareText } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import type { ActiveFilter, FilterConfig } from '@weldsuite/ui/components/list-toolbar';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import type { Stakeholder } from '@weldsuite/app-api-client/domains/project-reporting';
import { useObjectPanel } from '@/components/object-panel';
import { useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useStakeholders } from '@/hooks/queries/use-project-reporting-queries';
import { ListLoadError } from '@/app/weldflow/components/list-load-error';
import { SubNavToolbar } from '@/app/weldflow/components/sub-nav';
import { useGovernance } from '../_lib/use-governance';
import { CommunicationPlanDialog } from './_components/communication-plan-dialog';
import { PowerGrid } from './_components/power-grid';
import { RaciDialog } from './_components/raci-dialog';
import { RemoveStakeholderDialog, StakeholderDialog, type StakeholderDialogState } from './_components/stakeholder-dialogs';
import { StakeholderList } from './_components/stakeholder-list';
import { STAKEHOLDER_FILTER_FIELDS, applyStakeholderFilters } from './_components/stakeholder-model';
import { STAKEHOLDER_PANEL_TYPE } from './_components/stakeholder-panel-type';

const NO_ROWS: Stakeholder[] = [];

/**
 * Governance › Stakeholders: the register as the standard list, with the power
 * / interest grid beside it, as the RAID log sets its matrix beside its
 * register. A row opens the stakeholder's panel. The communication plan and
 * the RACI matrix are editors of their own, opened from the toolbar.
 */
export default function StakeholdersPage() {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders;
  const params = useParams();
  const projectId = String(params.projectId ?? '');
  const query = useStakeholders(projectId);
  const { abilities, memberOf } = useGovernance(projectId);
  const { stack, open, closeAll } = useObjectPanel();

  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<ActiveFilter[]>([]);
  const [dialog, setDialog] = useState<StakeholderDialogState | null>(null);
  const [removing, setRemoving] = useState<Stakeholder | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [raciOpen, setRaciOpen] = useState(false);

  const all = query.data ?? NO_ROWS;
  const visible = useMemo(() => applyStakeholderFilters(all, search, filters), [all, search, filters]);

  // A stakeholder opens in the platform's object panel, like a task; the row on screen stays highlighted.
  const top = stack.at(-1);
  const selectedId = top?.type === STAKEHOLDER_PANEL_TYPE ? top.id : null;
  const openStakeholder = useCallback((id: string) => open({ type: STAKEHOLDER_PANEL_TYPE, id }), [open]);
  const avatarOf = useCallback((row: Stakeholder) => (row.memberId ? (memberOf(row.memberId)?.avatar ?? null) : null), [memberOf]);

  // Everything here is written with the project's update permission, so one ability covers add, edit and remove.
  const canEdit = abilities.update;

  const filterConfigs: FilterConfig[] = [
    {
      field: STAKEHOLDER_FILTER_FIELDS.attitude,
      label: copy.columns.attitude,
      options: Object.entries(copy.attitudes).map(([value, label]) => ({ value, label })),
    },
    {
      field: STAKEHOLDER_FILTER_FIELDS.engagement,
      label: copy.columns.engagement,
      options: Object.entries(copy.engagements).map(([value, label]) => ({ value, label })),
    },
    {
      field: STAKEHOLDER_FILTER_FIELDS.type,
      label: copy.toolbar.type,
      options: [
        { value: 'internal', label: copy.internal },
        { value: 'client', label: copy.client },
      ],
    },
  ];

  // Outline buttons as the RAID log's "Show closed": the label gives way to the icon where the bar is tight.
  const editorButtons = (
    <>
      <Button type="button" variant="outline" size="sm" aria-label={copy.toolbar.plan} title={copy.toolbar.plan} onClick={() => setPlanOpen(true)} className="h-8 px-3 text-sm text-muted-foreground shadow-none">
        <MessageSquareText aria-hidden />
        <span className="hidden xl:inline">{copy.toolbar.plan}</span>
      </Button>
      <Button type="button" variant="outline" size="sm" aria-label={copy.toolbar.raci} title={copy.toolbar.raci} onClick={() => setRaciOpen(true)} className="h-8 px-3 text-sm text-muted-foreground shadow-none">
        <Grid3x3 aria-hidden />
        <span className="hidden xl:inline">{copy.toolbar.raci}</span>
      </Button>
    </>
  );

  const list = (
    <StakeholderList
      rows={visible}
      search={search}
      onSearchChange={setSearch}
      filters={filters}
      onFiltersChange={setFilters}
      selectedId={selectedId}
      avatarOf={avatarOf}
      canEdit={canEdit}
      onOpen={openStakeholder}
      onAdd={() => setDialog({ mode: 'create' })}
      onEdit={(row) => setDialog({ mode: 'edit', row })}
      onRemove={setRemoving}
    />
  );

  let body: ReactNode;
  if (query.isLoading) {
    body = <PageLoader fullScreen={false} className="min-h-[calc(100dvh-350px)]" />;
  } else if (query.isError && !query.data) {
    body = <ListLoadError message={copy.error} retryLabel={t.flowGovernance.common.retry} onRetry={() => void query.refetch()} />;
  } else if (all.length === 0) {
    // Nobody on the register yet: the empty state has the page, with no grid to draw.
    body = list;
  } else {
    // Grid and list side by side when the page is wide enough; measured on the page, so an open panel counts.
    body = (
      <div className="@container/stakeholders flex flex-1 flex-col">
        <div className="flex flex-1 flex-col @5xl/stakeholders:flex-row">
          <div className="shrink-0 border-b border-border pb-4 @5xl/stakeholders:w-[31rem] @5xl/stakeholders:border-r @5xl/stakeholders:border-b-0">
            <div className="max-w-[31rem]">
              <PowerGrid rows={all} selectedId={selectedId} avatarOf={avatarOf} onOpen={openStakeholder} />
            </div>
          </div>
          <div className="min-w-0 flex-1">{list}</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <SubNavToolbar
        filterConfigs={filterConfigs}
        filters={filters}
        onFiltersChange={setFilters}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder={copy.search}
        actionButtons={editorButtons}
        createButton={canEdit ? { label: copy.add, onClick: () => setDialog({ mode: 'create' }) } : undefined}
      />
      {body}
      <StakeholderDialog projectId={projectId} existing={all} state={dialog} onClose={() => setDialog(null)} />
      <RemoveStakeholderDialog
        row={removing}
        onClose={() => setRemoving(null)}
        onRemoved={(row) => {
          if (row.id === selectedId) closeAll();
        }}
      />
      <CommunicationPlanDialog projectId={projectId} open={planOpen} canEdit={abilities.manage} onClose={() => setPlanOpen(false)} />
      <RaciDialog projectId={projectId} open={raciOpen} stakeholders={all} canEdit={canEdit} onClose={() => setRaciOpen(false)} />
    </>
  );
}
