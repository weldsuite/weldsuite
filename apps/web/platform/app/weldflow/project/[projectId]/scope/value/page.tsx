import { useMemo, useState } from 'react';
import { Plus, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { useParams } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import type { Benefit, BenefitDetail, BenefitStatus } from '@weldsuite/app-api-client/domains/project-governance';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useProjectGoals } from '@/hooks/queries/use-projects-queries';
import { useBenefit, useBenefits, useDeleteBenefit } from '@/hooks/queries/use-project-governance-queries';
import { useFormatters, useGovernance } from '../../governance/_lib/use-governance';
import { Bar, ConfirmDelete, EmptyBlock, ErrorBlock, LoadingBlocks, MemberLabel, Pill, type Tone } from '../../governance/_components/parts';
import { SummaryTile } from '../../raid/_components/raid-parts';
import { BenefitDialogs, type BenefitDialogState } from './_components/benefit-dialogs';

const STATUS_TONE: Record<BenefitStatus, Tone> = { planned: 'neutral', measuring: 'info', at_risk: 'danger', realised: 'success', closed: 'neutral' };

/** Scope › Business value: the benefits register, a trend chart and what needs attention. */
export default function BusinessValuePage() {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.value;
  const params = useParams();
  const projectId = String(params.projectId ?? '');
  const { abilities, memberOf, memberOptions } = useGovernance(projectId);
  const formatters = useFormatters();
  const benefitsQuery = useBenefits(projectId);
  const goalsQuery = useProjectGoals(projectId);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<BenefitDialogState | null>(null);
  const [confirming, setConfirming] = useState<Benefit | null>(null);
  const remove = useDeleteBenefit();

  const benefits = useMemo(() => [...(benefitsQuery.data ?? [])].sort((a, b) => a.number - b.number), [benefitsQuery.data]);
  const current = benefits.find((b) => b.id === selectedId) ?? benefits[0] ?? null;
  const detailQuery = useBenefit(current?.id ?? null);

  const goalCards = useMemo(
    () => (goalsQuery.data?.data?.goals ?? []).map((goal) => ({ id: goal.id, title: goal.title })),
    [goalsQuery.data],
  );
  const goalTitle = (ref: string | null) => goalCards.find((goal) => goal.id === ref)?.title ?? null;

  const dialogs = (
    <BenefitDialogs
      projectId={projectId}
      state={dialog}
      memberOptions={memberOptions}
      goalOptions={goalCards.map((goal) => ({ value: goal.id, label: goal.title }))}
      onClose={() => setDialog(null)}
      onSaved={(id) => {
        setDialog(null);
        setSelectedId(id);
      }}
    />
  );

  if (benefitsQuery.isLoading) return <LoadingBlocks label={copy.title} />;
  if (benefitsQuery.isError) return <ErrorBlock onRetry={() => void benefitsQuery.refetch()} />;

  const header = (
    <div className="flex flex-wrap items-center gap-2.5">
      <p className="min-w-0 flex-[1_1_30rem] text-[13px] leading-snug text-muted-foreground">{copy.intro}</p>
      {abilities.create ? (
        <Button type="button" onClick={() => setDialog({ kind: 'create' })}>
          <Plus aria-hidden />
          {copy.newBenefit}
        </Button>
      ) : null}
    </div>
  );

  if (benefits.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        <EmptyBlock
          icon={<TrendingUp aria-hidden className="size-6" />}
          title={copy.emptyTitle}
          description={abilities.create ? copy.emptyDescription : copy.emptyReadOnly}
        />
        {dialogs}
      </div>
    );
  }

  const count = (status: BenefitStatus) => benefits.filter((b) => b.status === status).length;
  const now = new Date();
  const overdue = benefits.filter(
    (b) => b.realiseBy && new Date(b.realiseBy) < now && (b.status === 'planned' || b.status === 'measuring' || b.status === 'at_risk'),
  );
  const atRisk = benefits.filter((b) => b.status === 'at_risk');

  const onDelete = async () => {
    if (!confirming) return;
    try {
      await remove.mutateAsync(confirming.id);
      toast.success(copy.toasts.deleted);
      setConfirming(null);
      setSelectedId(null);
    } catch {
      toast.error(t.flowGovernance.common.deleteFailed);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {header}

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(11.5rem,1fr))]">
        <SummaryTile label={copy.tiles.total} value={benefits.length} />
        <SummaryTile label={copy.tiles.measuring} value={count('measuring')} />
        <SummaryTile label={copy.tiles.realised} value={count('realised')} hint={count('realised') === 0 ? copy.tiles.realisedHint : undefined} />
        <SummaryTile label={copy.tiles.atRisk} value={count('at_risk')} tone={count('at_risk') > 0 ? 'danger' : undefined} />
      </div>

      <section aria-labelledby="benefit-register" className="overflow-hidden rounded-lg border bg-card">
        <div className="border-b px-4 py-3.5">
          <h2 id="benefit-register" className="text-[15px] font-semibold">
            {copy.register}
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[68rem] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2.5 font-medium">{copy.columns.benefit}</th>
                <th scope="col" className="px-2 py-2.5 font-medium">{copy.columns.measure}</th>
                <th scope="col" className="px-2 py-2.5 text-right font-medium">{copy.columns.baseline}</th>
                <th scope="col" className="px-2 py-2.5 text-right font-medium">{copy.columns.now}</th>
                <th scope="col" className="px-2 py-2.5 text-right font-medium">{copy.columns.target}</th>
                <th scope="col" className="px-2 py-2.5 font-medium">{copy.columns.progress}</th>
                <th scope="col" className="px-2 py-2.5 font-medium">{copy.columns.realiseBy}</th>
                <th scope="col" className="py-2.5 pr-4 pl-2 font-medium">{copy.columns.status}</th>
              </tr>
            </thead>
            <tbody>
              {benefits.map((b) => {
                const on = b.id === current?.id;
                const late = !!b.realiseBy && new Date(b.realiseBy) < now && b.status !== 'realised' && b.status !== 'closed';
                const metricKey = b.metric as keyof typeof copy.metrics;
                return (
                  <tr key={b.id} className={cn('border-t align-top', on && 'bg-muted/40')}>
                    <td className="max-w-80 px-4 py-3">
                      <div className="flex gap-2">
                        <span className="text-xs text-muted-foreground">{b.code}</span>
                        <button type="button" onClick={() => setSelectedId(b.id)} aria-pressed={on} className="text-left font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
                          {b.title}
                        </button>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 pl-[1.9rem] text-xs text-muted-foreground">
                        {goalTitle(b.goalRef) ? <span className="rounded-md border px-1.5">{goalTitle(b.goalRef)}</span> : null}
                        {b.ownerId ? <MemberLabel userId={b.ownerId} member={memberOf(b.ownerId)} /> : null}
                      </div>
                    </td>
                    <td className="px-2 py-3">
                      <div>{copy.metrics[metricKey] ?? b.metric}</div>
                      <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <span aria-hidden className="size-1.5 rounded-full bg-green-600" />
                        {copy.sources[metricKey] ?? ''}
                      </div>
                    </td>
                    <td className="px-2 py-3 text-right whitespace-nowrap tabular-nums text-foreground/70">{b.baselineValue ? formatters.value(b.baselineValue, b.unit) : copy.noValue}</td>
                    <td className="px-2 py-3 text-right font-semibold whitespace-nowrap tabular-nums">
                      {b.latest ? formatters.value(b.latest.value, b.unit) : b.status === 'planned' ? copy.startsAtGoLive : copy.noValue}
                    </td>
                    <td className="px-2 py-3 text-right whitespace-nowrap tabular-nums">{b.targetValue ? formatters.value(b.targetValue, b.unit) : copy.noValue}</td>
                    <td className="w-36 px-2 py-3">
                      {b.progressPct === null ? (
                        <span className="text-xs text-muted-foreground">{copy.noProgress}</span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <Bar percent={b.progressPct} label={`${b.code} ${b.progressPct}%`} />
                          <span className="text-xs text-foreground/70">{b.progressPct}%</span>
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-3 text-xs whitespace-nowrap">
                      <div className={cn(late && 'text-red-700 dark:text-red-400')}>{b.realiseBy ? formatters.date(b.realiseBy) : copy.noValue}</div>
                    </td>
                    <td className="py-3 pr-4 pl-2">
                      <Pill tone={STATUS_TONE[b.status]}>{copy.statuses[b.status]}</Pill>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex flex-wrap items-stretch gap-4">
        <section aria-labelledby="benefit-trend" className="min-w-0 flex-[999_1_34rem] rounded-lg border bg-card p-4 sm:p-5">
          {current ? (
            <BenefitTrend
              benefit={current}
              detail={detailQuery.data ?? null}
              canWrite={abilities.update}
              canDelete={abilities.remove}
              onMeasure={() => setDialog({ kind: 'measure', benefit: current })}
              onEdit={() => setDialog({ kind: 'edit', benefit: current })}
              onDelete={() => setConfirming(current)}
            />
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground">{copy.trend.pickBenefit}</p>
          )}
        </section>

        <section aria-labelledby="benefit-attention" className="min-w-0 max-w-full flex-[1_1_21rem] rounded-lg border bg-card p-4 sm:max-w-[28.75rem] sm:p-5">
          <h2 id="benefit-attention" className="text-[15px] font-semibold">
            {copy.attention.title}
          </h2>
          {atRisk.length === 0 && overdue.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">{copy.attention.none}</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2.5">
              {atRisk.map((b) => (
                <div key={b.id} className="rounded-lg bg-red-50 px-3.5 py-3 dark:bg-red-950/40">
                  <div className="font-semibold text-red-900 dark:text-red-300">{format(copy.attention.atRisk, { code: b.code })}</div>
                  <p className="mt-1 text-[13px] text-red-900 dark:text-red-300">{b.title}</p>
                </div>
              ))}
              {overdue
                .filter((b) => b.status !== 'at_risk')
                .map((b) => (
                  <div key={b.id} className="rounded-lg bg-muted px-3.5 py-3">
                    <div className="font-semibold">{format(copy.attention.overdue, { code: b.code, date: formatters.date(b.realiseBy) })}</div>
                    <p className="mt-1 text-[13px] text-foreground/80">{b.title}</p>
                  </div>
                ))}
            </div>
          )}
          <p className="mt-4 text-xs leading-snug text-muted-foreground">{copy.attention.footer}</p>
        </section>
      </div>

      {dialogs}
      <ConfirmDelete open={!!confirming} code={confirming?.code ?? ''} pending={remove.isPending} onCancel={() => setConfirming(null)} onConfirm={() => void onDelete()} />
    </div>
  );
}

// ── Trend chart ─────────────────────────────────────────────────────────────

const W = 640;
const H = 220;
const PAD = { left: 48, right: 24, top: 18, bottom: 28 };

function BenefitTrend({
  benefit,
  detail,
  canWrite,
  canDelete,
  onMeasure,
  onEdit,
  onDelete,
}: Readonly<{
  benefit: Benefit;
  detail: BenefitDetail | null;
  canWrite: boolean;
  canDelete: boolean;
  onMeasure: () => void;
  onEdit: () => void;
  onDelete: () => void;
}>) {
  const { t, format } = useI18n();
  const copy = t.flowGovernance.value;
  const formatters = useFormatters();
  const metricKey = benefit.metric as keyof typeof copy.metrics;
  const points = (detail?.measurements ?? []).map((m) => ({ period: m.period, value: Number(m.value) })).filter((p) => Number.isFinite(p.value));
  const target = benefit.targetValue !== null ? Number(benefit.targetValue) : null;

  const values = [...points.map((p) => p.value), ...(target !== null ? [target] : [])];
  const max = values.length ? Math.max(...values, 0) : 1;
  const min = values.length ? Math.min(...values, 0) : 0;
  const span = max - min || 1;
  const x = (index: number) => PAD.left + (points.length <= 1 ? (W - PAD.left - PAD.right) / 2 : (index / (points.length - 1)) * (W - PAD.left - PAD.right));
  const y = (value: number) => PAD.top + (1 - (value - min) / span) * (H - PAD.top - PAD.bottom);
  const latest = points[points.length - 1];

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 id="benefit-trend" className="flex-1 text-[15px] font-semibold">
          {format(copy.trend.title, { code: benefit.code, name: benefit.title })}
        </h2>
        <span className="text-xs text-muted-foreground">{format(copy.trend.source, { source: copy.sources[metricKey] ?? '' })}</span>
      </div>

      {points.length === 0 ? (
        <p className="mt-6 mb-4 rounded-lg bg-muted px-3.5 py-6 text-center text-sm text-muted-foreground">{copy.trend.empty}</p>
      ) : (
        <svg
          role="img"
          aria-label={format(copy.trend.chartLabel, {
            name: benefit.title,
            count: points.length,
            value: latest ? formatters.value(String(latest.value), benefit.unit) : '',
          })}
          viewBox={`0 0 ${W} ${H}`}
          className="mt-2.5 h-auto w-full"
        >
          <line x1={PAD.left} y1={y(min)} x2={W - PAD.right} y2={y(min)} className="stroke-border" />
          <text x={PAD.left - 8} y={y(min) + 4} fontSize="10" textAnchor="end" className="fill-muted-foreground">
            {formatters.value(String(min))}
          </text>
          <text x={PAD.left - 8} y={y(max) + 4} fontSize="10" textAnchor="end" className="fill-muted-foreground">
            {formatters.value(String(max))}
          </text>
          {target !== null ? (
            <>
              <line x1={PAD.left} y1={y(target)} x2={W - PAD.right} y2={y(target)} strokeDasharray="2 4" className="stroke-green-600" />
              <text x={W - PAD.right} y={y(target) - 5} fontSize="10" textAnchor="end" className="fill-green-700 dark:fill-green-400">
                {format(copy.trend.target, { value: formatters.value(String(target), benefit.unit) })}
              </text>
            </>
          ) : null}
          <polyline fill="none" strokeWidth="2" points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} className="stroke-foreground" />
          {points.map((p, i) => (
            <g key={p.period}>
              <circle cx={x(i)} cy={y(p.value)} r={i === points.length - 1 ? 4 : 3} className="fill-foreground" />
              <text x={x(i)} y={H - 8} fontSize="10" textAnchor="middle" className="fill-muted-foreground">
                {formatters.month(p.period)}
              </text>
            </g>
          ))}
          {latest ? (
            <text x={x(points.length - 1)} y={y(latest.value) - 9} fontSize="10" fontWeight="600" textAnchor="middle" className="fill-foreground">
              {formatters.value(String(latest.value))}
            </text>
          ) : null}
        </svg>
      )}

      <div className="mt-2 flex flex-wrap justify-end gap-2">
        {canDelete ? (
          <Button type="button" variant="ghost" size="sm" onClick={onDelete}>
            {t.flowGovernance.common.delete}
          </Button>
        ) : null}
        {canWrite ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={onEdit}>
              {t.flowGovernance.common.edit}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onMeasure}>
              {copy.trend.addValue}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
