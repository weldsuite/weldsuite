/**
 * The lists of assumptions, issues and dependencies, as the standard list.
 * Each row opens the item's detail panel.
 */

import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { RaidItem } from '@weldsuite/app-api-client/domains/project-control';
import { useI18n } from '@/lib/i18n/provider';
import { useProjects } from '@/hooks/queries/use-projects-queries';
import { intlLocaleOf } from '../_lib/locale';
import { partyTypeLabel } from '../_lib/copy';
import { ageInDays, formatShortDate } from '../_lib/raid';
import { ConfidenceBars, TaskProgress } from './raid-parts';
import { ListDue, ListOwner, ListPill, ListSeverity, ListStatus, ListText, RaidItemList, titleColumn, type RaidListColumn } from './raid-list';
import { useRaid } from './raid-context';

interface ListProps {
  items: RaidItem[];
  /** Shown when nothing is listed while no search or filter is set. */
  emptyText: string;
}

// ── Assumptions ─────────────────────────────────────────────────────────────

export function AssumptionsList({ items, emptyText }: Readonly<ListProps>) {
  const { t, language, format } = useI18n();
  const copy = t.projects.raid;
  const { now } = useRaid();
  const intlLocale = intlLocaleOf(language);

  const columns: RaidListColumn[] = [
    titleColumn(copy.columns.assumption),
    { id: 'confidence', header: copy.columns.confidence, width: 'hidden w-[110px] @lg:flex', render: (item) => <ConfidenceBars confidence={item.confidence} /> },
    { id: 'owner', header: copy.columns.owner, width: 'hidden w-[150px] @3xl:flex', render: (item) => <ListOwner ownerId={item.ownerId} /> },
    {
      id: 'validateBy',
      header: copy.columns.validateBy,
      width: 'hidden w-[120px] @4xl:flex',
      render: (item) => {
        const closedTemplate = item.status === 'invalid' ? copy.due.provedWrongOn : copy.due.validatedOn;
        const closedText = item.closedAt ? format(closedTemplate, { date: formatShortDate(item.closedAt, intlLocale, now) }) : null;
        return <ListDue dueAt={item.dueAt} closedText={closedText} />;
      },
    },
    { id: 'status', header: copy.columns.status, width: 'w-[120px]', render: (item) => <ListStatus kind="assumption" status={item.status} /> },
  ];

  return <RaidItemList label={copy.tabs.assumption} items={items} columns={columns} emptyText={emptyText} />;
}

// ── Issues ──────────────────────────────────────────────────────────────────

export function IssuesList({ items, emptyText }: Readonly<ListProps>) {
  const { t, plural } = useI18n();
  const copy = t.projects.raid;
  const { now } = useRaid();

  const columns: RaidListColumn[] = [
    titleColumn(copy.columns.issue),
    { id: 'severity', header: copy.columns.severity, width: 'hidden w-[90px] @lg:flex', render: (item) => <ListSeverity severity={item.severity} /> },
    { id: 'owner', header: copy.columns.owner, width: 'hidden w-[150px] @3xl:flex', render: (item) => <ListOwner ownerId={item.ownerId} /> },
    {
      id: 'openFor',
      header: copy.columns.openFor,
      width: 'hidden w-[90px] @6xl:flex',
      render: (item) => (
        <ListText text={item.closedAt ? null : plural(ageInDays(item.createdAt, now), copy.tiles.days)} />
      ),
    },
    { id: 'resolveBy', header: copy.columns.resolveBy, width: 'hidden w-[104px] @4xl:flex', render: (item) => <ListDue dueAt={item.closedAt ? null : item.dueAt} /> },
    {
      id: 'resolution',
      header: copy.columns.resolution,
      width: 'hidden w-[140px] @5xl:flex',
      render: (item) =>
        item.taskProgress.total > 0 ? (
          <TaskProgress progress={item.taskProgress} />
        ) : (
          <ListText text={copy.register.noTasks} />
        ),
    },
    {
      id: 'status',
      header: copy.columns.status,
      width: 'w-[150px]',
      render: (item) => (
        <div className="flex items-center gap-1.5">
          <ListStatus kind="issue" status={item.status} />
          {item.escalatedAt && !item.closedAt ? (
            <ListPill className="bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200">{copy.register.escalated}</ListPill>
          ) : null}
        </div>
      ),
    },
  ];

  return <RaidItemList label={copy.tabs.issue} items={items} columns={columns} emptyText={emptyText} />;
}

// ── Dependencies ────────────────────────────────────────────────────────────

/** Names of the projects other projects' dependencies point at. */
function usePartyProjectNames(items: readonly RaidItem[]): Map<string, string> {
  const needed = items.some((item) => item.partyProjectId);
  const { data } = useProjects({ pageSize: 100 });
  const names = new Map<string, string>();
  if (needed) {
    for (const project of data?.data ?? []) names.set(project.id, project.name);
  }
  return names;
}

export function DependenciesList({ items, emptyText }: Readonly<ListProps>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const projectNames = usePartyProjectNames(items);

  const columns: RaidListColumn[] = [
    titleColumn(copy.columns.dependency),
    {
      id: 'direction',
      header: copy.columns.direction,
      width: 'hidden w-[110px] @lg:flex',
      render: (item) => {
        const inbound = item.direction !== 'outbound';
        return (
          <ListPill className="bg-muted text-foreground/80">
            {inbound ? <ArrowLeft aria-hidden className="size-3" /> : null}
            {inbound ? copy.direction.inbound : copy.direction.outbound}
            {inbound ? null : <ArrowRight aria-hidden className="size-3" />}
          </ListPill>
        );
      },
    },
    {
      id: 'otherParty',
      header: copy.columns.otherParty,
      width: 'hidden w-[180px] @2xl:flex',
      render: (item) => {
        const party = (item.partyProjectId ? projectNames.get(item.partyProjectId) : null) ?? item.partyName;
        const type = item.partyType ? partyTypeLabel(copy, item.partyType) : null;
        return (
          <ListText text={[party, type].filter(Boolean).join(' · ')} />
        );
      },
    },
    { id: 'neededBy', header: copy.columns.neededBy, width: 'hidden w-[110px] @4xl:flex', render: (item) => <ListDue dueAt={item.closedAt ? null : item.dueAt} /> },
    { id: 'status', header: copy.columns.status, width: 'w-[120px]', render: (item) => <ListStatus kind="dependency" status={item.status} /> },
  ];

  return <RaidItemList label={copy.tabs.dependency} items={items} columns={columns} emptyText={emptyText} />;
}
