import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import type { NexusRow } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { fill } from '../shared/text';
import { NEXUS_WATCH_PERCENT, barTone, barWidth, formatPercent, type BarTone } from './nexus-model';

const TONE_CLASS: Record<BarTone, string> = {
  neutral: 'bg-primary',
  watch: 'bg-amber-500',
  exceeded: 'bg-destructive',
  registered: 'bg-emerald-500',
};

interface NexusProgressBarProps {
  row: Pick<NexusRow, 'percentOfThreshold' | 'registered'>;
  className?: string;
}

/** Progress toward a state's threshold: amber from 80%, red at 100%, green when registered. */
export function NexusProgressBar({ row, className }: Readonly<NexusProgressBarProps>) {
  const { t } = useI18n();
  const tn = t.weldbooksUs.salesTax.center.nexus;
  const tone = barTone(row);
  const width = barWidth(row.percentOfThreshold);

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(width)}
        aria-label={fill(tn.percentOfThreshold, { percent: formatPercent(row.percentOfThreshold) })}
        data-tone={tone}
        className="relative h-2 w-28 shrink-0 overflow-hidden rounded-full bg-muted sm:w-36"
      >
        <div className={cn('h-full rounded-full transition-all', TONE_CLASS[tone])} style={{ width: `${width}%` }} />
        {/* The 80% mark: where the warning starts. */}
        <span
          className="absolute top-0 h-full w-px bg-foreground/30"
          style={{ left: `${NEXUS_WATCH_PERCENT}%` }}
          aria-hidden="true"
        />
      </div>
      <span className="text-xs font-medium tabular-nums">{formatPercent(row.percentOfThreshold)}%</span>
    </div>
  );
}
