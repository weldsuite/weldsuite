import { useMemo, useState, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import type { FilterConfig } from '@weldsuite/ui/components/list-toolbar';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import type { ChangeRequest } from '@weldsuite/app-api-client/domains/flow-approvals';
import { useObjectPanel } from '@/components/object-panel';
import { SubNavToolbar } from '@/app/weldflow/components/sub-nav';
import { useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useChangeControl, useChangeRequests } from '@/hooks/queries/use-flow-approvals-queries';
import { useProjectMembers } from '@/hooks/queries/use-projects-queries';
import type { MemberOption } from '@/app/weldflow/_approvals/use-member-names';
import { ChangeDialog } from './_components/change-dialog';
import { applyChangeFilters, CHANGE_FILTER_FIELDS, EMPTY_CHANGE_FILTERS, type ChangeFilters } from './_components/change-filters';
import { ChangeRequestList } from './_components/change-list';
import { CHANGE_REQUEST_PANEL_TYPE } from './_components/change-panel-type';
import { CHANGE_STATUSES, useRouteLabel } from './_components/change-status';
import { RulesDialog } from './_components/rules-dialog';
import { useChangeAbilities } from './_components/use-change-abilities';

/** The change request dialog: closed, starting one, or editing one. */
type DialogState = { mode: 'create' } | { mode: 'edit'; change: ChangeRequest } | null;

/**
 * Governance > Change requests: the list of the project's changes under the
 * toolbar of the Governance tab (search, status and route filters, the
 * approval rules, a new change request). A row opens the change's object panel.
 */
export default function ChangeRequestsPage() {
  const { t } = useI18n();
  const copy = t.flowApprovals.changes;
  const params = useParams();
  const projectId = params.projectId as string;
  const { canCreate, canEditRules } = useChangeAbilities();
  const routeLabel = useRouteLabel();

  const control = useChangeControl(projectId);
  const changes = useChangeRequests(projectId);
  const projectMembers = useProjectMembers(projectId);
  const { stack, open } = useObjectPanel();

  const [filters, setFilters] = useState<ChangeFilters>(EMPTY_CHANGE_FILTERS);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [rulesOpen, setRulesOpen] = useState(false);

  const members = useMemo<MemberOption[]>(
    () => (projectMembers.data?.data ?? []).map((member) => ({ userId: member.userId, name: member.user?.name || member.user?.email || member.userId })),
    [projectMembers.data],
  );
  const visible = useMemo(() => applyChangeFilters(changes.data ?? [], filters), [changes.data, filters]);
  const currency = control.data?.currency ?? null;

  // A change opens in the platform's object panel, like a task; its row stays highlighted while it is open.
  const top = stack.at(-1);
  const selectedId = top?.type === CHANGE_REQUEST_PANEL_TYPE ? top.id : null;
  const select = (id: string) => open({ type: CHANGE_REQUEST_PANEL_TYPE, id });
  const create = canCreate ? () => setDialog({ mode: 'create' }) : undefined;

  const filterConfigs: FilterConfig[] = [
    {
      field: CHANGE_FILTER_FIELDS.status,
      label: copy.columns.status,
      options: CHANGE_STATUSES.map((status) => ({ value: status, label: copy.status[status] })),
    },
    {
      field: CHANGE_FILTER_FIELDS.route,
      label: copy.columns.route,
      options: (['manager', 'board'] as const).map((route) => ({ value: route, label: routeLabel(route) })),
    },
  ];

  // Like the RAID tab's "Show closed": an outline button; on a phone only its icon, so the search keeps the room.
  const rulesButton = control.data ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setRulesOpen(true)}
      aria-label={copy.rules.title}
      className="h-8 px-2 text-sm text-muted-foreground shadow-none md:px-3"
    >
      <ShieldCheck aria-hidden className="md:hidden" />
      <span className="hidden md:inline">{copy.rules.title}</span>
    </Button>
  ) : null;

  let body: ReactNode;
  if (changes.isLoading) {
    body = <PageLoader fullScreen={false} className="h-auto min-h-[calc(100dvh-350px)] pb-0" />;
  } else if (changes.isError && !changes.data) {
    body = (
      <ErrorState
        message={copy.loadFailed}
        retryLabel={t.flowApprovals.common.retry}
        onRetry={() => void changes.refetch()}
        className="min-h-[calc(100dvh-350px)] justify-center rounded-none border-0 bg-transparent"
      />
    );
  } else {
    body = (
      <ChangeRequestList
        changes={visible}
        filters={filters}
        onFiltersChange={setFilters}
        currency={currency}
        selectedId={selectedId}
        onSelect={select}
        onEdit={(change) => setDialog({ mode: 'edit', change })}
        onCreate={create}
      />
    );
  }

  return (
    <>
      <SubNavToolbar
        filterConfigs={filterConfigs}
        filters={filters.filters}
        onFiltersChange={(next) => setFilters({ ...filters, filters: next })}
        search={filters.search}
        onSearchChange={(search) => setFilters({ ...filters, search })}
        searchPlaceholder={copy.searchPlaceholder}
        actionButtons={rulesButton}
        createButton={create ? { label: copy.new, onClick: create } : undefined}
      />
      {body}

      <ChangeDialog
        projectId={projectId}
        currency={currency}
        change={dialog?.mode === 'edit' ? dialog.change : null}
        open={dialog !== null}
        onOpenChange={(isOpen) => (isOpen ? undefined : setDialog(null))}
        onSaved={dialog?.mode === 'create' ? select : undefined}
      />
      {control.data ? (
        <RulesDialog
          open={rulesOpen}
          onOpenChange={setRulesOpen}
          projectId={projectId}
          control={control.data}
          members={members}
          canEdit={canEditRules}
        />
      ) : null}
    </>
  );
}
