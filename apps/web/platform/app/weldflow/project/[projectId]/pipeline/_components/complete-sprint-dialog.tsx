import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import type {
  CarryOverTarget,
  CompleteSprintInput,
  CompleteSprintResult,
  Sprint,
  SprintReport,
} from '@weldsuite/app-api-client/schemas/flow-agile';
import { useI18n } from '@/lib/i18n/provider';
import {
  useCompleteSprint,
  useProjectSprints,
  useSprintReport,
} from '@/hooks/queries/use-flow-agile-queries';
import { useSprintItems } from '@/hooks/queries/use-flow-agile-sprint-queries';
import { groupSprints } from '@/app/weldflow/lib/sprint-metrics';
import { apiMessage } from '@/app/weldflow/project/[projectId]/close/_lib/api-error';

const NEW_SPRINT = '__new__';

type GoalChoice = 'yes' | 'no';

/** One of the three numbers across the top: completed, not done, added after the start. */
function Figure({ label, points, items }: Readonly<{ label: string; points: string; items: string }>) {
  return (
    <div className="rounded-lg border px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{points}</p>
      <p className="text-xs text-muted-foreground tabular-nums">{items}</p>
    </div>
  );
}

function ReportFigures({ report }: Readonly<{ report: SprintReport }>) {
  const { t, plural, format } = useI18n();
  const copy = t.flowAgileSprints;
  const points = (value: number) => plural(value, t.flowAgile.points);
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Figure label={copy.complete.completed} points={points(report.completed.points)} items={plural(report.completed.count, copy.items)} />
      <Figure label={copy.complete.notDone} points={points(report.carriedOver.points)} items={plural(report.carriedOver.count, copy.items)} />
      <Figure
        label={copy.complete.added}
        points={format(copy.pointsDelta, { points: report.added.points })}
        items={plural(report.added.count, copy.items)}
      />
    </div>
  );
}

/**
 * Completes a sprint: the live numbers, whether the goal was met, and where
 * each unfinished item goes (a default for all, a choice per item). Optionally
 * continues to the sprint's retro.
 */
