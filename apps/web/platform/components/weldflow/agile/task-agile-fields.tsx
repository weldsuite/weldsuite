/**
 * The agile rows of the task panel: Type, Epic, Sprint and Story points among
 * the details, and Acceptance criteria with the project's Definition of Done
 * below them. Only for a task of a project whose delivery approach uses item
 * types (ADR FLOW-022); everywhere else these render nothing.
 *
 * Saved with `useUpdateTaskAgile` (the plain task update doesn't know `epicId`).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Check, CheckCircle2, Flag, Layers, Shapes, Target } from 'lucide-react';
import { toast } from 'sonner';
import type { ItemType } from '@weldsuite/app-api-client/schemas/flow-agile';
import type { TaskRow } from '@weldsuite/app-api-client/domains/tasks';
import { Button } from '@weldsuite/ui/components/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@weldsuite/ui/components/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Link } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { apiMessage } from '@/app/weldflow/project/[projectId]/close/_lib/api-error';
import { itemTypeOf, isContainerType } from '@/app/weldflow/lib/item-types';
import { pickableTypes, typeChangeInput } from '@/app/weldflow/lib/backlog';
import { useProjectDelivery, useProjectEpics, useProjectSprints, useUpdateTaskAgile } from '@/hooks/queries/use-flow-agile-queries';
import { TaskTypeBadge, useItemTypeLabel } from './task-type-badge';

export function epicPageHref(projectId: string, epicId: string): string {
  return `/weldflow/project/${projectId}/epics/${epicId}`;
}

/** A row of the Details list: a label with its icon, then the control. */
function Row({ icon, label, children }: Readonly<{ icon: ReactNode; label: string; children: ReactNode }>) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex w-32 flex-shrink-0 items-center gap-2">
        {icon}
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-start justify-center">{children}</div>
    </div>
  );
}

const FIELD_BUTTON =
  'group/field -mx-[5px] inline-flex h-8 max-w-full cursor-pointer items-center gap-1.5 self-start rounded-md px-[5px] text-left text-sm transition-colors hover:bg-transparent dark:hover:bg-transparent';

interface Props {
  task: TaskRow;
}

/** The agile data every part needs; null where the project is not agile. */
function useAgileTask(task: TaskRow) {
  const projectId = task.projectId ?? '';
  const delivery = useProjectDelivery(projectId);
  const update = useUpdateTaskAgile(projectId);
  const { t } = useI18n();
  const type = itemTypeOf(task.type, { hasParent: !!task.parentTaskId, featureLevel: delivery.settings.itemTypes.featureLevel });
  const enabled = !!projectId && delivery.available && delivery.usesItemTypes;

  const save = (input: Parameters<typeof update.mutate>[0]['input'], failed: string) =>
    update.mutate(
      { taskId: task.id, input },
      { onError: (error) => toast.error(apiMessage(error, failed)) },
    );

  return { projectId, delivery, enabled, type, save, saving: update.isPending, t };
}

// ── Type ────────────────────────────────────────────────────────────────────

