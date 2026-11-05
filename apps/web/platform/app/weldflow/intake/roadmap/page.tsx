import { useState } from 'react';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { Button } from '@weldsuite/ui/components/button';
import type { RoadmapItem } from '@weldsuite/app-api-client/domains/flow-portfolio';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useRoadmap } from '@/hooks/queries/use-flow-portfolio-queries';
import { BAND_CLASS, bandOf, formatDay, intlLocaleOf } from '../../capacity/_lib/capacity';
import { lanePosition } from '../_lib/intake';

/** Running (solid), approved and not started (dashed blue), and if approved (dashed orange). */
function laneStyle(item: RoadmapItem): string {
  if (item.type === 'project') return 'bg-primary';
  return item.status === 'approved'
    ? 'border-[1.5px] border-dashed border-primary bg-primary/10'
    : 'border-[1.5px] border-dashed border-orange-600 bg-orange-100 dark:bg-orange-950';
}

/** The portfolio roadmap: current projects and approved requests per quarter, with the team's booked hours as a line. */
export default function RoadmapPage() {
  const { t, format, language } = useI18n();
  const copy = t.flowPortfolio.intake.roadmap;
  const locale = intlLocaleOf(language);
  const [tentative, setTentative] = useState(false);
  const { data, isLoading, isError, refetch } = useRoadmap({ tentative });

  return (
    <div className="flex flex-col gap-4 p-5">
      <section aria-labelledby="roadmap-title" className="overflow-hidden rounded-lg border bg-card">
        <div className="flex flex-wrap items-center gap-4 border-b px-4 py-3">
          <h2 id="roadmap-title" className="flex-1 text-[15px] font-semibold">
            {copy.title}
          </h2>
          <span className="inline-flex items-center gap-1.5 text-xs text-foreground/80">
            <span aria-hidden className="h-2 w-[18px] rounded-sm bg-primary" />
            {copy.running}
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-foreground/80">
            <span aria-hidden className="h-2 w-[18px] rounded-sm border-[1.5px] border-dashed border-primary bg-primary/10" />
            {copy.approved}
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs text-foreground/80">
            <span aria-hidden className="h-2 w-[18px] rounded-sm border-[1.5px] border-dashed border-orange-600 bg-orange-100 dark:bg-orange-950" />
            {copy.ifApproved}
          </span>
          <div className="flex items-center gap-2 text-xs">
            <Switch id="rm-tentative" checked={tentative} onCheckedChange={setTentative} />
            <Label htmlFor="rm-tentative" className="text-xs font-normal">
              {copy.tentative}
            </Label>
          </div>
        </div>

        {isLoading ? <Skeleton className="m-4 h-56 rounded-lg" /> : null}
        {isError ? (
          <div role="alert" className="flex items-center gap-3 p-4 text-sm">
            {t.flowPortfolio.common.loadFailed}
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              {t.flowPortfolio.common.retry}
            </Button>
          </div>
        ) : null}
        {data ? (
          <div className="overflow-x-auto">
            <div className="min-w-[860px] px-4 pt-2 pb-3.5">
              <div className="grid grid-cols-[200px_minmax(0,1fr)] text-xs font-medium text-muted-foreground">
                <span />
                <div className="grid border-l" style={{ gridTemplateColumns: `repeat(${data.quarters.length}, 1fr)` }}>
                  {data.quarters.map((q) => (
                    <span key={q.key} className="border-r px-2 py-1.5">
                      {q.key.replace('-', ' ')}
                      {q.percent === null ? '' : ` · ${Math.round(q.percent)}%`}
                    </span>
                  ))}
                </div>
              </div>
              {data.items.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{copy.empty}</p> : null}
              {data.items.map((item) => {
                const pos = lanePosition(item.startsOn, item.endsOn, data.from, data.to);
                const label = format(copy.lane, { name: item.name, from: formatDay(item.startsOn, locale), to: formatDay(item.endsOn, locale) });
                return (
                  <div key={`${item.type}:${item.id}`} className="grid h-[30px] grid-cols-[200px_minmax(0,1fr)] items-center">
                    <span className={cn('truncate pr-2 text-xs', item.accessible ? 'text-foreground' : 'text-muted-foreground italic')}>{item.name}</span>
                    <div className="relative h-[30px] border-l">
                      <div title={label} aria-label={label} role="img" className={cn('absolute top-[9px] h-3 rounded', laneStyle(item))} style={{ left: `${pos.left}%`, width: `${pos.width}%` }} />
                    </div>
                  </div>
                );
              })}
              <div className="mt-1.5 grid grid-cols-[200px_minmax(0,1fr)] items-center border-t pt-2">
                <span className="text-xs font-semibold text-foreground/80">{copy.teamBooked}</span>
                <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${data.months.length}, 1fr)` }}>
                  {data.months.map((m) => {
                    const label =
                      m.percent === null
                        ? `${m.key}: ${copy.noCapacity}`
                        : format(copy.loadTitle, { month: m.key, percent: Math.round(m.percent) });
                    return (
                      <div
                        key={m.key}
                        title={label}
                        aria-label={label}
                        className={cn('flex h-[26px] items-center justify-center rounded text-[11px] font-semibold', BAND_CLASS[bandOf(m.bookedHours, m.percent)])}
                      >
                        {m.percent === null ? '–' : `${Math.round(m.percent)}%`}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="mt-0.5 grid grid-cols-[200px_minmax(0,1fr)]">
                <span />
                <div className="grid gap-0.5 text-center text-[10px] text-muted-foreground" style={{ gridTemplateColumns: `repeat(${data.months.length}, 1fr)` }}>
                  {data.months.map((m) => (
                    <span key={m.key}>{new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(`${m.startsOn}T00:00:00Z`))}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