export function CompleteSprintDialog({
  projectId,
  sprint,
  open,
  onOpenChange,
  onCompleted,
}: Readonly<{
  projectId: string;
  sprint: Sprint;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After the sprint is completed; `openRetro` when the retro was asked for. */
  onCompleted: (result: CompleteSprintResult, options: { openRetro: boolean }) => void;
}>) {
  const { t, plural, format } = useI18n();
  const copy = t.flowAgileSprints.complete;
  const report = useSprintReport(projectId, open ? sprint.id : null);
  const items = useSprintItems(projectId, sprint.id, open);
  const sprints = useProjectSprints(projectId, open);
  const complete = useCompleteSprint(projectId);

  const planned = useMemo(() => groupSprints(sprints.data ?? []).planned.filter((candidate) => candidate.id !== sprint.id), [sprints.data, sprint.id]);

  const [goal, setGoal] = useState<GoalChoice>('yes');
  const [target, setTarget] = useState<CarryOverTarget>('next');
  const [nextChoice, setNextChoice] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, CarryOverTarget>>({});
  const [openRetro, setOpenRetro] = useState(false);

  const nextSprintId = nextChoice ?? planned[0]?.id ?? NEW_SPRINT;
  const unfinished = useMemo(() => {
    const ids = new Set(report.data?.carriedOver.taskIds ?? []);
    return (items.data ?? []).filter((task) => ids.has(task.id));
  }, [report.data, items.data]);

  const reset = () => {
    setGoal('yes');
    setTarget('next');
    setNextChoice(null);
    setOverrides({});
    setOpenRetro(false);
  };

  const submit = async () => {
    const input: CompleteSprintInput = {
      ...(sprint.goal ? { goalMet: goal === 'yes' } : {}),
      moveTo: target,
      ...(target === 'next' && nextSprintId !== NEW_SPRINT ? { nextSprintId } : {}),
      ...(Object.keys(overrides).length > 0
        ? { items: Object.entries(overrides).map(([taskId, moveTo]) => ({ taskId, moveTo })) }
        : {}),
    };
    try {
      const response = await complete.mutateAsync({ id: sprint.id, input });
      toast.success(copy.success);
      onOpenChange(false);
      reset();
      onCompleted(response.data, { openRetro });
    } catch (error) {
      toast.error(apiMessage(error, copy.failed));
    }
  };

  const hasUnfinished = (report.data?.carriedOver.count ?? 0) > 0;
  const pending = complete.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{format(copy.title, { name: sprint.name })}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 py-1">
          {report.isLoading ? (
            <div role="status" aria-busy="true" aria-label={copy.reportLoading} className="grid gap-2 sm:grid-cols-3">
              <Skeleton className="h-20 rounded-lg" />
              <Skeleton className="h-20 rounded-lg" />
              <Skeleton className="h-20 rounded-lg" />
            </div>
          ) : null}
          {report.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {copy.reportFailed}
            </p>
          ) : null}
          {report.data ? <ReportFigures report={report.data} /> : null}

          {sprint.goal ? (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">{copy.goalQuestion}</legend>
              <p className="text-sm text-muted-foreground">{sprint.goal}</p>
              <RadioGroup value={goal} onValueChange={(value) => setGoal(value as GoalChoice)} className="flex gap-5">
                <div className="flex items-center gap-2">
                  <RadioGroupItem id="complete-goal-yes" value="yes" />
                  <Label htmlFor="complete-goal-yes">{copy.goalYes}</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem id="complete-goal-no" value="no" />
                  <Label htmlFor="complete-goal-no">{copy.goalNo}</Label>
                </div>
              </RadioGroup>
            </fieldset>
          ) : null}

          {report.data && !hasUnfinished ? <p className="text-sm text-muted-foreground">{copy.allDone}</p> : null}

          {hasUnfinished ? (
            <section aria-labelledby="complete-sprint-unfinished" className="grid gap-3">
              <h3 id="complete-sprint-unfinished" className="text-sm font-medium">
                {copy.unfinishedTitle}
              </h3>

              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="complete-sprint-target" className="text-sm font-normal text-muted-foreground">
                  {copy.defaultTarget}
                </Label>
                <Select value={target} onValueChange={(value) => setTarget(value as CarryOverTarget)}>
                  <SelectTrigger id="complete-sprint-target" size="sm" className="w-auto min-w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="next">{copy.toNext}</SelectItem>
                    <SelectItem value="backlog">{copy.toBacklog}</SelectItem>
                  </SelectContent>
                </Select>
                {target === 'next' ? (
                  <Select value={nextSprintId} onValueChange={setNextChoice}>
                    <SelectTrigger aria-label={copy.nextSprint} size="sm" className="w-auto min-w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {planned.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {candidate.name}
                        </SelectItem>
                      ))}
                      <SelectItem value={NEW_SPRINT}>{copy.newSprint}</SelectItem>
                    </SelectContent>
                  </Select>
                ) : null}
              </div>

              {items.isLoading ? <p className="text-xs text-muted-foreground">{copy.itemsLoading}</p> : null}
              {items.isError ? <p className="text-xs text-destructive">{copy.itemsFailed}</p> : null}
              {unfinished.length > 0 ? (
                <ul className="grid gap-1.5">
                  {unfinished.map((task) => (
                    <li key={task.id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                      {task.number != null ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">#{task.number}</span> : null}
                      <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
                      {task.storyPoints != null ? (
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{plural(task.storyPoints, t.flowAgile.points)}</span>
                      ) : null}
                      <Select
                        value={overrides[task.id] ?? target}
                        onValueChange={(value) => setOverrides((previous) => ({ ...previous, [task.id]: value as CarryOverTarget }))}
                      >
                        <SelectTrigger aria-label={format(copy.moveItemTo, { title: task.title })} size="sm" className="w-auto min-w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="next">{copy.toNext}</SelectItem>
                          <SelectItem value="backlog">{copy.toBacklog}</SelectItem>
                        </SelectContent>
                      </Select>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-xs text-muted-foreground">{copy.velocityNote}</p>
            </section>
          ) : null}

          <div className="flex items-center gap-2">
            <Checkbox id="complete-sprint-retro" checked={openRetro} onCheckedChange={(value) => setOpenRetro(value === true)} />
            <Label htmlFor="complete-sprint-retro" className="font-normal">
              {copy.openRetro}
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            {copy.cancel}
          </Button>
          <Button type="button" disabled={pending || !report.data} onClick={() => void submit()}>
            {pending ? copy.submitting : copy.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