function TypeField({ task }: Readonly<Props>) {
  const { delivery, type, save, projectId } = useAgileTask(task);
  const { t } = useI18n();
  const label = useItemTypeLabel();
  const naming = delivery.settings.itemTypes.naming;
  const isSubtask = type === 'subtask';
  const types = pickableTypes(delivery.enabledTypes);
  const notes = t.flowAgileBacklog.panel.notes;
  const noteByType: Partial<Record<string, string>> = { epic: notes.epic, feature: notes.feature, spike: notes.spike };
  const note = noteByType[type] ?? null;

  return (
    <>
      <Row icon={<Shapes className="h-4 w-4 text-muted-foreground" />} label={t.flowAgileBacklog.panel.type}>
        {isSubtask ? (
          <span className="inline-flex h-8 items-center gap-2 text-sm">
            <TaskTypeBadge type={task.type} naming={naming} hasParent />
            {label('subtask', naming)}
          </span>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className={FIELD_BUTTON} aria-label={`${t.flowAgileBacklog.panel.typeMenu}: ${label(type, naming)}`}>
                <TaskTypeBadge type={type} naming={naming} featureLevel={delivery.settings.itemTypes.featureLevel} />
                <span className="group-hover/field:underline">{label(type, naming)}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel>{t.flowAgileBacklog.panel.typeMenu}</DropdownMenuLabel>
              {types.map((option) => (
                <DropdownMenuItem
                  key={option}
                  disabled={option === type}
                  onSelect={() => save(typeChangeInput(option), t.flowAgileBacklog.panel.typeFailed)}
                  className="items-start gap-2.5"
                >
                  <TaskTypeBadge type={option} naming={naming} featureLevel className="mt-0.5" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm">{label(option, naming)}</span>
                    <span className="text-xs text-muted-foreground">{t.flowAgile.itemTypeDescriptions[option]}</span>
                  </span>
                  {option === type ? <Check className="mt-0.5 h-3.5 w-3.5" /> : null}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                <Link href={`/weldflow/project/${projectId}/settings#item-types`} className="underline-offset-2 hover:underline">
                  {t.flowAgileBacklog.panel.typeSettingsLink}
                </Link>
              </DropdownMenuLabel>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </Row>
      {note ? (
        <div role="status" className="py-1">
          <InfoBanner variant="neutral">
            {note}
            {type === 'epic' ? (
              <>
                {' '}
                <Link href={epicPageHref(projectId, task.id)} className="font-medium underline-offset-2 hover:underline">
                  {t.flowAgileBacklog.panel.openEpicPage}
                </Link>
              </>
            ) : null}
          </InfoBanner>
        </div>
      ) : null}
    </>
  );
}

// ── Epic ────────────────────────────────────────────────────────────────────

function EpicField({ task, type }: Readonly<Props & { type: ItemType }>) {
  const { projectId, save, t } = useAgileTask(task);
  const [open, setOpen] = useState(false);
  const epics = useProjectEpics(projectId);
  // A feature sits in an epic; anything else in an epic or a feature.
  const options = (epics.data ?? []).filter((epic) => epic.id !== task.id && (type !== 'feature' || epic.type === 'epic'));
  const current = (epics.data ?? []).find((epic) => epic.id === task.epicId);
  const copy = t.flowAgileBacklog.panel;

  const pick = (epicId: string | null) => {
    setOpen(false);
    save({ epicId }, copy.epicFailed);
  };

  return (
    <Row icon={<Layers className="h-4 w-4 text-muted-foreground" />} label={copy.epic}>
      <div className="flex min-w-0 max-w-full items-center gap-1">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" className={FIELD_BUTTON}>
              {current ? (
                <span className="truncate rounded bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-500/20 dark:text-violet-200">
                  {current.title}
                </span>
              ) : (
                <span className="text-muted-foreground group-hover/field:underline">{copy.setEpic}</span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-0">
            <Command className="outline-hidden">
              <CommandInput placeholder={copy.searchEpics} />
              <CommandList>
                <CommandEmpty>{copy.noEpicsFound}</CommandEmpty>
                <CommandGroup>
                  <CommandItem value={`__none ${copy.noEpic}`} onSelect={() => pick(null)}>
                    {copy.noEpic}
                    {task.epicId ? null : <Check className="ml-auto h-3.5 w-3.5" />}
                  </CommandItem>
                  {options.map((epic) => (
                    <CommandItem key={epic.id} value={`${epic.id} ${epic.title}`} onSelect={() => pick(epic.id)}>
                      <span className="truncate">{epic.title}</span>
                      {task.epicId === epic.id ? <Check className="ml-auto h-3.5 w-3.5" /> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {current ? (
          <Link
            href={epicPageHref(projectId, current.id)}
            className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {copy.openEpicPage}
          </Link>
        ) : null}
      </div>
    </Row>
  );
}

// ── Sprint ──────────────────────────────────────────────────────────────────

function SprintField({ task }: Readonly<Props>) {
  const { projectId, save, t } = useAgileTask(task);
  const [open, setOpen] = useState(false);
  const sprints = useProjectSprints(projectId);
  const open_ = (sprints.data ?? []).filter((sprint) => sprint.status === 'planned' || sprint.status === 'active');
  const current = (sprints.data ?? []).find((sprint) => sprint.id === task.sprintId);
  const copy = t.flowAgileBacklog.panel;

  const pick = (sprintId: string | null) => {
    setOpen(false);
    save({ sprintId }, copy.sprintFailed);
  };

  return (
    <Row icon={<Flag className="h-4 w-4 text-muted-foreground" />} label={copy.sprint}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" className={FIELD_BUTTON}>
            {current ? (
              <span>{current.name}</span>
            ) : (
              <span className="text-muted-foreground group-hover/field:underline">{copy.setSprint}</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 p-0">
          <Command className="outline-hidden">
            <CommandList>
              <CommandGroup>
                <CommandItem value="__backlog" onSelect={() => pick(null)}>
                  {copy.noSprint}
                  {task.sprintId ? null : <Check className="ml-auto h-3.5 w-3.5" />}
                </CommandItem>
                {open_.map((sprint) => (
                  <CommandItem key={sprint.id} value={`${sprint.id} ${sprint.name}`} onSelect={() => pick(sprint.id)}>
                    <span className="truncate">{sprint.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">{t.flowAgile.sprintStatus[sprint.status as 'planned' | 'active']}</span>
                    {task.sprintId === sprint.id ? <Check className="h-3.5 w-3.5" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </Row>
  );
}

// ── Story points ────────────────────────────────────────────────────────────

function PointsField({ task }: Readonly<Props>) {
  const { save, t } = useAgileTask(task);
  const stored = task.storyPoints ?? null;
  const [draft, setDraft] = useState(stored === null ? '' : String(stored));
  useEffect(() => setDraft(stored === null ? '' : String(stored)), [stored]);
  const copy = t.flowAgileBacklog.panel;

  const commit = () => {
    const text = draft.trim();
    const next = text === '' ? null : Number(text);
    if (next !== null && (!Number.isFinite(next) || next < 0)) {
      setDraft(stored === null ? '' : String(stored));
      return;
    }
    if (next === stored) return;
    save({ storyPoints: next }, copy.pointsFailed);
  };

  return (
    <Row icon={<Target className="h-4 w-4 text-muted-foreground" />} label={copy.points}>
      <Input
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={draft}
        placeholder={t.flowAgile.noEstimate}
        aria-label={copy.pointsInput}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className="h-8 w-28 text-sm"
      />
    </Row>
  );
}

// ── Rows among the details ──────────────────────────────────────────────────

/** Type, Epic, Sprint and Story points for the Details list of the task panel. */
export function TaskAgileFields({ task }: Readonly<Props>) {
  const { enabled, delivery, type } = useAgileTask(task);
  if (!enabled) return null;
  const container = isContainerType(type);
  const isSubtask = type === 'subtask';
  return (
    <>
      <TypeField task={task} />
      {type !== 'epic' && !isSubtask ? <EpicField task={task} type={type} /> : null}
      {delivery.usesSprints && !container && !isSubtask ? <SprintField task={task} /> : null}
      {!container && !isSubtask ? <PointsField task={task} /> : null}
    </>
  );
}

// ── Acceptance criteria and the Definition of Done ──────────────────────────

function CriteriaField({ task }: Readonly<Props>) {
  const { save, t } = useAgileTask(task);
  const stored = task.acceptanceCriteria ?? '';
  const [draft, setDraft] = useState(stored);
  useEffect(() => setDraft(stored), [stored]);
  const copy = t.flowAgileBacklog.panel;

  return (
    <section aria-labelledby={`criteria-${task.id}`} className="space-y-2">
      <h3 id={`criteria-${task.id}`} className="text-sm font-medium">
        {copy.criteria}
      </h3>
      <Textarea
        value={draft}
        rows={4}
        placeholder={copy.criteriaPlaceholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next === stored.trim()) return;
          save({ acceptanceCriteria: next === '' ? null : next }, copy.criteriaFailed);
        }}
        className="text-sm"
      />
    </section>
  );
}

function DefinitionOfDone({ items }: Readonly<{ items: readonly string[] }>) {
  const { t } = useI18n();
  const copy = t.flowAgileBacklog.panel;
  return (
    <section aria-label={copy.dod} className="space-y-2 rounded-lg border border-border p-3">
      <div>
        <h3 className="text-sm font-medium">{copy.dod}</h3>
        <p className="text-xs text-muted-foreground">{copy.dodHint}</p>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.dodEmpty}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((text) => (
            <li key={text} className="flex items-start gap-2 text-sm">
              <CheckCircle2 aria-hidden className={cn('mt-0.5 h-4 w-4 flex-none text-muted-foreground')} />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Acceptance criteria, and the Definition of Done for stories and bugs, below the details. */
export function TaskAgileSections({ task }: Readonly<Props>) {
  const { enabled, delivery, type } = useAgileTask(task);
  if (!enabled || isContainerType(type) || type === 'subtask') return null;
  const showDod = type === 'story' || type === 'bug';
  return (
    <div className="mt-6 space-y-4">
      <CriteriaField task={task} />
      {showDod ? <DefinitionOfDone items={delivery.settings.definitionOfDone} /> : null}
    </div>
  );
}
