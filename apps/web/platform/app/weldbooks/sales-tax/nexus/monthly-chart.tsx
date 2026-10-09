import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { NexusMonth } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { cn } from '@/lib/utils';

/** The bar height of each month, as a share of the largest absolute amount (0 to 100). */
export function barHeights(months: readonly Pick<NexusMonth, 'sales'>[]): number[] {
  const max = months.reduce((largest, month) => Math.max(largest, Math.abs(month.sales)), 0);
  if (max === 0) return months.map(() => 0);
  return months.map((month) => Math.round((Math.abs(month.sales) / max) * 1000) / 10);
}

/** "Oct" for `2026-10`, in the locale of the books. */
function shortMonth(month: string, locale: string | undefined): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(year, number - 1, 1)));
}

/** Sales per month as bars: a month with more credits than sales is drawn in red. */
export function MonthlyChart({ months }: Readonly<{ months: readonly NexusMonth[] }>) {
  const { t } = useI18n();
  const tn = t.weldbooksUs.salesTax.center.nexus.detail;
  const { formatMoney, dateLocale } = useWeldbooksFormat();
  const heights = barHeights(months);

  return (
    <div className="overflow-x-auto" data-testid="monthly-chart">
      <div role="img" aria-label={tn.monthlyChartLabel} className="flex h-44 min-w-max items-end gap-1.5 border-b px-1 pt-2">
        {months.map((month, index) => (
          <div key={month.month} className="flex h-full w-9 flex-col items-center justify-end gap-1">
            <div
              className={cn('w-full rounded-t-sm', month.sales < 0 ? 'bg-destructive/70' : 'bg-primary')}
              style={{ height: `${heights[index]}%`, minHeight: month.sales === 0 ? 0 : 2 }}
              title={`${month.month}: ${formatMoney(month.sales)}`}
            />
          </div>
        ))}
      </div>
      <div className="flex min-w-max gap-1.5 px-1 pt-1" aria-hidden="true">
        {months.map((month) => (
          <span key={month.month} className="w-9 text-center text-[10px] text-muted-foreground">
            {shortMonth(month.month, dateLocale)}
          </span>
        ))}
      </div>
    </div>
  );
}
