/**
 * A lifecycle result: per bucket, stacked bars of new, returning and
 * resurrecting people above zero and dormant people below it, with the totals
 * of the range as tiles.
 */

import type { PanelLifecycleResult } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { useI18n } from '@/lib/i18n/provider';
import { formatBucket, formatNumber } from '../../lib/format';
import { CategoryBarChart } from './charts';

const STATUSES = ['new', 'returning', 'resurrecting', 'dormant'] as const;
const COLORS: Record<(typeof STATUSES)[number], string> = {
  new: 'var(--chart-2)',
  returning: 'var(--chart-1)',
  resurrecting: 'var(--chart-4)',
  dormant: 'var(--destructive)',
};

export function LifecycleResultView({ result, compact = false }: Readonly<{ result: PanelLifecycleResult; compact?: boolean }>) {
  const { t, language } = useI18n();
  const tx = t.weldpanel.explore.lifecycle;
  const data = result.buckets.map((b) => ({
    label: formatBucket(b.bucket, result.interval, language),
    bucket: b.bucket,
    new: b.new,
    returning: b.returning,
    resurrecting: b.resurrecting,
    // Drawn below zero: people lost.
    dormant: -b.dormant,
  }));

  return (
    <div className="grid gap-4">
      {!compact && (
        <KpiGrid className="sm:grid-cols-2 lg:grid-cols-4">
          {STATUSES.map((status) => (
            <KpiCard key={status} label={tx.statuses[status]} value={formatNumber(result.totals[status], language)} hint={tx.statusHints[status]} />
          ))}
        </KpiGrid>
      )}
      <CategoryBarChart
        data={data}
        series={STATUSES.map((status) => ({ key: status, label: tx.statuses[status], color: COLORS[status] }))}
        locale={language}
        stacked
        format={(v) => formatNumber(Math.abs(v), language)}
        legend
      />
    </div>
  );
}
