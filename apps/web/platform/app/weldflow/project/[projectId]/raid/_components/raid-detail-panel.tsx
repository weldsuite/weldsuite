/**
 * The detail panel of a RAID item: what it is, who owns it, its assessment (for
 * a risk), the tasks behind it and the actions on it (reassess, convert, edit,
 * delete). It sits next to the register instead of over it, so the task panel
 * can open beside it.
 */

import { AskSponsorAction, needsSponsorAcceptance } from './ask-sponsor-action';
import { useState, type ReactNode } from 'react';
import { ArrowRightLeft, MoreHorizontal, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import type { RaidItem, RaidItemDetail } from '@weldsuite/app-api-client/domains/project-control';
import { useRouter } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useDeleteRaidItem, useRaidItem } from '@/hooks/queries/use-project-control-queries';
import { categoryLabel, confidenceLabel, directionLabel, partyTypeLabel, reviewEveryLabel, strategyLabel } from '../_lib/copy';
import { intlLocaleOf } from '../_lib/locale';
import { RAID_KIND_PATHS, formatShortDate, linkedMilestones, linkedRaidItems, linkedTasks } from '../_lib/raid';
import { isOpenItem, isOverdue, reviewIntervalDays, reviewIntervalLabel } from '../_lib/risk';
import { AssessDialog } from './assess-dialog';
import { ConvertDialog } from './convert-dialog';
import { AssessmentHistory, AssessmentSummary } from './detail-assessment';
import { MilestoneValue } from './detail-milestone';
import { DetailTasks } from './detail-tasks';
import { OwnerCell, ScoreBadge, SeverityBadge, StatusPill } from './raid-parts';
import { useRaid } from './raid-context';
import { CreateTaskDialog, LinkTaskDialog } from './task-dialogs';

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
    <dl className="mx-6 mt-3 grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 border-y py-4 text-[13px]">
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

function ItemActionsMenu({ item, onConvert, onDelete }: Readonly<ItemActionsMenuProps>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const { abilities, openEdit } = useRaid();
  const convertible = isOpenItem(item) && (item.kind === 'assumption' || item.kind === 'risk');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="icon-sm" aria-label={copy.detail.moreActions} title={copy.detail.moreActions}>
          <MoreHorizontal aria-hidden />
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

interface DetailHeaderProps {
  item: RaidItem | undefined;
  onAssess: (item: RaidItem) => void;
  onConvert: (item: RaidItem) => void;
  onDelete: (item: RaidItem) => void;
}

function DetailHeader({ item, onAssess, onConvert, onDelete }: Readonly<DetailHeaderProps>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const { projectName, abilities, select } = useRaid();
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <Button type="button" variant="ghost" size="icon-sm" onClick={() => select(null)} aria-label={copy.detail.close} title={copy.detail.close}>
        <X aria-hidden />
      </Button>
      <span className="min-w-0 truncate text-[13px] text-muted-foreground">{projectName}</span>
      {item ? (
        <>
          <span aria-hidden className="text-muted-foreground/60">/</span>
          <span className="shrink-0 text-[13px] font-medium">{item.code}</span>
        </>
      ) : null}
      <div className="min-w-0 flex-1" />
      {item && isOpenItem(item) && abilities.update && item.kind === 'risk' ? (
        <Button type="button" variant="outline" size="sm" onClick={() => onAssess(item)}>
          <RefreshCw aria-hidden />
          {copy.detail.reassess}
        </Button>
      ) : null}
      {item && abilities.update && needsSponsorAcceptance(item) ? <AskSponsorAction item={item} /> : null}
      {item && (abilities.update || abilities.remove) ? <ItemActionsMenu item={item} onConvert={onConvert} onDelete={onDelete} /> : null}
    </div>
  );
}

const PILL_RED = 'rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950 dark:text-red-200';

