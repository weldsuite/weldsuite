/**
 * The assessment part of a risk's detail: where it sits on the matrix, how its
 * score moved over time, and the history of assessments.
 */

import { Skeleton } from '@weldsuite/ui/components/skeleton';
import type { RaidAssessment, RaidItem } from '@weldsuite/app-api-client/domains/project-control';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { intlLocaleOf } from '../_lib/locale';
import { formatShortDate } from '../_lib/raid';
import { RATINGS, buildTrendChart, riskBand, riskScore, trendLabelIndexes, trendOf, type Trend } from '../_lib/risk';
import { BAND_STYLES } from '../_lib/styles';
import { ScoreBadge } from './raid-parts';
import { useRaid } from './raid-context';

/** A 5 x 5 grid with the risk's current position (filled dot) and its target (dashed circle). */
function MiniMatrix({ risk }: Readonly<{ risk: RaidItem }>) {
  const { t, format } = useI18n();
  const copy = t.projects.raid.detail;
  const hasTarget = risk.residualProbability !== null && risk.residualImpact !== null;
  const rows = [...RATINGS].reverse();

  return (
    <div className="shrink-0 rounded-lg border p-3">
      <div className="flex flex-col gap-[3px]" role="img" aria-label={`${copy.assessment}: ${format(copy.nowScore, { probability: risk.probability ?? '', impact: risk.impact ?? '', score: risk.score ?? '' })}`}>
        {rows.map((probability) => (
          <div key={probability} className="grid grid-cols-[12px_repeat(5,22px)] items-center gap-[3px]">
            <span className="text-center text-[10px] text-muted-foreground">{probability}</span>
            {RATINGS.map((impact) => {
              const now = risk.probability === probability && risk.impact === impact;
              const target = hasTarget && risk.residualProbability === probability && risk.residualImpact === impact;
              return (
                <div
                  key={impact}
                  className={cn('flex size-[22px] items-center justify-center rounded', BAND_STYLES[riskBand(riskScore(probability, impact))].cell)}
                >
                  {now ? <span className="size-3 rounded-full border-2 border-white bg-neutral-900 box-content dark:border-neutral-900 dark:bg-white" /> : null}
                  {target ? <span className="size-3 rounded-full border-2 border-dashed border-neutral-900 bg-white box-content dark:border-white dark:bg-neutral-900" /> : null}
                </div>
              );
            })}
          </div>
        ))}
        <div className="grid grid-cols-[12px_repeat(5,22px)] gap-[3px]">
          <span />
          {RATINGS.map((impact) => (
            <span key={impact} className="text-center text-[10px] text-muted-foreground">
              {impact}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-2.5 flex flex-col gap-1 text-[11px] text-foreground/80">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-full bg-foreground" />
          {risk.probability !== null && risk.impact !== null && risk.score !== null
            ? format(copy.nowScore, { probability: risk.probability, impact: risk.impact, score: risk.score })
            : null}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-1.5 rounded-full border border-dashed border-foreground" />
          {hasTarget && risk.residualScore !== null
            ? format(copy.targetScore, { probability: risk.residualProbability ?? '', impact: risk.residualImpact ?? '', score: risk.residualScore })
            : copy.noTarget}
        </span>
      </div>
    </div>
  );
}

const TREND_TEXT: Record<Exclude<Trend, 'none'>, string> = {
  up: 'text-red-700 dark:text-red-400',
  down: 'text-green-700 dark:text-green-400',
  flat: 'text-muted-foreground',
};

const TREND_ARROW: Record<Exclude<Trend, 'none'>, string> = { up: '↑', down: '↓', flat: '→' };

/** The score of each assessment over time, on the band colours. `assessments` newest first. */
function TrendChart({ assessments }: Readonly<{ assessments: readonly RaidAssessment[] }>) {
  const { t, language, format } = useI18n();
  const copy = t.projects.raid.detail;
  const { now } = useRaid();
  const intlLocale = intlLocaleOf(language);
  const chart = buildTrendChart(assessments);
  const trend = trendOf(assessments);
  const first = chart.points[0];
  const last = chart.points[chart.points.length - 1];
  const summary =
    first && last && chart.points.length > 1
      ? format(copy.trendSummary, {
          from: first.score,
          fromDate: formatShortDate(first.assessedAt, intlLocale, now),
          to: last.score,
          toDate: formatShortDate(last.assessedAt, intlLocale, now),
        })
      : format(copy.trendSingle, { score: last?.score ?? '' });
  const labelled = new Set(trendLabelIndexes(chart.points.length));

  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-lg border px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{copy.scoreOverTime}</span>
        {trend !== 'none' ? (
          <span className={cn('text-xs font-medium', TREND_TEXT[trend])}>
            {TREND_ARROW[trend]} {copy.trend[trend]}
          </span>
        ) : null}
      </div>
      <svg role="img" aria-label={summary} viewBox="0 0 240 120" className="mt-2 h-auto w-full">
        {chart.bands.map((band) => (
          <rect key={band.band} x={0} y={band.y} width={240} height={band.height} className={BAND_STYLES[band.band].stripe} />
        ))}
        <line x1={0} y1={chart.plot.bottom} x2={240} y2={chart.plot.bottom} className="stroke-border" />
        <polyline points={chart.polyline} fill="none" strokeWidth={2} className="stroke-foreground" />
        {chart.points.map((point, index) => {
          const isLast = index === chart.points.length - 1;
          return (
            <g key={`${point.assessedAt}-${index}`}>
              <circle
                cx={point.x}
                cy={point.y}
                r={isLast ? 4.5 : 3.5}
                strokeWidth={isLast ? 1.5 : 0}
                className={cn('stroke-background', isLast && point.band === 'critical' ? 'fill-red-600' : 'fill-foreground')}
              />
              <text x={point.x} y={point.y - 6} fontSize={10} textAnchor="middle" className={cn('fill-foreground/80', isLast && 'font-bold')}>
                {point.score}
              </text>
              {labelled.has(index) ? (
                <text x={point.x} y={100} fontSize={10} textAnchor="middle" className="fill-muted-foreground">
                  {formatShortDate(point.assessedAt, intlLocale, now)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** The matrix position and the score trend side by side. */
export function AssessmentSummary({ risk, assessments }: Readonly<{ risk: RaidItem; assessments: readonly RaidAssessment[] | undefined }>) {
  const { t } = useI18n();
  return (
    <section aria-labelledby="raid-assessment-title" className="px-6 pt-5">
      <h2 id="raid-assessment-title" className="mb-3 text-sm font-semibold">
        {t.projects.raid.detail.assessment}
      </h2>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-stretch">
        <MiniMatrix risk={risk} />
        {assessments ? <TrendChart assessments={assessments} /> : <Skeleton className="h-36 flex-1 rounded-lg" />}
      </div>
    </section>
  );
}

/** Every assessment of the risk, newest first, with who made it and why. */
export function AssessmentHistory({ assessments }: Readonly<{ assessments: readonly RaidAssessment[] | undefined }>) {
  const { t, language, format } = useI18n();
  const copy = t.projects.raid.detail;
  const { memberOf, now } = useRaid();
  const intlLocale = intlLocaleOf(language);

  return (
    <section aria-labelledby="raid-history-title" className="px-6 pt-6 pb-7">
      <h2 id="raid-history-title" className="mb-3 text-sm font-semibold">
        {copy.history}
      </h2>
      {assessments ? (
        <ol className="flex flex-col gap-3.5">
          {assessments.map((assessment) => (
            <li key={assessment.id} className="flex gap-3">
              <ScoreBadge score={assessment.score} band={assessment.band} showLabel={false} className="h-[22px] min-w-[34px] shrink-0 justify-center" />
              <div className="min-w-0 text-[13px]">
                <div>
                  <span className="font-medium">{memberOf(assessment.assessedBy)?.name ?? '—'}</span>
                  <span className="text-muted-foreground">
                    {' · '}
                    {assessment.probability} × {assessment.impact}
                    {' · '}
                    {formatShortDate(assessment.assessedAt, intlLocale, now)}
                  </span>
                </div>
                <div className={cn('mt-0.5 leading-relaxed whitespace-pre-wrap', assessment.note ? 'text-foreground/80' : 'text-muted-foreground')}>
                  {assessment.note ?? copy.noNote}
                </div>
                {assessment.residualProbability !== null && assessment.residualImpact !== null ? (
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {format(copy.targetScore, {
                      probability: assessment.residualProbability,
                      impact: assessment.residualImpact,
                      score: assessment.residualProbability * assessment.residualImpact,
                    })}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="space-y-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      )}
    </section>
  );
}
