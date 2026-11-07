/**
 * The object panel of a decision of the decision log, on the same shell as the
 * task and RAID item panels: `useObjectPanelShell` + `EntityDetailView` + the
 * configurable tab strip, so it has the shared header (close, expand, back,
 * previous / next) and opens over the page like every record.
 *
 * Tabs: Details (status, who decides, context, the options weighed, what
 * follows) and Linked (the records it is tied to). The object panel host sits
 * outside the Governance tab, so the panel reads the project's grants and
 * members itself.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { EllipsisVertical, Gavel, LayoutGrid, Link2, Pencil, Replace, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import type { DecisionDetail } from '@weldsuite/app-api-client/domains/project-governance';
import { ListCode } from '@/app/weldflow/components/list-cells';
import { ProjectPermissionProvider } from '@/app/weldflow/contexts/project-permission-context';
import {
  useObjectPanelShell,
  type ObjectPanelComponentProps,
  type ObjectPanelTabDescriptor,
} from '@/components/object-panel';
import { ConfigurablePanelTabs } from '@/components/objects/_shared/configurable-panel-tabs';
import { TabEmptyState, tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { usePanelInitialTab } from '@/components/objects/_shared/use-panel-initial-tab';
import { useDecision, useDecisions, useDeleteDecision } from '@/hooks/queries/use-project-governance-queries';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useToday } from '../../../raid/_components/raid-context';
import { isOverdue } from '../../../raid/_lib/risk';
import { useFormatters, useGovernance, type GovernanceAbilities } from '../../_lib/use-governance';
import { DecisionDialogs, type DecisionDialogState } from './decision-dialogs';
import { LinkedIllustration } from './decision-illustrations';
import { DECISION_PANEL_TYPE } from './decision-panel-type';
import { DecisionStatusPill, PanelSection, PersonValue, Property, useMemberName } from './decision-parts';
import { LinkedList, OptionsList, ProposedBanner } from './decision-sections';

/** The task panel's width, so a decision and a task opened from it take the same room. */
const DECISION_PANEL_WIDTH = 400;

type DecisionTabId = 'details' | 'linked';

interface DecisionTab extends ObjectPanelTabDescriptor {
  id: DecisionTabId;
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

function decisionTabs(labels: { details: string; linked: string; linkedCount?: number }): DecisionTab[] {
  const shown = { defaultVisibleInPanel: true, defaultVisibleInFullscreen: true };
  return [
    { id: 'details', label: labels.details, icon: LayoutGrid, required: true, ...shown },
    { id: 'linked', label: labels.linked, icon: Link2, count: labels.linkedCount, ...shown },
  ];
}

/** The decision could not be loaded: gone, or a failure that can be retried. */
function LoadError({ notFound, onRetry }: Readonly<{ notFound: boolean; onRetry: () => void }>) {
  const { t } = useI18n();
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground" role="alert">
        {notFound ? t.flowGovernance.decisions.notFound : t.flowGovernance.common.loadFailedTitle}
      </p>
      {notFound ? null : (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t.flowGovernance.common.retry}
        </Button>
      )}
    </div>
  );
}

interface PanelAbilities {
  abilities: GovernanceAbilities;
  canRecord: boolean;
  canReplace: boolean;
}

interface HeaderActionsProps extends PanelAbilities {
  onEdit: () => void;
  onDecide: () => void;
  onSupersede: () => void;
  onDelete: () => void;
}

