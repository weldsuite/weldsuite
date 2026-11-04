import { useMemo, type ReactNode } from 'react';
import { AlertCircle, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import type { ProjectTemplate, ProjectTemplateDetail } from '@weldsuite/app-api-client/schemas/project-closing';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { intlLocaleOf } from '@/app/weldflow/project/[projectId]/raid/_lib/locale';
import { controlLines } from '../_lib/control';
import { phaseSummaries, templateWeeks, weekOf } from '../_lib/template';

const KIND_STYLE: Record<string, string> = {
  risk: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200',
  assumption: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  issue: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200',
  dependency: 'bg-muted text-foreground/80',
};

function Block({ title, children, className }: Readonly<{ title: string; children: ReactNode; className?: string }>) {
  return (
    <div className={cn('border-b p-4', className)}>
      <h3 className="mb-2.5 text-[13px] font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function Tile({ label, value }: Readonly<{ label: string; value: string | number }>) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold">{value}</div>
    </div>
  );
}

interface TemplatePreviewProps {
  summary: ProjectTemplate | null;
  detail: ProjectTemplateDetail | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

/** What the selected template creates, read from its blueprint. */
export function TemplatePreview({ summary, detail, isLoading, isError, onRetry, canManage, onEdit, onDelete }: Readonly<TemplatePreviewProps>) {
  const { t, language, plural, format } = useI18n();
  const copy = t.flowClosing.templates.preview;
  const locale = intlLocaleOf(language);
  const blueprint = detail?.blueprint ?? null;
  const phases = useMemo(() => (blueprint ? phaseSummaries(blueprint) : []), [blueprint]);
  const control = useMemo(
    () => (blueprint ? controlLines(blueprint, { copy: copy.control, plural, format, intlLocale: locale }) : []),
    [blueprint, copy.control, plural, format, locale],
  );

  if (!summary) {
    return <section className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">{copy.selectPrompt}</section>;
  }
  if (isError) {
    return (
      <section role="alert" className="flex flex-col items-center gap-2 rounded-xl border bg-card px-6 py-12 text-center">
        <AlertCircle aria-hidden className="size-6 text-muted-foreground" />
        <h2 className="text-base font-semibold">{copy.errorTitle}</h2>
        <p className="text-sm text-muted-foreground">{copy.errorDescription}</p>
        <Button type="button" variant="outline" onClick={onRetry}>
          {t.flowClosing.shared.retry}
        </Button>
      </section>
    );
  }
  if (isLoading || !blueprint || !detail) {
    return (
      <section role="status" aria-busy="true" aria-label={copy.loadingLabel} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-16" />
        <Skeleton className="h-32" />
      </section>
    );
  }

  return (
    <section aria-labelledby="template-preview-title" className="min-w-0 overflow-hidden rounded-xl border bg-card">
      <div className="border-b p-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 id="template-preview-title" className="min-w-0 flex-1 text-base font-semibold">
            {detail.name}
          </h2>
          {canManage ? (
            <div className="flex gap-1.5">
              <Button type="button" variant="outline" size="sm" aria-label={format(copy.editAria, { name: detail.name })} onClick={onEdit}>
                <Pencil aria-hidden />
                {copy.edit}
              </Button>
              <Button type="button" variant="outline" size="sm" aria-label={format(copy.deleteAria, { name: detail.name })} onClick={onDelete}>
                <Trash2 aria-hidden />
                {copy.delete}
              </Button>
            </div>
          ) : null}
        </div>
        {detail.description ? <p className="mt-1 text-[13px] text-muted-foreground">{detail.description}</p> : null}
        <p className="mt-1 text-xs text-muted-foreground">{detail.shared ? copy.sharedWith : copy.onlyYou}</p>
        <div className="mt-3 grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(7.5rem,1fr))]">
          <Tile label={copy.tiles.length} value={plural(templateWeeks(blueprint.durationDays), copy.tiles.weeks)} />
          <Tile label={copy.tiles.tasks} value={blueprint.tasks.length} />
          <Tile label={copy.tiles.milestones} value={blueprint.milestones.length} />
          <Tile label={copy.tiles.deliverables} value={blueprint.deliverables.length} />
        </div>
      </div>

      <Block title={copy.phases.title}>
        {phases.length === 0 ? (
          <p className="text-sm text-muted-foreground">{copy.phases.empty}</p>
        ) : (
          <ol className="flex flex-wrap gap-2">
            {phases.map((phase) => (
              <li key={phase.key} className="flex-[1_1_9rem] rounded-lg border px-3 py-2.5">
                <div className="text-[13px] font-semibold">{phase.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {[
                    phase.fromWeek === null || phase.toWeek === null
                      ? null
                      : phase.fromWeek === phase.toWeek
                        ? format(copy.phases.week, { week: phase.fromWeek })
                        : format(copy.phases.weeks, { from: phase.fromWeek, to: phase.toWeek }),
                    plural(phase.tasks, copy.phases.tasks),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 text-xs text-foreground/80">
                  <ShieldCheck aria-hidden className="size-3" />
                  {phase.criteria === 0 ? copy.phases.noGate : plural(phase.criteria, copy.phases.gate)}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Block>

      <div className="grid [grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))]">
        <Block title={copy.milestones.title}>
          {blueprint.milestones.length === 0 ? (
            <p className="text-sm text-muted-foreground">{copy.milestones.empty}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {blueprint.milestones.map((milestone) => (
                <li key={milestone.key} className="flex items-center gap-2 text-[13px]">
                  <span aria-hidden className={cn('size-2 shrink-0 rotate-45', milestone.isKey ? 'bg-foreground' : 'border border-foreground')} />
                  <span className="min-w-0 flex-1">{milestone.name}</span>
                  <span className="text-xs text-muted-foreground">{format(copy.milestones.endOfWeek, { week: weekOf(milestone.offset) })}</span>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block title={copy.stages.title}>
          {blueprint.stages.length === 0 ? (
            <p className="text-sm text-muted-foreground">{copy.stages.empty}</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {blueprint.stages.map((stage) => (
                <li key={stage.key} className="rounded-full bg-muted px-2.5 py-1 text-xs text-foreground/80">
                  {stage.name}
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-3.5 mb-2 text-[13px] font-semibold">{copy.deliverables.title}</h3>
          {blueprint.deliverables.length === 0 ? (
            <p className="text-sm text-muted-foreground">{copy.deliverables.empty}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-[13px] text-foreground/80">
              {blueprint.deliverables.map((deliverable) => (
                <li key={deliverable.key}>{deliverable.title}</li>
              ))}
            </ul>
          )}
        </Block>

        <Block title={copy.raid.title}>
          {blueprint.raid.length === 0 ? (
            <p className="text-sm text-muted-foreground">{copy.raid.empty}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {blueprint.raid.map((item, index) => (
                <li key={`${item.kind}-${index}`} className="flex items-center gap-2 text-[13px]">
                  <span className={cn('min-w-[3.5rem] shrink-0 rounded-md px-1.5 text-center text-[11px] font-semibold', KIND_STYLE[item.kind])}>
                    {t.projects.raid.kinds[item.kind]}
                  </span>
                  <span className="min-w-0">{item.title}</span>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block title={copy.control.title}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13px]">
            {control.map((line) => (
              <div key={line.key} className="contents">
                <dt className="text-muted-foreground">{copy.control[line.key]}</dt>
                <dd>{line.value}</dd>
              </div>
            ))}
          </dl>
        </Block>
      </div>
    </section>
  );
}