function ItemBadges({ item }: Readonly<{ item: RaidItem }>) {
  const { t, language, format } = useI18n();
  const copy = t.projects.raid;
  const { now } = useRaid();
  const open = isOpenItem(item);
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2">
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

interface ItemBodyProps {
  item: RaidItem;
  detail: RaidItemDetail | undefined;
  tasks: ReturnType<typeof linkedTasks>;
  onCreateTask: (item: RaidItem) => void;
  onLinkTask: (item: RaidItem) => void;
}

function ItemBody({ item, detail, tasks, onCreateTask, onLinkTask }: Readonly<ItemBodyProps>) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 pt-5">
        <h1 className="text-xl leading-snug font-semibold">{item.title}</h1>
        <ItemBadges item={item} />
        {item.description ? <p className="mt-3.5 text-[13px] leading-relaxed whitespace-pre-wrap text-foreground/80">{item.description}</p> : null}
      </div>

      <Properties item={item} detail={detail} />

      {item.kind === 'risk' ? <AssessmentSummary risk={item} assessments={detail?.assessments} /> : null}

      {item.kind === 'risk' || item.kind === 'issue' ? (
        <DetailTasks item={item} tasks={detail ? tasks : undefined} onCreateTask={() => onCreateTask(item)} onLinkTask={() => onLinkTask(item)} />
      ) : null}

      <LinkedItems detail={detail} />

      {item.kind === 'risk' ? <AssessmentHistory assessments={detail?.assessments} /> : <div className="pb-7" />}
    </div>
  );
}

interface RaidDetailPanelProps {
  itemId: string;
}

/** The panel for the selected item. */
export function RaidDetailPanel({ itemId }: Readonly<RaidDetailPanelProps>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid;
  const router = useRouter();
  const { projectId, items, select } = useRaid();
  const query = useRaidItem(itemId);
  const deleteItem = useDeleteRaidItem();

  const [assessing, setAssessing] = useState<RaidItem | null>(null);
  const [converting, setConverting] = useState<RaidItem | null>(null);
  const [creatingTask, setCreatingTask] = useState<RaidItem | null>(null);
  const [linkingTask, setLinkingTask] = useState<RaidItem | null>(null);
  const [deleting, setDeleting] = useState<RaidItem | null>(null);

  const detail = query.data;
  const item: RaidItem | undefined = detail ?? items.find((candidate) => candidate.id === itemId);
  const notFound = query.isError && isApiError(query.error) && query.error.status === 404;
  const tasks = linkedTasks(detail);

  let body: ReactNode;
  if (!item && notFound) {
    body = <PanelMessage text={copy.detail.notFound} />;
  } else if (!item && query.isError) {
    body = <PanelMessage text={copy.detail.loadFailed} action={{ label: copy.states.retry, onClick: () => void query.refetch() }} />;
  } else if (!item) {
    body = (
      <div className="space-y-4 p-6" role="status" aria-busy="true">
        <Skeleton className="h-7 w-3/4" />
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-24" />
      </div>
    );
  } else {
    body = <ItemBody item={item} detail={detail} tasks={tasks} onCreateTask={setCreatingTask} onLinkTask={setLinkingTask} />;
  }

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteItem.mutateAsync(deleting.id);
      toast.success(copy.toasts.deleted);
      setDeleting(null);
      select(null);
    } catch {
      toast.error(copy.toasts.deleteFailed);
    }
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col')}>
      <DetailHeader item={item} onAssess={setAssessing} onConvert={setConverting} onDelete={setDeleting} />
      {body}

      <AssessDialog risk={assessing} onClose={() => setAssessing(null)} />
      <ConvertDialog
        item={converting}
        onClose={() => setConverting(null)}
        onConverted={(created) => {
          router.push(`/weldflow/project/${projectId}/raid${RAID_KIND_PATHS[created.kind]}`);
          select(created.id);
        }}
      />
      <CreateTaskDialog item={creatingTask} onClose={() => setCreatingTask(null)} />
      <LinkTaskDialog item={linkingTask} linkedTaskIds={new Set(tasks.map((link) => link.target.id))} onClose={() => setLinkingTask(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={deleting ? format(copy.deleteDialog.title, { code: deleting.code }) : ''}
        description={deleting ? format(copy.deleteDialog.description, { title: deleting.title }) : ''}
        confirmLabel={copy.deleteDialog.confirm}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        loading={deleteItem.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function PanelMessage({ text, action }: Readonly<{ text: string; action?: { label: string; onClick: () => void } }>) {
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
      {action ? (
        <Button type="button" variant="outline" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
