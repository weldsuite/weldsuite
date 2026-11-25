/**
 * One row of the Backlog: select box, drag handle, type badge, number, title,
 * epic chip, assignee and points. Right-click (or the ⋮ button) opens the item
 * menu; the handle drags the row (arrow keys too) between and within sections.
 */

import type { HTMLAttributes, Ref } from 'react';
import { GripVertical, EllipsisVertical } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { ContextMenu, ContextMenuTrigger } from '@weldsuite/ui/components/context-menu';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { TaskTypeBadge } from '@/components/weldflow/agile/task-type-badge';
import { epicPageHref } from '@/components/weldflow/agile/task-agile-fields';
import type { BacklogItem } from '@/app/weldflow/lib/backlog';
import { BacklogItemMenu } from './backlog-item-menu';
import { useBacklogEnv } from './backlog-context';

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase();
}

/** The points as a pill; a dashed one when the item is not estimated. */
export function PointsChip({ points }: Readonly<{ points: number | null }>) {
  const { t, plural } = useI18n();
  const copy = t.flowAgileBacklog.row;
  return (
    <span
      role="img"
      aria-label={points === null ? copy.estimateNone : plural(points, copy.points)}
      className={cn(
        'inline-flex h-[22px] min-w-7 flex-none items-center justify-center rounded-full px-2 text-xs font-semibold tabular-nums',
        points === null ? 'border border-dashed border-muted-foreground/50 text-muted-foreground' : 'bg-muted text-foreground',
      )}
    >
      <span aria-hidden="true">{points === null ? '–' : points}</span>
    </span>
  );
}

interface BodyProps {
  item: BacklogItem;
  /** Props for the drag handle; absent in the drag overlay. */
  handle?: { ref: Ref<HTMLButtonElement>; props: HTMLAttributes<HTMLButtonElement> };
  interactive?: boolean;
}

function RowBody({ item, handle, interactive = true }: Readonly<BodyProps>) {
  const { t, format } = useI18n();
  const copy = t.flowAgileBacklog.row;
  const env = useBacklogEnv();
  const epic = item.epicId ? env.epicsById.get(item.epicId) : undefined;
  const selected = env.selected.has(item.id);
  const done = item.status === 'done' || item.status === 'cancelled';

  return (
    <div
      data-backlog-row
      data-selected={selected || undefined}
      className={cn(
        'group/row flex items-center gap-2.5 border-b border-border/70 bg-background py-1.5 pl-3 pr-2 text-sm md:pl-4',
        'data-[selected]:bg-blue-50 dark:data-[selected]:bg-blue-500/10',
        interactive && 'hover:bg-muted/50',
      )}
    >
      {env.canWrite ? (
        <>
          <Checkbox
            checked={selected}
            onCheckedChange={() => env.toggleSelected(item.id)}
            aria-label={format(copy.select, { title: item.title })}
            className="flex-none"
            disabled={!interactive}
          />
          <button
            type="button"
            ref={handle?.ref}
            {...handle?.props}
            aria-label={format(copy.drag, { title: item.title })}
            className="-ml-1 flex h-7 w-5 flex-none cursor-grab touch-none select-none items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 active:cursor-grabbing"
          >
            <GripVertical aria-hidden className="h-4 w-4" />
          </button>
        </>
      ) : null}
      <TaskTypeBadge type={item.type} naming={env.naming} featureLevel={env.featureLevel} className="flex-none" />
      <span className="w-12 flex-none text-xs tabular-nums text-muted-foreground">{item.number != null ? `#${item.number}` : ''}</span>
      <button
        type="button"
        onClick={() => env.actions.open(item.id)}
        aria-label={format(copy.open, { title: item.title })}
        disabled={!interactive}
        className={cn(
          'min-w-0 flex-1 truncate rounded text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          done && 'text-muted-foreground line-through',
        )}
      >
        {item.title}
      </button>
      {epic ? (
        <Link
          href={epicPageHref(env.projectId, epic.id)}
          aria-label={format(copy.epic, { name: epic.title })}
          className="hidden max-w-40 flex-none truncate rounded-md bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 hover:underline sm:inline-block dark:bg-violet-500/20 dark:text-violet-200"
        >
          {epic.title}
        </Link>
      ) : null}
      <Avatar
        role="img"
        aria-label={item.assigneeName ? format(copy.assignedTo, { name: item.assigneeName }) : copy.unassigned}
        className={cn('size-6 flex-none', !item.assigneeName && 'border border-dashed border-muted-foreground/60')}
      >
        {item.assigneeAvatar ? <AvatarImage src={item.assigneeAvatar} alt="" /> : null}
        <AvatarFallback className="bg-secondary text-[10px] font-semibold">
          {item.assigneeName ? initialsOf(item.assigneeName) : ''}
        </AvatarFallback>
      </Avatar>
      <PointsChip points={item.storyPoints} />
      {interactive ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={format(copy.actions, { title: item.title })}
          aria-haspopup="menu"
          className="h-7 w-7 flex-none p-0"
          onClick={(event) => {
            // The same menu as a right-click, opened at the button.
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.closest('[data-backlog-row]')?.dispatchEvent(
              new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }),
            );
          }}
        >
          <EllipsisVertical aria-hidden className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  );
}

/** The row as it floats under the pointer while dragged. */
export function BacklogRowOverlay({ item }: Readonly<{ item: BacklogItem }>) {
  return (
    <div className="rounded-md border border-border shadow-lg">
      <RowBody item={item} interactive={false} />
    </div>
  );
}

export function SortableBacklogRow({ item }: Readonly<{ item: BacklogItem }>) {
  const env = useBacklogEnv();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !env.canWrite,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('list-none', isDragging && 'relative z-10 opacity-40')}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <RowBody item={item} handle={{ ref: setActivatorNodeRef, props: { ...attributes, ...listeners } }} />
          </div>
        </ContextMenuTrigger>
        <BacklogItemMenu item={item} />
      </ContextMenu>
    </li>
  );
}
