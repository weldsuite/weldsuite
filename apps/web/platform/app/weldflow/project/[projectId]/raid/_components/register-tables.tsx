/**
 * The tables of assumptions, issues and dependencies. Each row opens the
 * item's detail panel.
 */

import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { RaidItem } from '@weldsuite/app-api-client/domains/project-control';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useProjects } from '@/hooks/queries/use-projects-queries';
import { intlLocaleOf } from '../_lib/locale';
import { partyTypeLabel } from '../_lib/copy';
import { ageInDays, formatShortDate } from '../_lib/raid';
import { ConfidenceBars, DueLabel, ItemCode, OwnerCell, SeverityBadge, StatusPill, TaskProgress } from './raid-parts';
import { useRaid } from './raid-context';

interface TableProps {
  items: RaidItem[];
  /** Shown when nothing is listed. */
  emptyText: string;
}

function TableShell({
  label,
  minWidth,
  heads,
  empty,
  children,
}: Readonly<{ label: string; minWidth: string; heads: string[]; empty: ReactNode; children: ReactNode }>) {
  return (
    <section aria-label={label} className="overflow-hidden rounded-lg border bg-card text-card-foreground">
      <div className="overflow-x-auto">
        <table className={cn('w-full border-collapse text-[13px]', minWidth)}>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              {heads.map((head, index) => (
                <th
                  key={head}
                  scope="col"
                  className={cn('py-2.5 font-medium', index === 0 ? 'px-4' : 'px-2', index === heads.length - 1 && 'pr-4')}
                >
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {empty}
    </section>
  );
}

function EmptyRows({ show, text }: Readonly<{ show: boolean; text: string }>) {
  return show ? <div className="px-4 py-10 text-center text-sm text-muted-foreground">{text}</div> : null;
}

/** A row that opens the item; the title is the keyboard target. */
function ItemRow({ item, children }: Readonly<{ item: RaidItem; children: ReactNode }>) {
  const { selectedId, select } = useRaid();
  const selected = item.id === selectedId;
  return (
    <tr
      aria-current={selected ? 'true' : undefined}
      onClick={() => select(item.id)}
      className={cn('cursor-pointer border-t align-top transition-colors hover:bg-accent/40', selected && 'bg-accent/60')}
    >
      {children}
    </tr>
  );
}

function TitleCell({ item, secondary }: Readonly<{ item: RaidItem; secondary?: string | null }>) {
  return (
    <td className="max-w-[28rem] px-4 py-3">
      <div className="flex gap-2">
        <ItemCode code={item.code} className="pt-px" />
        <div className="min-w-0">
          <button type="button" className="text-left font-medium outline-none hover:underline focus-visible:underline">
            {item.title}
          </button>
          {secondary ? <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{secondary}</div> : null}
        </div>
      </div>
    </td>
  );
}

// ── Assumptions ─────────────────────────────────────────────────────────────

export function AssumptionsTable({ items, emptyText }: Readonly<TableProps>) {
  const { t, language, format } = useI18n();
  const copy = t.projects.raid;
  const { now } = useRaid();
  const intlLocale = intlLocaleOf(language);

  return (
    <TableShell
      label={copy.tabs.assumption}
      minWidth="min-w-[48rem]"
      heads={[copy.columns.assumption, copy.columns.confidence, copy.columns.owner, copy.columns.validateBy, copy.columns.status]}
      empty={<EmptyRows show={items.length === 0} text={emptyText} />}
    >
      {items.map((item) => {
        const closedTemplate = item.status === 'invalid' ? copy.due.provedWrongOn : copy.due.validatedOn;
        const closedText = item.closedAt ? format(closedTemplate, { date: formatShortDate(item.closedAt, intlLocale, now) }) : null;
        return (
          <ItemRow key={item.id} item={item}>
            <TitleCell
              item={item}
              secondary={item.ifWrong ? `${copy.detail.ifWrong}: ${item.ifWrong}` : null}
            />
            <td className="px-2 py-3"><ConfidenceBars confidence={item.confidence} /></td>
            <td className="px-2 py-3"><OwnerCell ownerId={item.ownerId} /></td>
            <td className="px-2 py-3"><DueLabel dueAt={item.dueAt} closedText={closedText} /></td>
            <td className="py-3 pr-4 pl-2"><StatusPill kind="assumption" status={item.status} /></td>
          </ItemRow>
        );
      })}
    </TableShell>
  );
}

// ── Issues ──────────────────────────────────────────────────────────────────

export function IssuesTable({ items, emptyText }: Readonly<TableProps>) {
  const { t, plural } = useI18n();
  const copy = t.projects.raid;
  const { now } = useRaid();

  return (
    <TableShell
      label={copy.tabs.issue}
      minWidth="min-w-[56rem]"
      heads={[
        copy.columns.issue,
        copy.columns.severity,
        copy.columns.owner,
        copy.columns.openFor,
        copy.columns.resolveBy,
        copy.columns.resolution,
        copy.columns.status,
      ]}
      empty={<EmptyRows show={items.length === 0} text={emptyText} />}
    >
      {items.map((item) => (
        <ItemRow key={item.id} item={item}>
          <TitleCell item={item} secondary={item.description} />
          <td className="px-2 py-3"><SeverityBadge severity={item.severity} /></td>
          <td className="px-2 py-3"><OwnerCell ownerId={item.ownerId} /></td>
          <td className="px-2 py-3 text-xs whitespace-nowrap text-muted-foreground">
            {item.closedAt ? '—' : plural(ageInDays(item.createdAt, now), copy.tiles.days)}
          </td>
          <td className="px-2 py-3"><DueLabel dueAt={item.closedAt ? null : item.dueAt} /></td>
          <td className="w-36 px-2 py-3">
            {item.taskProgress.total > 0 ? (
              <TaskProgress progress={item.taskProgress} />
            ) : (
              <span className="text-xs text-muted-foreground">{copy.register.noTasks}</span>
            )}
          </td>
          <td className="py-3 pr-4 pl-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusPill kind="issue" status={item.status} />
              {item.escalatedAt && !item.closedAt ? (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950 dark:text-red-200">
                  {copy.register.escalated}
                </span>
              ) : null}
            </div>
          </td>
        </ItemRow>
      ))}
    </TableShell>
  );
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

export function DependenciesTable({ items, emptyText }: Readonly<TableProps>) {
  const { t } = useI18n();
  const copy = t.projects.raid;
  const projectNames = usePartyProjectNames(items);

  return (
    <TableShell
      label={copy.tabs.dependency}
      minWidth="min-w-[48rem]"
      heads={[copy.columns.dependency, copy.columns.direction, copy.columns.otherParty, copy.columns.neededBy, copy.columns.status]}
      empty={<EmptyRows show={items.length === 0} text={emptyText} />}
    >
      {items.map((item) => {
        const inbound = item.direction !== 'outbound';
        const party = (item.partyProjectId ? projectNames.get(item.partyProjectId) : null) ?? item.partyName;
        return (
          <ItemRow key={item.id} item={item}>
            <TitleCell item={item} />
            <td className="px-2 py-3">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium whitespace-nowrap text-foreground/80">
                {inbound ? <ArrowLeft aria-hidden className="size-3" /> : null}
                {inbound ? copy.direction.inbound : copy.direction.outbound}
                {inbound ? null : <ArrowRight aria-hidden className="size-3" />}
              </span>
            </td>
            <td className="px-2 py-3">
              {party ? <div className="font-medium">{party}</div> : <div className="text-xs text-muted-foreground">—</div>}
              {item.partyType ? <div className="mt-0.5 text-xs text-muted-foreground">{partyTypeLabel(copy, item.partyType)}</div> : null}
            </td>
            <td className="px-2 py-3"><DueLabel dueAt={item.closedAt ? null : item.dueAt} /></td>
            <td className="py-3 pr-4 pl-2"><StatusPill kind="dependency" status={item.status} /></td>
          </ItemRow>
        );
      })}
    </TableShell>
  );
}
