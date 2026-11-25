/**
 * The right-click menu of a backlog row (the ⋮ button opens the same menu):
 * Open, Change type, Move to sprint, Set epic, Turn into an epic, Delete.
 * With a selection, an action on a selected row applies to the whole selection.
 */

import { ArrowUpToLine, Check, Layers, Shapes, Trash2, ExternalLink, Flag, Sparkles } from 'lucide-react';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@weldsuite/ui/components/context-menu';
import { useI18n } from '@/lib/i18n/provider';
import { TaskTypeBadge, useItemTypeLabel } from '@/components/weldflow/agile/task-type-badge';
import type { BacklogItem } from '@/app/weldflow/lib/backlog';
import { useBacklogEnv } from './backlog-context';

type MenuEnv = ReturnType<typeof useBacklogEnv>;

interface SubMenuProps {
  item: BacklogItem;
  env: MenuEnv;
  targets: ReturnType<MenuEnv['targetsFor']>;
}

function ChangeTypeSub({
  item,
  env,
  targets,
  label,
  title,
}: Readonly<SubMenuProps & { label: ReturnType<typeof useItemTypeLabel>; title: string }>) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Shapes className="h-3.5 w-3.5" />
        {title}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-48">
        {env.types.map((type) => (
          <ContextMenuItem key={type} onSelect={() => env.actions.changeType(targets, type)}>
            <TaskTypeBadge type={type} naming={env.naming} featureLevel size="sm" />
            {label(type, env.naming)}
            {type === item.type ? <Check className="ml-auto h-3.5 w-3.5" /> : null}
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function MoveToSprintSub({ item, env, targets, sprints }: Readonly<SubMenuProps & { sprints: MenuEnv['sprints'] }>) {
  const { t } = useI18n();
  const copy = t.flowAgileBacklog.menu;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Flag className="h-3.5 w-3.5" />
        {copy.moveToSprint}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-52">
        {item.sprintId ? (
          <ContextMenuItem onSelect={() => env.actions.moveToSprint(targets, null)}>
            <ArrowUpToLine className="h-3.5 w-3.5" />
            {copy.moveToBacklog}
          </ContextMenuItem>
        ) : null}
        {sprints.map((sprint) => (
          <ContextMenuItem key={sprint.id} onSelect={() => env.actions.moveToSprint(targets, sprint.id)}>
            <span className="truncate">{sprint.name}</span>
          </ContextMenuItem>
        ))}
        {sprints.length === 0 && !item.sprintId ? <ContextMenuItem disabled>{copy.noSprints}</ContextMenuItem> : null}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function SetEpicSub({ item, env, targets, epics }: Readonly<SubMenuProps & { epics: MenuEnv['epics'] }>) {
  const { t } = useI18n();
  const copy = t.flowAgileBacklog.menu;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Layers className="h-3.5 w-3.5" />
        {copy.setEpic}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-56">
        {item.epicId ? <ContextMenuItem onSelect={() => env.actions.setEpic(targets, null)}>{copy.noEpic}</ContextMenuItem> : null}
        {epics.map((epic) => (
          <ContextMenuItem key={epic.id} onSelect={() => env.actions.setEpic(targets, epic.id)}>
            <span className="truncate">{epic.title}</span>
          </ContextMenuItem>
        ))}
        {epics.length === 0 && !item.epicId ? <ContextMenuItem disabled>{copy.noEpicsYet}</ContextMenuItem> : null}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

export function BacklogItemMenu({ item }: Readonly<{ item: BacklogItem }>) {
  const { t } = useI18n();
  const copy = t.flowAgileBacklog.menu;
  const label = useItemTypeLabel();
  const env = useBacklogEnv();
  const { actions } = env;
  const targets = env.targetsFor(item.id);
  const sprints = env.sprints.filter((sprint) => sprint.id !== item.sprintId);
  const epics = env.epics.filter((epic) => epic.id !== item.epicId);
  const canBecomeEpic = env.types.includes('epic') && item.type !== 'epic' && targets.length === 1;

  return (
    <ContextMenuContent className="w-60">
      <ContextMenuItem onSelect={() => actions.open(item.id)}>
        <ExternalLink className="h-3.5 w-3.5" />
        {copy.open}
      </ContextMenuItem>
      {env.canWrite ? (
        <>
          <ContextMenuSeparator />
          <ChangeTypeSub item={item} env={env} targets={targets} label={label} title={copy.changeType} />
          {env.usesSprints ? <MoveToSprintSub item={item} env={env} targets={targets} sprints={sprints} /> : null}
          <SetEpicSub item={item} env={env} targets={targets} epics={epics} />
          {canBecomeEpic ? (
            <ContextMenuItem onSelect={() => actions.turnIntoEpic(item.id)}>
              <Sparkles className="h-3.5 w-3.5" />
              <span className="flex flex-col">
                <span>{copy.turnIntoEpic}</span>
                <span className="text-xs text-muted-foreground">{copy.turnIntoEpicHint}</span>
              </span>
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={() => actions.requestDelete(targets)}>
            <Trash2 className="h-3.5 w-3.5" />
            {copy.delete}
          </ContextMenuItem>
        </>
      ) : null}
    </ContextMenuContent>
  );
}
