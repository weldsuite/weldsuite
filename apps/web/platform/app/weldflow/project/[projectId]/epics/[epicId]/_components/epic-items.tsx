/**
 * The items of an epic, grouped by sprint (oldest first) with the backlog
 * last. A click opens the item in the task panel.
 */

import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { TaskTypeBadge } from '@/components/weldflow/agile/task-type-badge';
import { sumPoints, type BacklogItem, type EpicItemGroup } from '@/app/weldflow/lib/backlog';
import type { ItemTypeNaming } from '@weldsuite/app-api-client/schemas/flow-agile';
import { PointsChip } from '../../../tasks/backlog/_components/backlog-row';

function useStatusLabel(): (status: string) => string {
  const { t } = useI18n();
  const labels = t.projects.tasks;
  const map: Record<string, string> = {
    backlog: labels.statusBacklog,
    todo: labels.statusTodo,
    in_progress: labels.statusInProgress,
    review: labels.statusInReview,
    testing: labels.statusTesting,
    done: labels.statusDone,
    cancelled: labels.statusCancelled,
  };
  return (status) => map[status] ?? status;
}

function groupName(group: EpicItemGroup, page: { backlogGroup: string; completedSprints: string }): string {
  if (group.kind === 'backlog') return page.backlogGroup;
  if (group.kind === 'earlier') return page.completedSprints;
  return group.name ?? '';
}

export function EpicItems({
  groups,
  naming,
  featureLevel,
  onOpen,
}: Readonly<{ groups: readonly EpicItemGroup[]; naming: ItemTypeNaming; featureLevel: boolean; onOpen: (item: BacklogItem) => void }>) {
  const { t, plural, format } = useI18n();
  const copy = t.flowAgileBacklog;
  const statusLabel = useStatusLabel();

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const name = groupName(group, copy.epicPage);
        const status = group.status as keyof typeof t.flowAgile.sprintStatus | null;
        return (
          <section key={group.id} aria-label={name} className="overflow-hidden rounded-lg border border-border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2.5">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">{name}</h3>
                {status && status in t.flowAgile.sprintStatus ? <SoftBadge tone={status === 'active' ? 'success' : 'neutral'}>{t.flowAgile.sprintStatus[status]}</SoftBadge> : null}
              </div>
              <span className="text-xs text-muted-foreground">
                {format(copy.epicPage.groupMeta, {
                  items: plural(group.items.length, copy.backlog.items),
                  points: plural(sumPoints(group.items), t.flowAgile.points),
                })}
              </span>
            </div>
            <ol className="m-0 list-none p-0">
              {group.items.map((item) => {
                const closed = item.status === 'done' || item.status === 'cancelled';
                return (
                  <li key={item.id} className="flex items-center gap-2.5 border-b border-border/70 px-4 py-2 text-sm last:border-b-0">
                    <TaskTypeBadge type={item.type} naming={naming} featureLevel={featureLevel} className="flex-none" />
                    <span className="w-12 flex-none text-xs tabular-nums text-muted-foreground">{item.number != null ? `#${item.number}` : ''}</span>
                    <button
                      type="button"
                      onClick={() => onOpen(item)}
                      className={cn(
                        'min-w-0 flex-1 truncate rounded text-left outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        closed && 'text-muted-foreground',
                      )}
                    >
                      {item.title}
                    </button>
                    <SoftBadge tone={item.status === 'done' ? 'success' : 'neutral'} className="hidden flex-none sm:inline-flex">
                      {statusLabel(item.status)}
                    </SoftBadge>
                    <PointsChip points={item.storyPoints} />
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
