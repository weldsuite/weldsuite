/**
 * The bar that appears over the Backlog while items are selected: set their
 * type, move them to a sprint, set their epic, delete them, or clear the
 * selection.
 */

import { ChevronUp, Flag, Layers, Shapes, Trash2, X } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { TaskTypeBadge, useItemTypeLabel } from '@/components/weldflow/agile/task-type-badge';
import { useBacklogEnv } from './backlog-context';

export function BulkBar({ ids, onClear }: Readonly<{ ids: string[]; onClear: () => void }>) {
  const { t, plural } = useI18n();
  const copy = t.flowAgileBacklog.bulk;
  const menu = t.flowAgileBacklog.menu;
  const label = useItemTypeLabel();
  const env = useBacklogEnv();
  const { actions } = env;
  if (ids.length === 0 || !env.canWrite) return null;

  return (
    <div className="pointer-events-none sticky bottom-4 z-20 mt-4 flex justify-center px-2">
      <div
        role="toolbar"
        aria-label={copy.label}
        className="pointer-events-auto flex flex-wrap items-center gap-1 rounded-xl border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg"
      >
        <span className="px-2 text-sm font-medium tabular-nums" role="status">
          {plural(ids.length, copy.selected)}
        </span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="gap-1.5">
              <Shapes aria-hidden className="h-4 w-4" />
              {copy.setType}
              <ChevronUp aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            {env.types.map((type) => (
              <DropdownMenuItem key={type} onSelect={() => actions.changeType(ids, type)}>
                <TaskTypeBadge type={type} naming={env.naming} featureLevel size="sm" />
                {label(type, env.naming)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {env.usesSprints ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="gap-1.5">
                <Flag aria-hidden className="h-4 w-4" />
                {copy.moveToSprint}
                <ChevronUp aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className="w-52">
              <DropdownMenuItem onSelect={() => actions.moveToSprint(ids, null)}>{menu.moveToBacklog}</DropdownMenuItem>
              {env.sprints.length > 0 ? <DropdownMenuSeparator /> : null}
              {env.sprints.map((sprint) => (
                <DropdownMenuItem key={sprint.id} onSelect={() => actions.moveToSprint(ids, sprint.id)}>
                  <span className="truncate">{sprint.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="gap-1.5">
              <Layers aria-hidden className="h-4 w-4" />
              {copy.setEpic}
              <ChevronUp aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuItem onSelect={() => actions.setEpic(ids, null)}>{menu.noEpic}</DropdownMenuItem>
            {env.epics.length > 0 ? <DropdownMenuSeparator /> : null}
            {env.epics.map((epic) => (
              <DropdownMenuItem key={epic.id} onSelect={() => actions.setEpic(ids, epic.id)}>
                <span className="truncate">{epic.title}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 text-destructive hover:text-destructive"
          onClick={() => actions.requestDelete(ids)}
        >
          <Trash2 aria-hidden className="h-4 w-4" />
          {copy.delete}
        </Button>

        <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={onClear}>
          <X aria-hidden className="h-4 w-4" />
          {copy.clear}
        </Button>
      </div>
    </div>
  );
}
