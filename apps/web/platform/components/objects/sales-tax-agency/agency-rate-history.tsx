import { Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import type { JurisdictionRate } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { formatRatePercent, periodOf, type RatePeriod } from '@/app/weldbooks/sales-tax/setup/format';
import { useSetupTexts } from '@/app/weldbooks/sales-tax/setup/setup-texts';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

const PERIOD_VARIANT: Record<RatePeriod, 'success' | 'warning' | 'outline'> = {
  inForce: 'success',
  upcoming: 'warning',
  ended: 'outline',
};

export interface AgencyRateHistoryProps {
  rates: readonly JurisdictionRate[];
  canUpdate: boolean;
  canDelete: boolean;
  onEdit: (rate: JurisdictionRate) => void;
  onDelete: (rate: JurisdictionRate) => void;
}

/** The dated rates of one jurisdiction, newest first, with where each one stands today. Sits under the jurisdiction's row. */
export function AgencyRateHistory({ rates, canUpdate, canDelete, onEdit, onDelete }: Readonly<AgencyRateHistoryProps>) {
  const { t } = useSetupTexts();
  const tr = t.rates;
  const { formatDate, today } = useWeldbooksFormat();
  const day = today();
  const sorted = [...rates].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));

  if (sorted.length === 0) {
    return <p className="border-b border-gray-200/70 bg-muted/30 px-4 py-3 text-sm text-muted-foreground dark:border-border">{tr.empty}</p>;
  }

  const periodText: Record<RatePeriod, string> = { inForce: tr.inForce, upcoming: tr.upcoming, ended: tr.ended };

  return (
    <div className="border-b border-gray-200/70 bg-muted/30 dark:border-border">
      {sorted.map((rate) => {
        const period = periodOf(rate, day);
        return (
          <div key={rate.id} className="flex items-center gap-3 py-2 pl-11 pr-4 text-sm">
            <span className="w-[64px] flex-shrink-0 font-medium tabular-nums">{formatRatePercent(rate.rate)}</span>
            <span className="min-w-0 flex-1 tabular-nums">
              {formatDate(rate.effectiveFrom)} –{' '}
              {rate.effectiveTo ? formatDate(rate.effectiveTo) : <span className="text-muted-foreground">{tr.noEnd}</span>}
            </span>
            <Badge variant={PERIOD_VARIANT[period]} className="flex-shrink-0">
              {periodText[period]}
            </Badge>
            <div className="flex flex-shrink-0 gap-0.5">
              {canUpdate ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={t.common.edit}
                  onClick={() => onEdit(rate)}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                </Button>
              ) : null}
              {canDelete ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={t.common.delete}
                  onClick={() => onDelete(rate)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
