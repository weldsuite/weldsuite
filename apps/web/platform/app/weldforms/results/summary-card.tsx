/**
 * One card of the Summary tab: the question and a chart that fits its kind.
 * The numbers are worked out in `summary-cards.ts`; this lays them out, with
 * theme tokens only so dark mode needs nothing extra.
 */

import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { AiSummaryCard } from './ai-summary-card';
import { npsTone, type SummaryCardModel } from './summary-cards';

type Strings = ReturnType<typeof useI18n>['t']['weldformsResults']['results']['summary'];

export function SummaryCard({
  model,
  formId,
  responseCount,
}: Readonly<{ model: SummaryCardModel; formId: string; responseCount: number }>) {
  const { t, format, language } = useI18n();
  const ts = t.weldformsResults.results.summary;
  const dateTime = new Intl.DateTimeFormat(language, { dateStyle: 'medium' });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="space-y-1 pb-3">
          <CardTitle className="text-base font-semibold">{model.title}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {model.answered === 1 ? ts.answeredOne : format(ts.answered, { count: model.answered })}
          </p>
        </CardHeader>
        <CardContent>
          {model.answered === 0 && model.kind !== 'files' ? (
            <p className="text-sm text-muted-foreground">{ts.noAnswers}</p>
          ) : (
            <CardBody model={model} ts={ts} dateFormat={dateTime} format={format} />
          )}
        </CardContent>
      </Card>
      {model.kind === 'text' && model.answered > 0 && (
        <AiSummaryCard
          formId={formId}
          blockId={model.blockId}
          title={t.weldformsResults.results.ai.title}
          canGenerate
          responseCount={responseCount}
        />
      )}
    </div>
  );
}

