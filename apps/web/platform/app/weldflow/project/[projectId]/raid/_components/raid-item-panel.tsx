/**
 * The object panel of a RAID item (risk, assumption, issue or dependency), on
 * the same shell as the task panel: `useObjectPanelShell` + `EntityDetailView`
 * + the configurable tab strip, so it has the shared header (close, expand,
 * back, previous / next) and opens over the page like every record.
 *
 * Tabs: Details (what it is, its facts and assessment, linked items) · Tasks
 * (mitigation or resolution, for risks and issues) · History (assessments, for
 * risks). The object panel host sits outside the RAID tab, so the panel builds
 * its own RAID context from the item's project.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { ArrowRightLeft, EllipsisVertical, History, LayoutGrid, ListChecks, Pencil, RefreshCw, Trash2 } from 'lucide-react';
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
import type { RaidItem, RaidItemDetail, RaidKind } from '@weldsuite/app-api-client/domains/project-control';
import {
  useObjectPanel,
  useObjectPanelShell,
  type ObjectPanelComponentProps,
  type ObjectPanelTabDescriptor,
} from '@/components/object-panel';
import { ConfigurablePanelTabs } from '@/components/objects/_shared/configurable-panel-tabs';
import { usePanelInitialTab } from '@/components/objects/_shared/use-panel-initial-tab';
import { ProjectPermissionProvider } from '@/app/weldflow/contexts/project-permission-context';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useDeleteRaidItem, useRaidItem, useRaidItems } from '@/hooks/queries/use-project-control-queries';
import { useProject } from '@/hooks/queries/use-projects-queries';
import { categoryLabel, confidenceLabel, directionLabel, partyTypeLabel, reviewEveryLabel, strategyLabel } from '../_lib/copy';
import { intlLocaleOf } from '../_lib/locale';
import { EMPTY_FILTERS, RAID_KIND_PATHS, formatShortDate, linkedMilestones, linkedRaidItems, linkedTasks } from '../_lib/raid';
import { isOpenItem, isOverdue, reviewIntervalDays, reviewIntervalLabel } from '../_lib/risk';
import { AskSponsorAction, needsSponsorAcceptance } from './ask-sponsor-action';
import { AssessDialog } from './assess-dialog';
import { ConvertDialog } from './convert-dialog';
import { AssessmentHistory, AssessmentSummary } from './detail-assessment';
import { MilestoneValue } from './detail-milestone';
import { DetailTasks } from './detail-tasks';
import { ItemDialog, type ItemDialogState } from './item-dialog';
import { OwnerCell, ScoreBadge, SeverityBadge, StatusPill } from './raid-parts';
import { RAID_ITEM_PANEL_TYPE } from './raid-item-panel-type';
import {
  RaidContext,
  useRaid,
  useRaidAbilities,
  useRaidMembers,
  useToday,
  type RaidContextValue,
} from './raid-context';
import { CreateTaskDialog, LinkTaskDialog } from './task-dialogs';

/** The task panel's width, so a RAID item and a task opened from it take the same room. */
const RAID_ITEM_PANEL_WIDTH = 400;

