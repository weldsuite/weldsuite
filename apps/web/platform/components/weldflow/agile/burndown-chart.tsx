import { useMemo } from 'react';
import { ComparisonChart, type ComparisonPoint } from '@weldsuite/ui/components/comparison-chart';
import type { BurndownPoint } from '@weldsuite/app-api-client/schemas/flow-agile';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { getIntlLocale } from '@/lib/i18n/date-locale';

/**
 * A sprint's burndown: the story points remaining per day against the ideal
 * line. Days still to come have no `remaining`, so the line stops at today.
 * The figures are also there as a table for screen readers.
 */
export function BurndownChart({
  points,
  label,
  className,
}: Readonly<{ points: readonly BurndownPoint[]; label: string; className?: string }>) {
  const { t, plural, language } = useI18n();
  const copy = t.flowAgileSprints.report;
  const locale = getIntlLocale(language);

  const formatter = useMemo(() => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }), [locale]);
  const longFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'long', timeZone: 'UTC' }),
    [locale],
  );
  const day = (value: string, format: Intl.DateTimeFormat) => format.format(new Date(`${value.slice(0, 10)}T00:00:00Z`));

  const data = useMemo<ComparisonPoint[]>(
    () =>
      points.map((point) => ({
        month: point.date,
        value: point.remaining ?? undefined,
        compareMonth: point.date,
        compareValue: point.ideal,
      })),
    [points],
  );

  return (
    <figure className={cn('min-w-0', className)}>
      <ComparisonChart
        points={data}
        variant="card"
        label={copy.remaining}
        compareLabel={copy.ideal}
        formatTick={(value) => day(value, formatter)}
        formatAxisValue={(value) => String(value)}
        formatValue={(value) => plural(Math.round(value * 10) / 10, t.flowAgile.points)}
        formatPeriod={(value) => day(value, longFormatter)}
        className="aspect-auto h-[260px] w-full"
      />
      <figcaption className="sr-only">{label}</figcaption>
      <table className="sr-only">
        <caption>{copy.burndownTable}</caption>
        <thead>
          <tr>
            <th scope="col">{copy.date}</th>
            <th scope="col">{copy.remaining}</th>
            <th scope="col">{copy.ideal}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.date}>
              <th scope="row">{day(point.date, longFormatter)}</th>
              <td>{point.remaining === null ? '' : point.remaining}</td>
              <td>{point.ideal}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
