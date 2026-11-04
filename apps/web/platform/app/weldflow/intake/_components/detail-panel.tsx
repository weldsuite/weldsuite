import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import type { FlowWorkspaceSettings, ProjectRequestDetail } from '@weldsuite/app-api-client/domains/flow-portfolio';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import {
  useDeleteProjectRequest,
  useProjectRequest,
  useScoreProjectRequest,
  useSubmitProjectRequest,
} from '@/hooks/queries/use-flow-portfolio-queries';
import { formatDay, intlLocaleOf } from '../../capacity/_lib/capacity';
import { STATUS_CLASS, formatMoney, paybackMonths } from '../_lib/intake';

interface DetailProps {
  requestId: string | null;
  settings: FlowWorkspaceSettings | undefined;
  /** May rate the criteria: the board, or `portfolio:manage`. */
  canScore: boolean;
  /** May edit, submit and delete: whoever filed it, or `portfolio:manage`. */
  canChange: (requestedBy: string) => boolean;
  nameOf: (id: string) => string;
  onEdit: (request: ProjectRequestDetail) => void;
  onCreateProject: (request: ProjectRequestDetail) => void;
  onDeleted: () => void;
}

function RatingButtons({ value, label, disabled, onPick }: Readonly<{ value: number | null; label: string; disabled: boolean; onPick: (v: number) => void }>) {
  const { t, format } = useI18n();
  return (
    <div role="group" aria-label={format(t.flowPortfolio.intake.detail.rate, { label })} className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((v) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          aria-pressed={value === v}
          onClick={() => onPick(v)}
          className={cn(
            'size-6 rounded text-xs font-medium',
            value === v ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground/70 enabled:hover:bg-muted/70',
          )}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

/** One request: its score and how it adds up, the capacity it needs, the board's answers and the next step. */
export function DetailPanel({ requestId, settings, canScore, canChange, nameOf, onEdit, onCreateProject, onDeleted }: Readonly<DetailProps>) {
  const { t, format, language } = useI18n();
  const copy = t.flowPortfolio.intake.detail;
  const locale = intlLocaleOf(language);
  const { data: request, isLoading, isError } = useProjectRequest(requestId);
  const score = useScoreProjectRequest();
  const submit = useSubmitProjectRequest();
  const remove = useDeleteProjectRequest();
  const [confirming, setConfirming] = useState(false);

  if (!requestId) return <p className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">{copy.select}</p>;
  if (isLoading) return <div className="h-64 animate-pulse rounded-lg border bg-muted/30" />;
  if (isError || !request) return <p role="alert" className="rounded-lg border bg-card p-6 text-sm text-destructive">{t.flowPortfolio.common.loadFailed}</p>;

  const open = request.status === 'new' || request.status === 'assessing';
  const mine = canChange(request.requestedBy);
  const rate = (key: string, value: number) => {
    const keys = new Set(request.breakdown.map((line) => line.key));
    const scores = Object.fromEntries(Object.entries({ ...request.scores, [key]: value }).filter(([k]) => keys.has(k)));
    score.mutate({ id: request.id, input: { scores } }, { onSuccess: () => toast.success(copy.scored), onError: () => toast.error(t.flowPortfolio.common.saveFailed) });
  };
  const months = paybackMonths(request.estimatedCost, request.estimatedValue);
  const boardEmpty = (settings?.portfolioBoardIds.length ?? 0) === 0;
  const desired = request.desiredStart
    ? request.desiredEnd
      ? format(copy.desired, { from: formatDay(request.desiredStart, locale), to: formatDay(request.desiredEnd, locale) })
      : format(copy.desiredFrom, { from: formatDay(request.desiredStart, locale) })
    : null;

  return (
    <section aria-labelledby="detail-title" className="overflow-hidden rounded-lg border bg-card">
      <div className="border-b p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-muted-foreground">
              {request.code} · {nameOf(request.requestedBy)}
            </div>
            <h2 id="detail-title" className="mt-1 text-[17px] font-semibold">
              {request.title}
            </h2>
            <span className={cn('mt-1.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium', STATUS_CLASS[request.status])}>
              {t.flowPortfolio.intake.status[request.status]}
            </span>
          </div>
          <div className="rounded-lg bg-primary/10 px-2.5 py-1.5 text-center">
            <div className="text-xl leading-none font-bold">{request.score === null ? '–' : Math.round(request.score)}</div>
            <div className="mt-0.5 text-[10px] font-semibold uppercase">{copy.score}</div>
          </div>
        </div>
        {request.businessCase ? <p className="mt-2.5 text-[13px] leading-relaxed text-foreground/80">{request.businessCase}</p> : null}
        <dl className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
          <div>
            <dt className="inline text-muted-foreground">{copy.cost} </dt>
            <dd className="inline">{formatMoney(request.estimatedCost, locale)}</dd>
          </div>
          <div>
            <dt className="inline text-muted-foreground">{copy.value} </dt>
            <dd className="inline">{formatMoney(request.estimatedValue, locale)}</dd>
          </div>
          {months === null ? null : (
            <div>
              <dt className="inline text-muted-foreground">{copy.payback} </dt>
              <dd className="inline">{format(copy.paybackMonths, { months })}</dd>
            </div>
          )}
        </dl>
        {desired ? <p className="mt-1.5 text-xs text-muted-foreground">{desired}</p> : null}
      </div>

      <div className="border-b p-4">
        <h3 className="mb-2.5 text-[13px] font-semibold">{copy.howScoreAddsUp}</h3>
        <ul className="flex flex-col gap-2">
          {request.breakdown.map((line) => (
            <li key={line.key} className="grid grid-cols-[110px_minmax(0,1fr)_52px] items-center gap-2 text-xs">
              <span>
                {line.label} {line.weight}%
              </span>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-2 bg-primary" style={{ width: `${line.points === null ? 0 : Math.round((line.points / line.weight) * 100)}%` }} />
              </div>
              <span className="text-right font-semibold tabular-nums">
                {line.points === null ? copy.notRated : format(copy.points, { points: line.points, max: line.weight })}
              </span>
              {canScore && open ? (
                <div className="col-span-3">
                  <RatingButtons value={line.value} label={line.label} disabled={score.isPending} onPick={(v) => rate(line.key, v)} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <div className="border-b p-4">
        <h3 className="text-[13px] font-semibold">{copy.fit}</h3>
        <p className="mb-2.5 text-xs text-muted-foreground">{format(copy.fitNote, { from: formatDay(request.fitWindow.from, locale), to: formatDay(request.fitWindow.to, locale) })}</p>
        {request.fit.length === 0 ? <p className="text-xs text-muted-foreground">{copy.noNeeds}</p> : null}
        <ul className="flex flex-col gap-1.5">
          {request.fit.map((fit) => (
            <li key={fit.skill} className="grid grid-cols-[80px_minmax(0,1fr)] items-baseline gap-2 text-xs">
              <span>{fit.skill}</span>
              <span className={cn(fit.short ? 'font-semibold text-orange-800 dark:text-orange-300' : 'text-green-800 dark:text-green-300')}>
                {fit.needHoursPerWeek === null
                  ? format(copy.fitFreeNoNeed, { free: fit.freeHoursPerWeek })
                  : format(copy.fitFree, { free: fit.freeHoursPerWeek, need: fit.needHoursPerWeek })}
                {fit.short ? ` · ${format(copy.fitShort, { weeks: fit.shortWeeks, total: fit.weeks })}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-b p-4">
        <h3 className="mb-2 text-[13px] font-semibold">{copy.board}</h3>
        {request.approvals.length === 0 ? <p className="text-xs text-muted-foreground">{copy.boardEmpty}</p> : null}
        <ul className="flex flex-col gap-1.5">
          {request.approvals.map((a) => (
            <li key={a.id} className="flex items-baseline justify-between gap-2 text-xs">
              <span>{nameOf(a.approverId)}</span>
              <span className="font-medium">{copy.decision[a.decision as keyof typeof copy.decision] ?? a.decision}</span>
            </li>
          ))}
        </ul>
        {request.status === 'assessing' ? <p className="mt-2 text-xs text-muted-foreground">{copy.myReviews}</p> : null}
      </div>

      <div className="flex flex-col gap-2 p-4">
        {request.status === 'new' && mine ? (
          <>
            <Button
              disabled={boardEmpty || submit.isPending}
              onClick={() => submit.mutate(request.id, { onSuccess: () => toast.success(copy.submitted), onError: () => toast.error(t.flowPortfolio.common.saveFailed) })}
            >
              {copy.submit}
            </Button>
            {boardEmpty ? <p className="text-xs text-muted-foreground">{copy.noBoard}</p> : null}
          </>
        ) : null}
        {request.status === 'approved' ? <Button onClick={() => onCreateProject(request)}>{copy.createProject}</Button> : null}
        {request.status === 'converted' ? <p className="text-xs text-muted-foreground">{copy.converted}</p> : null}
        {mine ? (
          <div className="flex gap-2">
            {open ? (
              <Button variant="outline" className="flex-1" onClick={() => onEdit(request)}>
                {copy.edit}
              </Button>
            ) : null}
            {request.status !== 'converted' ? (
              <Button variant="outline" className="flex-1 text-destructive" onClick={() => setConfirming(true)}>
                {copy.delete}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={copy.deleteTitle}
        description={copy.deleteBody}
        confirmLabel={copy.delete}
        cancelLabel={t.flowPortfolio.common.cancel}
        variant="destructive"
        onConfirm={async () => {
          await remove.mutateAsync(request.id);
          onDeleted();
        }}
      />
    </section>
  );
}