/** Record (a proposed decision, as an icon so the title keeps the room) and the three-dot menu. */
function HeaderActions({ abilities, canRecord, canReplace, onEdit, onDecide, onSupersede, onDelete }: Readonly<HeaderActionsProps>) {
  const { t } = useI18n();
  const copy = t.flowGovernance.decisions;
  const showMenu = abilities.update || canReplace || abilities.remove;
  return (
    <div className="flex items-center gap-1.5">
      {canRecord ? (
        <Button type="button" variant="ghost" size="icon-sm" className="size-7" onClick={onDecide} aria-label={copy.actions.record} title={copy.actions.record}>
          <Gavel className="h-4 w-4 text-muted-foreground" />
        </Button>
      ) : null}
      {showMenu ? (
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
            {abilities.update ? (
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil aria-hidden />
                {copy.actions.edit}
              </DropdownMenuItem>
            ) : null}
            {canReplace ? (
              <DropdownMenuItem onSelect={onSupersede}>
                <Replace aria-hidden />
                {copy.actions.supersede}
              </DropdownMenuItem>
            ) : null}
            {abilities.remove ? (
              <>
                {abilities.update || canReplace ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 aria-hidden />
                  {copy.actions.delete}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

interface DetailsTabProps {
  decision: DecisionDetail;
  canRecord: boolean;
  onDecide: () => void;
  memberOf: ReturnType<typeof useGovernance>['memberOf'];
}

/** Details tab: the code and status, the notices, the facts, the context, the options and the consequences. */
function DetailsTab({ decision, canRecord, onDecide, memberOf }: Readonly<DetailsTabProps>) {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.decisions;
  const formatters = useFormatters();
  const now = useToday();
  const memberName = useMemberName(memberOf);
  const declined = decision.approvals.find((approval) => approval.decision === 'rejected');
  const proposed = decision.status === 'proposed';
  const late = proposed && isOverdue(decision.decisionDueAt, now);
  const noDate = <span className="text-muted-foreground">—</span>;

  return (
    <div className="pb-7">
      <div className="flex flex-col gap-3 px-6 pt-5 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <ListCode code={decision.code} />
          <DecisionStatusPill status={decision.status} />
        </div>
        {proposed ? <ProposedBanner row={decision} declined={declined} canRecord={canRecord} onDecide={onDecide} memberName={memberName} /> : null}
        {decision.status === 'superseded' && decision.supersededBy ? (
          <InfoBanner variant="neutral">{format(copy.replacedBy, { code: decision.supersededBy.code })}</InfoBanner>
        ) : null}
        {decision.status === 'decided' && decision.supersedes.length > 0 ? (
          <p className="text-[13px] text-muted-foreground">{format(copy.replaces, { codes: decision.supersedes.map((s) => s.code).join(', ') })}</p>
        ) : null}
      </div>

      <dl className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 border-y border-border px-6 py-4 text-[13px]">
        {proposed ? (
          <>
            <Property label={copy.form.decider}>
              <PersonValue userId={decision.deciderId} memberOf={memberOf} />
            </Property>
            <Property label={copy.form.dueDate}>
              {decision.decisionDueAt ? (
                <span className={cn(late && 'font-medium text-red-700 dark:text-red-400')}>{formatters.date(decision.decisionDueAt)}</span>
              ) : (
                noDate
              )}
            </Property>
          </>
        ) : (
          <>
            <Property label={copy.form.decidedBy}>
              <PersonValue userId={decision.decidedBy} memberOf={memberOf} />
            </Property>
            <Property label={copy.form.decidedAt}>{decision.decidedAt ? formatters.date(decision.decidedAt) : noDate}</Property>
          </>
        )}
        <Property label={copy.proposedByLabel}>
          <PersonValue userId={decision.createdBy} memberOf={memberOf} />
        </Property>
      </dl>

      <PanelSection title={copy.sections.context}>
        {decision.context ? (
          <p className="text-[13px] leading-relaxed whitespace-pre-line">{decision.context}</p>
        ) : (
          <p className="text-[13px] text-muted-foreground">{copy.noContext}</p>
        )}
      </PanelSection>

      <PanelSection title={copy.sections.options}>
        <OptionsList options={decision.options} />
      </PanelSection>

      <PanelSection title={copy.sections.consequences}>
        {decision.consequences.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{copy.noConsequences}</p>
        ) : (
          <ul className="list-disc space-y-1 pl-[1.1rem] text-[13px] leading-relaxed">
            {decision.consequences.map((consequence, index) => (
              <li key={index}>{consequence}</li>
            ))}
          </ul>
        )}
      </PanelSection>
    </div>
  );
}

/** Linked tab: the records the decision is tied to, or the empty state. */
function LinkedTab({ links }: Readonly<{ links: DecisionDetail['links'] }>) {
  const { t } = useI18n();
  if (links.length === 0) {
    return (
      <TabEmptyState
        bare
        illustration={<LinkedIllustration />}
        title={t.flowGovernance.common.noLinks}
        description={t.flowGovernance.decisions.linkedEmptyDescription}
      />
    );
  }
  return <LinkedList links={links} />;
}

type DecisionQuery = ReturnType<typeof useDecision>;

interface PanelViewProps extends ObjectPanelComponentProps {
  query: DecisionQuery;
  projectId: string;
}

function DecisionPanelView({ query, projectId, ...props }: Readonly<PanelViewProps>) {
  const { t, format } = useI18n();
  const st = useTranslations();
  const copy = t.flowGovernance.decisions;
  const common = t.flowGovernance.common;
  const { abilities, memberOf, memberOptions } = useGovernance(projectId);
  const decisionsQuery = useDecisions(projectId);
  const remove = useDeleteDecision();

  const [dialog, setDialog] = useState<DecisionDialogState | null>(null);
  const [confirming, setConfirming] = useState(false);

  const decision = query.data;
  const notFound = query.isError && isApiError(query.error) && query.error.status === 404;
  const linkCount = decision?.links.length ?? 0;
  const canRecord = decision?.status === 'proposed' && abilities.update;
  const canReplace = decision?.status === 'decided' && abilities.manage;

  const shell = useObjectPanelShell({
    ...props,
    width: DECISION_PANEL_WIDTH,
    loading: query.isLoading && !decision,
  });

  const tabs = useMemo(
    () => decisionTabs({ details: st('sweep.entities.detailsTab'), linked: copy.sections.linked, linkedCount: linkCount || undefined }),
    [st, copy.sections.linked, linkCount],
  );
  const [activeTab, setActiveTab] = usePanelInitialTab<DecisionTabId>(tabs, props.initialTab, 'details');

  const confirmDelete = async () => {
    if (!decision) return;
    try {
      await remove.mutateAsync(decision.id);
      toast.success(copy.toasts.deleted);
      setConfirming(false);
      props.onClose();
    } catch {
      toast.error(common.deleteFailed);
    }
  };

  const decisions = useMemo(() => decisionsQuery.data ?? [], [decisionsQuery.data]);
  const title: ReactNode = decision ? (
    <span className="relative top-px text-[15px] font-medium text-foreground">{decision.title}</span>
  ) : (
    <div className="h-4 w-32 animate-pulse rounded bg-muted" />
  );

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        contentClassName={tabBodyClassName(shell.mode)}
        title={title}
        titleWrap
        actions={
          decision ? (
            <HeaderActions
              abilities={abilities}
              canRecord={canRecord}
              canReplace={canReplace}
              onEdit={() => setDialog({ kind: 'edit', decision })}
              onDecide={() => setDialog({ kind: 'decide', decision })}
              onSupersede={() => setDialog({ kind: 'supersede', decision })}
              onDelete={() => setConfirming(true)}
            />
          ) : null
        }
        tabs={
          <ConfigurablePanelTabs
            objectType={DECISION_PANEL_TYPE}
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={shell.mode}
          />
        }
      >
        {!query.isLoading && !decision ? <LoadError notFound={notFound} onRetry={() => void query.refetch()} /> : null}
        {decision && activeTab === 'details' ? (
          <DetailsTab decision={decision} canRecord={canRecord} onDecide={() => setDialog({ kind: 'decide', decision })} memberOf={memberOf} />
        ) : null}
        {decision && activeTab === 'linked' ? <LinkedTab links={decision.links} /> : null}
      </EntityDetailView>

      <DecisionDialogs
        projectId={projectId}
        memberOptions={memberOptions}
        decisions={decisions}
        state={dialog}
        onClose={() => setDialog(null)}
        onSaved={() => setDialog(null)}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => (open ? undefined : setConfirming(false))}
        title={decision ? format(common.deleteConfirmTitle, { code: decision.code }) : ''}
        description={common.deleteConfirmDescription}
        confirmLabel={common.delete}
        cancelLabel={common.cancel}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}

/** The panel of a decision, registered as the `decision` object panel. */
export function DecisionPanel(props: Readonly<ObjectPanelComponentProps>) {
  const query = useDecision(props.id);
  const projectId = query.data?.projectId ?? '';
  return (
    <ProjectPermissionProvider projectId={projectId}>
      <DecisionPanelView {...props} query={query} projectId={projectId} />
    </ProjectPermissionProvider>
  );
}