function CardBody({
  model,
  ts,
  dateFormat,
  format,
}: Readonly<{
  model: SummaryCardModel;
  ts: Strings;
  dateFormat: Intl.DateTimeFormat;
  format: (text: string, values: Record<string, string | number>) => string;
}>) {
  switch (model.kind) {
    case 'choice':
      return (
        <div className="space-y-3">
          {model.bars.map((bar) => (
            <BarRow
              key={bar.id}
              label={bar.label}
              width={bar.width}
              caption={format(ts.counts, { count: bar.count, percent: bar.percent })}
            />
          ))}
          {model.other > 0 && (
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {ts.other} <span className="font-normal text-muted-foreground">({model.other})</span>
              </p>
              <LatestList items={model.otherLatest} dateFormat={dateFormat} />
            </div>
          )}
        </div>
      );

    case 'numeric':
      return (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            <Stat label={ts.average} value={model.average === null ? '—' : String(round(model.average))} large />
            <Stat label={ts.min} value={model.min === null ? '—' : String(model.min)} />
            <Stat label={ts.max} value={model.max === null ? '—' : String(model.max)} />
          </div>
          <Histogram bars={model.bars} />
        </div>
      );

    case 'nps':
      return (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
            <div>
              <p className="text-xs text-muted-foreground">{ts.nps.score}</p>
              <p
                className={cn(
                  'text-3xl font-bold tabular-nums',
                  npsTone(model.score) === 'danger' && 'text-destructive',
                  npsTone(model.score) === 'warning' && 'text-amber-600 dark:text-amber-400',
                  npsTone(model.score) === 'success' && 'text-emerald-600 dark:text-emerald-400',
                )}
              >
                {model.score === null ? '—' : Math.round(model.score)}
              </p>
            </div>
          </div>
          {model.gauge !== null && (
            <div className="relative pt-1" role="img" aria-label={`${ts.nps.gauge}: ${Math.round(model.score ?? 0)}`}>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full">
                <div className="w-1/3 bg-red-500/70" />
                <div className="w-1/3 bg-amber-400/70" />
                <div className="w-1/3 bg-emerald-500/70" />
              </div>
              <span
                className="absolute top-0 w-1 -translate-x-1/2 rounded bg-foreground"
                style={{ left: `${model.gauge}%`, height: '1.125rem' }}
                aria-hidden
              />
            </div>
          )}
          <div className="grid grid-cols-3 gap-3 text-center">
            {model.segments.map((segment) => (
              <div key={segment.id} className="rounded-md border p-2">
                <p className="text-xs text-muted-foreground">{ts.nps[segment.id]}</p>
                <p className="text-lg font-semibold tabular-nums">{segment.count}</p>
                <p className="text-xs tabular-nums text-muted-foreground">{segment.percent}%</p>
              </div>
            ))}
          </div>
          <Histogram bars={model.bars} />
        </div>
      );

    case 'boolean':
      return (
        <div className="space-y-3">
          <div
            className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`${ts.yes} ${model.yesPercent}%, ${ts.no} ${model.noPercent}%`}
          >
            <div className="bg-primary" style={{ width: `${model.yesPercent}%` }} />
            <div className="bg-muted-foreground/40" style={{ width: `${model.noPercent}%` }} />
          </div>
          <div className="flex justify-between text-sm">
            <span>
              <span className="font-medium">{ts.yes}</span>{' '}
              <span className="text-muted-foreground">{format(ts.counts, { count: model.yes, percent: model.yesPercent })}</span>
            </span>
            <span>
              <span className="font-medium">{ts.no}</span>{' '}
              <span className="text-muted-foreground">{format(ts.counts, { count: model.no, percent: model.noPercent })}</span>
            </span>
          </div>
        </div>
      );

    case 'text':
      return (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{ts.latestAnswers}</p>
          <LatestList items={model.latest} dateFormat={dateFormat} />
        </div>
      );

    case 'matrix':
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="p-2 text-left font-medium text-muted-foreground">{ts.matrixRow}</th>
                {model.columns.map((column) => (
                  <th key={column.id} className="p-2 text-center font-medium text-muted-foreground">
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.rows.map((row) => (
                <tr key={row.id} className="border-t">
                  <th scope="row" className="p-2 text-left font-medium">
                    {row.label}
                  </th>
                  {row.cells.map((cell) => (
                    <td key={cell.columnId} className="p-1 text-center">
                      <div
                        className="rounded px-2 py-1.5 tabular-nums"
                        style={{ backgroundColor: `color-mix(in oklab, var(--primary) ${Math.round(cell.intensity * 70)}%, transparent)` }}
                        title={format(ts.counts, { count: cell.count, percent: cell.percent })}
                      >
                        {cell.count}
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'ranking':
      return (
        <ol className="space-y-2">
          {model.choices.map((choice) => (
            <li key={choice.id} className="flex items-center gap-3 text-sm">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                {choice.rank ?? '–'}
              </span>
              <span className="min-w-0 flex-1 truncate">{choice.label}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {choice.averageRank === null ? ts.notRanked : format(ts.averageRank, { rank: round(choice.averageRank) })}
              </span>
            </li>
          ))}
        </ol>
      );

    case 'files':
      return (
        <p className="text-2xl font-bold tabular-nums">
          {model.files === 1 ? ts.filesOne : format(ts.files, { count: model.files })}
        </p>
      );
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function Stat({ label, value, large }: Readonly<{ label: string; value: string; large?: boolean }>) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('font-semibold tabular-nums', large ? 'text-3xl font-bold' : 'text-lg')}>{value}</p>
    </div>
  );
}

function BarRow({ label, width, caption }: Readonly<{ label: ReactNode; width: number; caption: string }>) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{caption}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function Histogram({ bars }: Readonly<{ bars: Array<{ value: number; count: number; height: number }> }>) {
  if (bars.length === 0) return null;
  return (
    <div className="flex h-24 items-end gap-1" role="img" aria-label={bars.map((b) => `${b.value}: ${b.count}`).join(', ')}>
      {bars.map((bar) => (
        <div key={bar.value} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-1" title={`${bar.value}: ${bar.count}`}>
          <div className="w-full rounded-t bg-primary/80" style={{ height: `${Math.max(bar.count > 0 ? 4 : 0, bar.height)}%` }} />
          <span className="text-center text-[10px] tabular-nums text-muted-foreground">{bar.value}</span>
        </div>
      ))}
    </div>
  );
}

function LatestList({
  items,
  dateFormat,
}: Readonly<{ items: Array<{ responseId: string; value: string; submittedAt: string }>; dateFormat: Intl.DateTimeFormat }>) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.responseId} className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <p className="whitespace-pre-wrap break-words">{item.value}</p>
          <p className="mt-1 text-xs text-muted-foreground">{dateFormat.format(new Date(item.submittedAt))}</p>
        </li>
      ))}
    </ul>
  );
}
