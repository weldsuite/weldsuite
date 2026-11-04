import { useMemo, useState } from 'react';
import { AlertCircle, Link2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Switch } from '@weldsuite/ui/components/switch';
import { usePermissions } from '@weldsuite/permissions/react';
import { useParams } from '@/lib/router';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { useProjectSchedule, useUpdateScheduleSettings } from '@/hooks/queries/use-project-schedule-queries';
import { ZOOMS, filterRows, type RowFilter, type Zoom } from './_lib/gantt';
import { fill } from './_lib/format';
import { AddDependencyDialog, FIELD_CLASS } from './_components/add-dependency-dialog';
import { GanttChart } from './_components/gantt-chart';
import { KpiStrip } from './_components/kpi-strip';
import { TaskPanel } from './_components/task-panel';

function LoadingState() {
  const { t } = useI18n();
  return (
    <div role="status" aria-busy="true" aria-label={t.flowSchedule.dependencies.title} className="grid gap-4">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))]">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-[5.5rem] rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-lg" />
    </div>
  );
}

function ErrorState({ onRetry }: Readonly<{ onRetry: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowSchedule.dependencies.states;
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
      <div className="rounded-full bg-muted p-3">
        <AlertCircle aria-hidden className="size-6 text-muted-foreground" />
      </div>
      <h2 className="text-base font-semibold">{copy.loadFailedTitle}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{copy.loadFailedDescription}</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        {copy.retry}
      </Button>
    </div>
  );
}

/** Gantt, Dependencies: the task Gantt with its links and critical path, and what moving a task would do. */
export default function DependenciesPage() {
  const { t } = useI18n();
  const copy = t.flowSchedule.dependencies;
  const params = useParams();
  const projectId = params.projectId as string;
  const { canWrite, isAdmin } = useProjectPermissions();
  const { can } = usePermissions();
  const mayEdit = canWrite && can('projects:update');
  const mayConfigure = isAdmin && can('projects:update');

  const schedule = useProjectSchedule(projectId);
  const settings = useUpdateScheduleSettings(projectId);
  const [zoom, setZoom] = useState<Zoom>('week');
  const [filter, setFilter] = useState<RowFilter>('all');
  const [showCritical, setShowCritical] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; predecessorId?: string; successorId?: string }>({ open: false });

  const data = schedule.data;
  const rows = useMemo(() => (data ? filterRows(data.tasks, filter) : []), [data, filter]);
  const selected = data?.tasks.find((task) => task.id === selectedId) ?? null;

  if (schedule.isLoading) return <LoadingState />;
  if (schedule.isError || !data) return <ErrorState onRetry={() => void schedule.refetch()} />;

  const toggleAuto = (next: boolean) => settings.mutate({ autoSchedule: next }, { onError: () => toast.error(copy.states.settingsFailed) });

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label={copy.toolbar.zoomLabel} className="inline-flex overflow-hidden rounded-md border">
          {ZOOMS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={zoom === level}
              onClick={() => setZoom(level)}
              className={cn(
                'px-3 py-1.5 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                zoom === level ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted',
              )}
            >
              {copy.toolbar[level]}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          {copy.toolbar.filterLabel}
          <select className={cn(FIELD_CLASS, 'w-auto')} value={filter} onChange={(event) => setFilter(event.target.value as RowFilter)}>
            <option value="all">{copy.toolbar.filterAll}</option>
            <option value="critical">{copy.toolbar.filterCritical}</option>
            {data.deliverables.map((deliverable) => (
              <option key={deliverable.id} value={`deliverable:${deliverable.id}`}>
                {fill(copy.toolbar.filterDeliverable, { code: deliverable.code })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm" title={copy.toolbar.autoScheduleHint}>
          <Switch checked={data.settings.autoSchedule} disabled={!mayConfigure || settings.isPending} onCheckedChange={toggleAuto} />
          {copy.toolbar.autoSchedule}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-primary" checked={showCritical} onChange={(event) => setShowCritical(event.target.checked)} />
          {copy.toolbar.showCritical}
        </label>
        <div className="flex-1" />
        {mayEdit && (
          <Button type="button" variant="outline" onClick={() => setDialog({ open: true, predecessorId: undefined, successorId: selectedId ?? undefined })}>
            <Link2 aria-hidden className="size-4" />
            {copy.toolbar.addDependency}
          </Button>
        )}
      </div>

      <KpiStrip schedule={data} />

      {data.tasks.length === 0 || rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-16 text-center text-sm text-muted-foreground">
          <Plus aria-hidden className="size-5" />
          {data.tasks.length === 0 ? copy.chart.empty : copy.chart.emptyFiltered}
        </div>
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <GanttChart schedule={data} rows={rows} zoom={zoom} showCritical={showCritical} selectedId={selectedId} onSelect={setSelectedId} />
          <TaskPanel projectId={projectId} schedule={data} task={selected} canWrite={mayEdit} onAddLink={(initial) => setDialog({ open: true, ...initial })} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-5 rounded-sm bg-blue-200">
            <span className="block h-full w-2/5 rounded-sm bg-blue-600" />
          </span>
          {copy.legend.task}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-5 rounded-sm border-[1.5px] border-orange-700 bg-orange-100" />
          {copy.legend.critical}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-5 bg-neutral-500" />
          {copy.legend.dependency}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-5 border-t-2 border-dashed border-red-600" />
          {copy.legend.conflict}
        </span>
        <span>{copy.legend.types}</span>
      </div>

      {dialog.open && (
        <AddDependencyDialog
          key={`${dialog.predecessorId ?? ''}:${dialog.successorId ?? ''}`}
          open
          onOpenChange={(open) => setDialog((previous) => ({ ...previous, open }))}
          projectId={projectId}
          schedule={data}
          initial={{ predecessorId: dialog.predecessorId, successorId: dialog.successorId }}
        />
      )}
    </div>
  );
}
