import { Pencil, Trash2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import type { JurisdictionRate } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { formatRatePercent, periodOf, type RatePeriod } from '../setup/format';
import { useSetupTexts } from '../setup/setup-texts';

const PERIOD_VARIANT: Record<RatePeriod, 'success' | 'warning' | 'outline'> = {
  inForce: 'success',
  upcoming: 'warning',
  ended: 'outline',
};

export interface RateHistoryProps {
  rates: readonly JurisdictionRate[];
  canUpdate: boolean;
  canDelete: boolean;
  onEdit: (rate: JurisdictionRate) => void;
  onDelete: (rate: JurisdictionRate) => void;
}

/** The dated rates of one jurisdiction, newest first, with where each one stands today. */
export function RateHistory({ rates, canUpdate, canDelete, onEdit, onDelete }: Readonly<RateHistoryProps>) {
  const { t } = useSetupTexts();
  const tr = t.rates;
  const { formatDate, today } = useWeldbooksFormat();
  const day = today();
  const sorted = [...rates].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));

  if (sorted.length === 0) return <p className="px-4 py-3 text-sm text-muted-foreground">{tr.empty}</p>;

  const periodText: Record<RatePeriod, string> = { inForce: tr.inForce, upcoming: tr.upcoming, ended: tr.ended };

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{tr.columns.rate}</TableHead>
          <TableHead>{tr.columns.from}</TableHead>
          <TableHead>{tr.columns.to}</TableHead>
          <TableHead>{tr.columns.status}</TableHead>
          <TableHead className="w-24" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((rate) => {
          const period = periodOf(rate, day);
          return (
            <TableRow key={rate.id}>
              <TableCell className="font-medium tabular-nums">{formatRatePercent(rate.rate)}</TableCell>
              <TableCell className="whitespace-nowrap">{formatDate(rate.effectiveFrom)}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">
                {rate.effectiveTo ? formatDate(rate.effectiveTo) : tr.noEnd}
              </TableCell>
              <TableCell>
                <Badge variant={PERIOD_VARIANT[period]}>{periodText[period]}</Badge>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  {canUpdate ? (
                    <Button type="button" variant="ghost" size="icon" aria-label={t.common.edit} onClick={() => onEdit(rate)}>
                      <Pencil className="h-4 w-4" aria-hidden />
                    </Button>
                  ) : null}
                  {canDelete ? (
                    <Button type="button" variant="ghost" size="icon" aria-label={t.common.delete} onClick={() => onDelete(rate)}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </Button>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
