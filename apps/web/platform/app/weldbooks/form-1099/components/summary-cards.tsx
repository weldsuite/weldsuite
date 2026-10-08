import { AlertTriangle, Info } from 'lucide-react';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import type { Form1099Summary } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { reviewFilterCounts } from '../form-1099-model';

interface SummaryCardsProps {
  summary: Form1099Summary;
}

function Stat({
  label,
  value,
  hint,
  tone = 'default',
  testId,
}: Readonly<{ label: string; value: string; hint?: string; tone?: 'default' | 'warning'; testId: string }>) {
  return (
    <Card>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p
          className={cn('text-2xl font-semibold tabular-nums', tone === 'warning' && 'text-amber-600 dark:text-amber-400')}
          data-testid={testId}
        >
          {value}
        </p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

/** The year at a glance: who goes on a form, who needs a fix, what the forms add up to, and the thresholds that apply. */
export function SummaryCards({ summary }: Readonly<SummaryCardsProps>) {
  const { t } = useI18n();
  const ts = t.weldbooksUs.form1099.summary;
  const { formatMoney } = useWeldbooksFormat();
  const counts = reviewFilterCounts(summary.vendors);
  const { thresholds } = summary;

  const money = (value: number | null) => (value === null ? ts.anyAmount : formatMoney(value));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          testId="stat-to-file"
          label={ts.toFile}
          value={String(counts.to_file)}
          hint={ts.formTotals.replace('{nec}', formatMoney(summary.totals.nec)).replace('{misc}', formatMoney(summary.totals.misc))}
        />
        <Stat
          testId="stat-attention"
          label={ts.needsAttention}
          value={String(counts.attention)}
          tone={counts.attention > 0 ? 'warning' : 'default'}
          hint={ts.needsAttentionHint}
        />
        <Stat testId="stat-below" label={ts.belowThreshold} value={String(counts.below_threshold)} hint={ts.belowThresholdHint} />
        <Stat testId="stat-corporations" label={ts.corporations} value={String(counts.corporation)} hint={ts.corporationsHint} />
        <Stat testId="stat-withheld" label={ts.backupWithheld} value={formatMoney(summary.totals.withheld)} hint={ts.backupWithheldHint} />
      </div>

      <p className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="threshold-note">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          {ts.thresholds
            .replace('{year}', String(summary.taxYear))
            .replace('{general}', money(thresholds.general))
            .replace('{royalty}', money(thresholds.royalty))
            .replace('{fixed}', money(thresholds.fixed600))}
        </span>
      </p>
      {thresholds.published ? null : (
        <p className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400" role="note">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{ts.unpublished.replace('{year}', String(summary.taxYear))}</span>
        </p>
      )}
    </div>
  );
}
