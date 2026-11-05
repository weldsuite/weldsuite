/**
 * The object panel of a change request, on the same shell as the task panel
 * and the RAID item panel: `useObjectPanelShell` + `EntityDetailView` + the
 * configurable tab strip, so it has the shared header (close, expand, back,
 * previous / next) and opens over the page like every record.
 *
 * Tabs: Details (status, who and when, impact, routing, what changes once it
 * is approved) and Approvals (who has been asked and what they answered). The
 * panel host sits outside the project, so the panel reads the project's grants
 * through its own `ProjectPermissionProvider`.
 */

import { useMemo, useState } from 'react';
import { EllipsisVertical, LayoutGrid, Send, Undo2, UserCheck } from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import type { ChangeRequestDetail } from '@weldsuite/app-api-client/domains/flow-approvals';
import { useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { ConfigurablePanelTabs, type ConfigurablePanelTab } from '@/components/objects/_shared/configurable-panel-tabs';
import { usePanelInitialTab } from '@/components/objects/_shared/use-panel-initial-tab';
import { ProjectPermissionProvider } from '@/app/weldflow/contexts/project-permission-context';
import { useMemberNames } from '@/app/weldflow/_approvals/use-member-names';
import { useChangeControl, useChangeRequest } from '@/hooks/queries/use-flow-approvals-queries';
import { useI18n } from '@/lib/i18n/provider';
import { ChangeMenuItems, hasAnyAction, useChangeActions, type ChangeActions } from './change-actions';
import { ChangeApprovalsTab, ChangeDetailsTab, changeActions, type ChangeAllowed } from './change-detail';
import { ChangeDialog } from './change-dialog';
import { CHANGE_REQUEST_PANEL_TYPE } from './change-panel-type';
import { useChangeAbilities } from './use-change-abilities';

/** The task panel's width, so a change request and a task opened from it take the same room. */
const CHANGE_REQUEST_PANEL_WIDTH = 400;

type ChangeTabId = 'details' | 'approvals';

interface HeaderActionsProps {
  change: ChangeRequestDetail;
  allowed: ChangeAllowed;
  actions: ChangeActions;
  onEdit: () => void;
}

/** The main action as an icon (submit a draft, withdraw one that waits), then the three-dot menu with all of them. */
function HeaderActions({ change, allowed, actions, onEdit }: Readonly<HeaderActionsProps>) {
  const { t } = useI18n();
  const copy = t.flowApprovals.changes;

  let primary: { label: string; Icon: typeof Send; disabled: boolean; onClick: () => void } | null = null;
  if (allowed.submit) primary = { label: copy.submit, Icon: Send, disabled: actions.isSubmitting, onClick: () => actions.submit(change) };
  else if (allowed.withdraw) primary = { label: copy.withdraw, Icon: Undo2, disabled: false, onClick: () => actions.requestWithdraw(change) };

  return (
    <div className="flex items-center gap-1.5">
      {primary ? (
        // An icon, as the header actions of the task panel, so the title keeps the room.
        <Button type="button" variant="ghost" size="icon-sm" className="size-7" disabled={primary.disabled} onClick={primary.onClick} aria-label={primary.label} title={primary.label}>
          <primary.Icon className="h-4 w-4 text-muted-foreground" />
        </Button>
      ) : null}
      {hasAnyAction(allowed) ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
              aria-label={copy.moreActions}
            >
              <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <ChangeMenuItems
              allowed={allowed}
              onEdit={onEdit}
              onSubmit={() => actions.submit(change)}
              onWithdraw={() => actions.requestWithdraw(change)}
              onDelete={() => actions.requestDelete(change)}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

/** The change request could not be loaded: gone, or a failure that can be retried. */
function LoadError({ notFound, onRetry }: Readonly<{ notFound: boolean; onRetry: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowApprovals.changes.detail;
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground" role="alert">
        {notFound ? copy.notFound : copy.loadFailed}
      </p>
      {notFound ? null : (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t.flowApprovals.common.retry}
        </Button>
      )}
    </div>
  );
}

type ChangeQuery = ReturnType<typeof useChangeRequest>;

function ChangeRequestPanelView({ query, ...props }: Readonly<ObjectPanelComponentProps & { query: ChangeQuery }>) {
  const { t } = useI18n();
  const st = useTranslations();
  const copy = t.flowApprovals.changes;
  const { abilities, userId } = useChangeAbilities();
  const { nameOf } = useMemberNames();
  const [editing, setEditing] = useState<ChangeRequestDetail | null>(null);

  const change = query.data;
  const control = useChangeControl(change?.projectId ?? '');
  const currency = control.data?.currency ?? null;
  const notFound = query.isError && isApiError(query.error) && query.error.status === 404;
  const allowed = change ? changeActions(change, abilities, userId) : null;
  // Deleting the change closes its own panel.
  const actions = useChangeActions({ onDeleted: () => props.onClose() });

  const shell = useObjectPanelShell({
    ...props,
    width: CHANGE_REQUEST_PANEL_WIDTH,
    loading: query.isLoading && !change,
  });

  const approverCount = change?.approvers.length;
  const tabs = useMemo<ConfigurablePanelTab<ChangeTabId>[]>(() => {
    const shown = { defaultVisibleInPanel: true, defaultVisibleInFullscreen: true };
    return [
      { id: 'details', label: st('sweep.entities.detailsTab'), icon: LayoutGrid, required: true, ...shown },
      { id: 'approvals', label: copy.detail.approvalsTab, icon: UserCheck, count: approverCount || undefined, ...shown },
    ];
  }, [st, copy.detail.approvalsTab, approverCount]);
  // A deep-linked tab that only appears once the change is loaded is applied when it does.
  const [activeTab, setActiveTab] = usePanelInitialTab<ChangeTabId>(tabs, props.initialTab, 'details');

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        title={
          change ? (
            <span className="relative top-px text-[15px] font-medium text-foreground">{change.title}</span>
          ) : (
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          )
        }
        titleWrap
        actions={change && allowed ? <HeaderActions change={change} allowed={allowed} actions={actions} onEdit={() => setEditing(change)} /> : null}
        tabs={
          <ConfigurablePanelTabs
            objectType={CHANGE_REQUEST_PANEL_TYPE}
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={shell.mode}
          />
        }
      >
        {!query.isLoading && !change ? <LoadError notFound={notFound} onRetry={() => void query.refetch()} /> : null}
        {change && activeTab === 'details' ? <ChangeDetailsTab change={change} currency={currency} nameOf={nameOf} /> : null}
        {change && activeTab === 'approvals' ? <ChangeApprovalsTab change={change} nameOf={nameOf} /> : null}
      </EntityDetailView>

      <ChangeDialog
        projectId={change?.projectId ?? ''}
        currency={currency}
        change={editing}
        open={editing !== null}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
      />
      {actions.confirmDialog}
    </>
  );
}

/** The panel of a change request, registered as the `change_request` object panel. */
export function ChangeRequestPanel(props: Readonly<ObjectPanelComponentProps>) {
  const query = useChangeRequest(props.id);
  return (
    <ProjectPermissionProvider projectId={query.data?.projectId ?? ''}>
      <ChangeRequestPanelView {...props} query={query} />
    </ProjectPermissionProvider>
  );
}
