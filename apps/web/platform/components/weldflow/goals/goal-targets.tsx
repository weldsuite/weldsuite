/**
 * Measurable targets on goal cards: a target is a benefit or a set of tasks,
 * and its progress is computed on read (`GET /api/project-benefits/goal-targets`),
 * never typed in. This file holds the progress lookup, the compact summary a
 * card shows and the dialog that edits a card's targets.
 */

import { useMemo, useState } from 'react';
import { Target, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { GoalTarget, GoalTargetProgress } from '@weldsuite/app-api-client/domains/project-governance';
import { useI18n } from '@/lib/i18n/provider';
import { useBenefits, useDeliverables, useGoalTargets } from '@/hooks/queries/use-project-governance-queries';

const NONE = '__none__';

/** The computed progress of every target, by goal card id; empty while it loads or when the caller cannot read it. */
export function useGoalTargetProgress(projectId: string): Map<string, GoalTargetProgress[]> {
  const query = useGoalTargets(projectId);
  return useMemo(() => new Map((query.data ?? []).map((card) => [card.goalId, card.targets])), [query.data]);
}

/** A card's progress from its targets: the average of the ones that can be told, else null. */
export function progressFromTargets(targets: readonly GoalTargetProgress[] | undefined): number | null {
  const known = (targets ?? []).map((target) => target.progressPct).filter((pct): pct is number => pct !== null);
  return known.length === 0 ? null : Math.round(known.reduce((sum, pct) => sum + pct, 0) / known.length);
}

/** The button on a card: how many targets it has, opening the dialog. */
export function GoalTargetsButton({
  count,
  visible,
  onOpen,
}: Readonly<{ count: number; visible: boolean; onOpen: () => void }>) {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.goals;
  if (!visible && count === 0) return null;
  return (
    <button
      type="button"
      aria-label={count > 0 ? format(copy.targetsCount, { count }) : copy.manage}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className="relative z-[1] inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-gray-600 outline-none hover:bg-gray-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:text-muted-foreground dark:hover:bg-secondary"
    >
      <Target aria-hidden className="size-3" />
      {count > 0 ? count : copy.manage}
    </button>
  );
}

function describe(progress: GoalTargetProgress | undefined, target: GoalTarget, copy: ReturnType<typeof useI18n>['t']['flowGovernance']['goals'], format: ReturnType<typeof useI18n>['format']) {
  if ('benefitId' in target) {
    if (!progress || !progress.code) return { title: copy.benefitGone, detail: '', pct: null as number | null };
    const range = progress.baselineValue !== null && progress.targetValue !== null ? format(copy.from, { baseline: Number(progress.baselineValue), target: Number(progress.targetValue) }) : '';
    const now = progress.currentValue !== null ? String(Number(progress.currentValue)) : copy.noMeasurement;
    return { title: `${progress.code} · ${progress.label}`, detail: [now, range].filter(Boolean).join(' · '), pct: progress.progressPct };
  }
  const total = progress?.total ?? 0;
  return {
    title: target.label,
    detail: total > 0 ? format(copy.tasksProgress, { done: progress?.done ?? 0, total }) : copy.noTasksYet,
    pct: progress?.progressPct ?? null,
  };
}

/** The dialog that lists a card's targets with their progress and adds or removes them. */
export function GoalTargetsDialog({
  projectId,
  goalTitle,
  targets,
  progress,
  canEdit,
  onChange,
  onClose,
}: Readonly<{
  projectId: string;
  goalTitle: string;
  targets: GoalTarget[];
  progress: GoalTargetProgress[];
  canEdit: boolean;
  onChange: (targets: GoalTarget[]) => void;
  onClose: () => void;
}>) {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.goals;
  const benefitsQuery = useBenefits(projectId);
  const deliverablesQuery = useDeliverables(projectId);
  const linked = new Set(targets.flatMap((target) => ('benefitId' in target ? [target.benefitId] : [])));
  const available = (benefitsQuery.data ?? []).filter((benefit) => !linked.has(benefit.id));

  const [benefitId, setBenefitId] = useState(NONE);
  const [label, setLabel] = useState('');
  const [deliverableId, setDeliverableId] = useState(NONE);
  const [tag, setTag] = useState('');
  const [taskError, setTaskError] = useState(false);

  const progressAt = (index: number) => progress.find((entry) => entry.index === index);

  const addTasks = () => {
    const filter: { deliverableId?: string; tag?: string } = {};
    if (deliverableId !== NONE) filter.deliverableId = deliverableId;
    if (tag.trim()) filter.tag = tag.trim();
    if (Object.keys(filter).length === 0 || !label.trim()) {
      setTaskError(true);
      return;
    }
    setTaskError(false);
    onChange([...targets, { label: label.trim(), taskFilter: filter }]);
    setLabel('');
    setTag('');
    setDeliverableId(NONE);
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" onPointerDown={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{format(copy.dialogTitle, { goal: goalTitle })}</DialogTitle>
          <DialogDescription>{copy.dialogDescription}</DialogDescription>
        </DialogHeader>

        {targets.length === 0 ? (
          <p className="rounded-md bg-muted px-3 py-3 text-sm text-muted-foreground">{copy.noTargets}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {targets.map((target, index) => {
              const entry = describe(progressAt(index), target, copy, format);
              return (
                <li key={index}>
                  <div className="flex items-baseline gap-2">
                    <span className="flex-1 text-sm">{entry.title}</span>
                    <span className="text-xs font-semibold tabular-nums">{entry.pct === null ? '–' : `${entry.pct}%`}</span>
                    {canEdit ? (
                      <Button type="button" variant="ghost" size="icon" aria-label={copy.removeTarget} className="size-6" onClick={() => onChange(targets.filter((_, i) => i !== index))}>
                        <Trash2 aria-hidden className="size-3.5" />
                      </Button>
                    ) : null}
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-foreground/80" style={{ width: `${entry.pct ?? 0}%` }} />
                  </div>
                  {entry.detail ? <div className="mt-0.5 text-[11px] text-muted-foreground">{entry.detail}</div> : null}
                </li>
              );
            })}
          </ul>
        )}

        {canEdit ? (
          <div className="mt-2 flex flex-col gap-4 border-t pt-4">
            <div className="flex flex-col gap-2">
              <Label>{copy.addBenefit}</Label>
              {available.length === 0 ? (
                <p className="text-xs text-muted-foreground">{copy.noBenefits}</p>
              ) : (
                <div className="flex gap-2">
                  <Select value={benefitId} onValueChange={setBenefitId}>
                    <SelectTrigger className="flex-1" aria-label={copy.benefitLabel}>
                      <SelectValue placeholder={copy.benefitLabel} />
                    </SelectTrigger>
                    <SelectContent>
                      {available.map((benefit) => (
                        <SelectItem key={benefit.id} value={benefit.id}>
                          {benefit.code} · {benefit.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={benefitId === NONE}
                    onClick={() => {
                      onChange([...targets, { benefitId }]);
                      setBenefitId(NONE);
                    }}
                  >
                    {t.flowGovernance.common.add}
                  </Button>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="goal-target-label">{copy.addTasks}</Label>
              <Input id="goal-target-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder={copy.taskLabelPlaceholder} aria-label={copy.taskLabel} />
              <div className="grid gap-2 sm:grid-cols-2">
                <Select value={deliverableId} onValueChange={setDeliverableId}>
                  <SelectTrigger aria-label={copy.deliverable}>
                    <SelectValue placeholder={copy.deliverable} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{copy.anyDeliverable}</SelectItem>
                    {(deliverablesQuery.data ?? []).map((deliverable) => (
                      <SelectItem key={deliverable.id} value={deliverable.id}>
                        {deliverable.code} · {deliverable.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input value={tag} onChange={(event) => setTag(event.target.value)} placeholder={copy.tag} aria-label={copy.tag} />
              </div>
              {taskError ? <p role="alert" className="text-xs text-destructive">{copy.needsFilter}</p> : null}
              <Button type="button" variant="outline" className="self-start" onClick={addTasks}>
                {t.flowGovernance.common.add}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