function Property({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

function DueValue({ item }: Readonly<{ item: RaidItem }>) {
  const { t, language } = useI18n();
  const { now } = useRaid();
  if (!item.dueAt) return <span className="text-muted-foreground">{t.projects.raid.tasks.noDate}</span>;
  const overdue = isOpenItem(item) && isOverdue(item.dueAt, now);
  return (
    <span className={overdue ? 'font-medium text-red-700 dark:text-red-400' : undefined}>{formatShortDate(item.dueAt, intlLocaleOf(language), now)}</span>
  );
}

function RiskProperties({ item, detail }: Readonly<{ item: RaidItem; detail: RaidItemDetail | undefined }>) {
  const { t, language, format, plural } = useI18n();
  const copy = t.projects.raid;
  const { now } = useRaid();
  const intlLocale = intlLocaleOf(language);
  const overdue = isOpenItem(item) && isOverdue(item.dueAt, now);
  const date = item.dueAt ? formatShortDate(item.dueAt, intlLocale, now) : null;
  const dueClass = overdue ? 'font-medium text-red-700 dark:text-red-400' : undefined;
  const impactText = [
    item.scheduleImpactDays !== null ? plural(item.scheduleImpactDays, copy.detail.scheduleImpact) : null,
    item.costImpact !== null
      ? format(copy.detail.costImpact, {
          amount: new Intl.NumberFormat(intlLocale, { maximumFractionDigits: 2 }).format(Number(item.costImpact)),
        })
      : null,
  ].filter(Boolean);

  return (
    <>
      {item.strategy ? <Property label={copy.detail.strategy}>{strategyLabel(copy, item.strategy)}</Property> : null}
      <Property label={copy.detail.nextReview}>
        {date ? (
          <span className={dueClass}>
            {date}
            {' · '}
            {reviewEveryLabel(copy, reviewIntervalLabel(reviewIntervalDays(item.band ?? 'medium', item.reviewIntervalDays)), format)}
          </span>
        ) : (
          <span className="text-muted-foreground">{copy.tasks.noDate}</span>
        )}
      </Property>
      <Property label={copy.detail.milestone}>
        <MilestoneValue item={item} links={linkedMilestones(detail)} />
      </Property>
      {impactText.length > 0 ? <Property label={copy.detail.ifItHappens}>{impactText.join(' · ')}</Property> : null}
      {item.trigger ? <Property label={copy.detail.earlyWarning}><span className="leading-snug whitespace-pre-wrap">{item.trigger}</span></Property> : null}
    </>
  );
}

function AssumptionProperties({ item }: Readonly<{ item: RaidItem }>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  return (
    <>
      <Property label={copy.detail.confidence}>{confidenceLabel(copy, item.confidence) ?? '—'}</Property>
      <Property label={copy.detail.validateBy}>
        <DueValue item={item} />
      </Property>
      {item.ifWrong ? <Property label={copy.detail.ifWrong}><span className="leading-snug whitespace-pre-wrap">{item.ifWrong}</span></Property> : null}
    </>
  );
}

function IssueProperties({ item }: Readonly<{ item: RaidItem }>) {
  const { t, language } = useI18n();
  const copy = t.projects.raid;
  const { now } = useRaid();
  return (
    <>
      <Property label={copy.detail.resolveBy}>
        <DueValue item={item} />
      </Property>
      {item.escalatedAt ? (
        <Property label={copy.detail.escalated}>{formatShortDate(item.escalatedAt, intlLocaleOf(language), now)}</Property>
      ) : null}
    </>
  );
}

function DependencyProperties({ item }: Readonly<{ item: RaidItem }>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  return (
    <>
      <Property label={copy.detail.direction}>{directionLabel(copy, item.direction) ?? '—'}</Property>
      <Property label={copy.detail.otherParty}>
        {[item.partyName, partyTypeLabel(copy, item.partyType)].filter(Boolean).join(' · ') || '—'}
      </Property>
      <Property label={copy.detail.neededBy}>
        <DueValue item={item} />
      </Property>
    </>
  );
}

/** The labelled facts of an item, by kind. */
function Properties({ item, detail }: Readonly<{ item: RaidItem; detail: RaidItemDetail | undefined }>) {
  const { t } = useI18n();
  const copy = t.projects.raid;

  return (
    <dl className="mx-6 mt-4 grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 border-y py-4 text-[13px]">
      <Property label={copy.detail.owner}>
        <OwnerCell ownerId={item.ownerId} />
      </Property>
      {item.kind === 'risk' ? <RiskProperties item={item} detail={detail} /> : null}
      {item.kind === 'assumption' ? <AssumptionProperties item={item} /> : null}
      {item.kind === 'issue' ? <IssueProperties item={item} /> : null}
      {item.kind === 'dependency' ? <DependencyProperties item={item} /> : null}
    </dl>
  );
}

/** What this item came from and what came from it (`raised_from` links). */
function LinkedItems({ detail }: Readonly<{ detail: RaidItemDetail | undefined }>) {
  const { t } = useI18n();
  const copy = t.projects.raid.detail;
  const { select } = useRaid();
  const links = linkedRaidItems(detail);
  if (links.length === 0) return null;
  return (
    <section aria-labelledby="raid-links-title" className="px-6 pt-6">
      <h2 id="raid-links-title" className="mb-2 text-sm font-semibold">
        {copy.links}
      </h2>
      <ul className="rounded-lg border">
        {links.map((link) => (
          <li key={link.id} className="flex items-center gap-2.5 border-b px-3 py-2 text-[13px] last:border-b-0">
            <span className="shrink-0 text-xs text-muted-foreground">
              {link.direction === 'outgoing' ? copy.relation.raisedFrom : copy.relation.ledTo}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{link.target.code}</span>
            <button type="button" onClick={() => select(link.target.id)} className="min-w-0 flex-1 truncate text-left outline-none hover:underline focus-visible:underline">
              {link.target.title}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface ItemActionsMenuProps {
  item: RaidItem;
  onConvert: (item: RaidItem) => void;
  onDelete: (item: RaidItem) => void;
}

/** The three-dot menu of the panel header, as on every object panel. */
function ItemActionsMenu({ item, onConvert, onDelete }: Readonly<ItemActionsMenuProps>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const { abilities, openEdit } = useRaid();
  const convertible = isOpenItem(item) && (item.kind === 'assumption' || item.kind === 'risk');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7 data-[state=open]:bg-accent dark:data-[state=open]:bg-accent/50"
          aria-label={copy.detail.moreActions}
        >
          <EllipsisVertical className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {abilities.update ? (
          <DropdownMenuItem onSelect={() => openEdit(item)}>
            <Pencil aria-hidden />
            {copy.detail.edit}
          </DropdownMenuItem>
        ) : null}
        {abilities.update && convertible ? (
          <DropdownMenuItem onSelect={() => onConvert(item)}>
            <ArrowRightLeft aria-hidden />
            {item.kind === 'assumption' ? copy.detail.convertToRisk : copy.detail.convertToIssue}
          </DropdownMenuItem>
        ) : null}
        {abilities.remove ? (
          <>
            {abilities.update ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(item)}>
              <Trash2 aria-hidden />
              {copy.detail.delete}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface HeaderActionsProps {
  item: RaidItem;
  onAssess: (item: RaidItem) => void;
  onConvert: (item: RaidItem) => void;
  onDelete: (item: RaidItem) => void;
}

/** Reassess (an open risk), ask the sponsor (a risk to accept) and the menu. */
function HeaderActions({ item, onAssess, onConvert, onDelete }: Readonly<HeaderActionsProps>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const { abilities } = useRaid();
  return (
    <div className="flex items-center gap-1.5">
      {isOpenItem(item) && abilities.update && item.kind === 'risk' ? (
        // An icon, as the header actions of the task panel, so the title keeps the room.
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-7"
          onClick={() => onAssess(item)}
          aria-label={copy.detail.reassess}
          title={copy.detail.reassess}
        >
          <RefreshCw className="h-4 w-4 text-muted-foreground" />
        </Button>
      ) : null}
      {abilities.update && needsSponsorAcceptance(item) ? <AskSponsorAction item={item} /> : null}
      {abilities.update || abilities.remove ? <ItemActionsMenu item={item} onConvert={onConvert} onDelete={onDelete} /> : null}
    </div>
  );
}

const PILL_RED = 'rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950 dark:text-red-200';

/** The code, the score or severity, the status and the other flags of an item. */
function ItemBadges({ item }: Readonly<{ item: RaidItem }>) {
  const { t, language, format } = useI18n();
  const copy = t.projects.raid;
  const { now } = useRaid();
  const open = isOpenItem(item);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex h-[20px] items-center rounded bg-gray-100 px-1.5 font-mono text-[11px] leading-none text-gray-500 dark:bg-secondary dark:text-muted-foreground">
        {item.code}
      </span>
      {item.kind === 'risk' && item.score !== null && item.band !== null ? <ScoreBadge score={item.score} band={item.band} /> : null}
      {item.kind === 'issue' ? <SeverityBadge severity={item.severity} /> : null}
      <StatusPill kind={item.kind} status={item.status} />
      {item.category ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground/80">{categoryLabel(copy, item.category)}</span> : null}
      {item.kind === 'issue' && item.escalatedAt && open ? <span className={PILL_RED}>{copy.register.escalated}</span> : null}
      {item.kind === 'risk' && open && isOverdue(item.dueAt, now) ? <span className={PILL_RED}>{copy.detail.reviewOverdue}</span> : null}
      {item.closedAt ? (
        <span className="text-xs text-muted-foreground">{format(copy.detail.closed, { date: formatShortDate(item.closedAt, intlLocaleOf(language), now) })}</span>
      ) : null}
    </div>
  );
}

/** Details tab: the badges, the description, the facts, the assessment (a risk) and the linked items. */
function DetailsTab({ item, detail }: Readonly<{ item: RaidItem; detail: RaidItemDetail | undefined }>) {
  return (
    <div className="pb-7">
      <div className="px-6 pt-5">
        <ItemBadges item={item} />
        {item.description ? <p className="mt-3.5 text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/80">{item.description}</p> : null}
      </div>
      <Properties item={item} detail={detail} />
      {item.kind === 'risk' ? <AssessmentSummary risk={item} assessments={detail?.assessments} /> : null}
      <LinkedItems detail={detail} />
    </div>
  );
}

type RaidItemTabId = 'details' | 'tasks' | 'history';

interface RaidItemTab extends ObjectPanelTabDescriptor {
  id: RaidItemTabId;
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

/** The tabs of a kind: tasks back risks and issues, assessments only risks. */
function raidItemTabs(kind: RaidKind | undefined, labels: { details: string; tasks: string; history: string; tasksCount?: number }): RaidItemTab[] {
  const shown = { defaultVisibleInPanel: true, defaultVisibleInFullscreen: true };
  const tabs: RaidItemTab[] = [{ id: 'details', label: labels.details, icon: LayoutGrid, required: true, ...shown }];
  if (kind === 'risk' || kind === 'issue') tabs.push({ id: 'tasks', label: labels.tasks, icon: ListChecks, count: labels.tasksCount, ...shown });
  if (kind === 'risk') tabs.push({ id: 'history', label: labels.history, icon: History, ...shown });
  return tabs;
}

/** The item could not be loaded: gone, or a failure that can be retried. */
function LoadError({ notFound, onRetry }: Readonly<{ notFound: boolean; onRetry: () => void }>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  return (
    <div className="space-y-3 p-4">
      <p className="text-sm text-muted-foreground" role="alert">
        {notFound ? copy.detail.notFound : copy.detail.loadFailed}
      </p>
      {notFound ? null : (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {copy.states.retry}
        </Button>
      )}
    </div>
  );
}

interface PanelContextProps {
  projectId: string;
  itemId: string;
  kind: RaidKind;
  onClose: () => void;
  children: ReactNode;
}

/**
 * The RAID context the item's parts read, built for the panel: the project's
 * members and grants, today, and the edit dialog. Another item opened from this
 * one (a linked item) goes on top of the panel, with a back arrow.
 */
function RaidPanelContext({ projectId, itemId, kind, onClose, children }: Readonly<PanelContextProps>) {
  const abilities = useRaidAbilities();
  const itemsQuery = useRaidItems(projectId);
  const projectQuery = useProject(projectId);
  const { members, memberOf } = useRaidMembers(projectId);
  const { open } = useObjectPanel();
  const now = useToday();
  const [dialog, setDialog] = useState<ItemDialogState | null>(null);
  const items = useMemo(() => itemsQuery.data ?? [], [itemsQuery.data]);

  const value: RaidContextValue = {
    projectId,
    projectName: projectQuery.data?.data?.name ?? '',
    items,
    isLoading: itemsQuery.isLoading,
    isError: itemsQuery.isError && !itemsQuery.data,
    retry: () => void itemsQuery.refetch(),
    now,
    members,
    memberOf,
    abilities,
    selectedId: itemId,
    select: (id) => (id ? open({ type: RAID_ITEM_PANEL_TYPE, id, stack: true }) : onClose()),
    openCreate: (newKind) => setDialog({ mode: 'create', kind: newKind }),
    openEdit: (item) => setDialog({ mode: 'edit', item }),
    // The register's toolbar state belongs to the RAID tab; the panel has none.
    activeKind: kind,
    filters: EMPTY_FILTERS,
    setFilters: () => undefined,
    showClosed: false,
    toggleShowClosed: () => undefined,
  };

  return (
    <RaidContext.Provider value={value}>
      {children}
      <ItemDialog state={dialog} onClose={() => setDialog(null)} />
    </RaidContext.Provider>
  );
}

type ItemQuery = ReturnType<typeof useRaidItem>;

function RaidItemPanelView({ query, ...props }: Readonly<ObjectPanelComponentProps & { query: ItemQuery }>) {
  const { t, format } = useI18n();
  const st = useTranslations();
  const copy = t.projects.raid;
  const router = useRouter();
  const { projectId } = useRaid();
  const { open } = useObjectPanel();
  const deleteItem = useDeleteRaidItem();

  const [assessing, setAssessing] = useState<RaidItem | null>(null);
  const [converting, setConverting] = useState<RaidItem | null>(null);
  const [creatingTask, setCreatingTask] = useState<RaidItem | null>(null);
  const [linkingTask, setLinkingTask] = useState<RaidItem | null>(null);
  const [deleting, setDeleting] = useState<RaidItem | null>(null);

  const detail = query.data;
  const item: RaidItem | undefined = detail;
  const notFound = query.isError && isApiError(query.error) && query.error.status === 404;
  const tasks = linkedTasks(detail);

  const shell = useObjectPanelShell({
    ...props,
    width: RAID_ITEM_PANEL_WIDTH,
    loading: query.isLoading && !item,
  });

  const tabs = useMemo(
    () =>
      raidItemTabs(item?.kind, {
        details: st('sweep.entities.detailsTab'),
        tasks: item?.kind === 'issue' ? copy.tasks.resolution : copy.tasks.mitigation,
        history: copy.detail.history,
        tasksCount: item?.taskProgress.total || undefined,
      }),
    [st, copy, item?.kind, item?.taskProgress.total],
  );
  // A deep-linked tab that only appears once the item is loaded is applied when it does.
  const [activeTab, setActiveTab] = usePanelInitialTab<RaidItemTabId>(tabs, props.initialTab, 'details');

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteItem.mutateAsync(deleting.id);
      toast.success(copy.toasts.deleted);
      setDeleting(null);
      props.onClose();
    } catch {
      toast.error(copy.toasts.deleteFailed);
    }
  };

  return (
    <>
      <EntityDetailView
        {...shell.entityDetailViewProps}
        title={
          item ? (
            <span className="relative top-px text-[15px] font-medium text-foreground">{item.title}</span>
          ) : (
            <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          )
        }
        titleWrap
        actions={item ? <HeaderActions item={item} onAssess={setAssessing} onConvert={setConverting} onDelete={setDeleting} /> : null}
        tabs={
          <ConfigurablePanelTabs
            objectType={RAID_ITEM_PANEL_TYPE}
            tabs={tabs}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            mode={shell.mode}
          />
        }
      >
        {!query.isLoading && !item ? <LoadError notFound={notFound} onRetry={() => void query.refetch()} /> : null}
        {item && activeTab === 'details' ? <DetailsTab item={item} detail={detail} /> : null}
        {item && activeTab === 'tasks' ? (
          <div className="pb-7">
            <DetailTasks item={item} tasks={detail ? tasks : undefined} onCreateTask={() => setCreatingTask(item)} onLinkTask={() => setLinkingTask(item)} />
          </div>
        ) : null}
        {item && activeTab === 'history' ? <AssessmentHistory assessments={detail?.assessments} /> : null}
      </EntityDetailView>

      <AssessDialog risk={assessing} onClose={() => setAssessing(null)} />
      <ConvertDialog
        item={converting}
        onClose={() => setConverting(null)}
        onConverted={(created) => {
          router.push(`/weldflow/project/${projectId}/raid${RAID_KIND_PATHS[created.kind]}`);
          open({ type: RAID_ITEM_PANEL_TYPE, id: created.id });
        }}
      />
      <CreateTaskDialog item={creatingTask} onClose={() => setCreatingTask(null)} />
      <LinkTaskDialog item={linkingTask} linkedTaskIds={new Set(tasks.map((link) => link.target.id))} onClose={() => setLinkingTask(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(isOpen) => (isOpen ? undefined : setDeleting(null))}
        title={deleting ? format(copy.deleteDialog.title, { code: deleting.code }) : ''}
        description={deleting ? format(copy.deleteDialog.description, { title: deleting.title }) : ''}
        confirmLabel={copy.deleteDialog.confirm}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        loading={deleteItem.isPending}
        onConfirm={confirmDelete}
      />
    </>
  );
}

/** The panel of a RAID item, registered as the `raid_item` object panel. */
export function RaidItemPanel(props: Readonly<ObjectPanelComponentProps>) {
  const query = useRaidItem(props.id);
  const projectId = query.data?.projectId ?? '';
  return (
    <ProjectPermissionProvider projectId={projectId}>
      <RaidPanelContext projectId={projectId} itemId={props.id} kind={query.data?.kind ?? 'risk'} onClose={props.onClose}>
        <RaidItemPanelView {...props} query={query} />
      </RaidPanelContext>
    </ProjectPermissionProvider>
  );
}
