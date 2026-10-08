import { useState } from 'react';
import { CheckCircle2, Info } from 'lucide-react';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Label } from '@weldsuite/ui/components/label';
import { useDebounce } from '@/hooks/use-debounce';
import { useDeMinimisAdvice } from '@/hooks/queries/use-weldbooks-assets-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { fill } from '../text';

interface DeMinimisAdviceProps {
  /** The cost typed on the form, or null while it is blank or unreadable. */
  amount: number | null;
  /** The acquisition date, or blank. */
  date: string;
}

/**
 * US: expense or capitalize. The server decides (Treas. Reg. 1.263(a)-1(f));
 * this asks it once the cost settles and explains the answer in the user's
 * language from the fields it returns.
 */
export function DeMinimisAdvice({ amount, date }: Readonly<DeMinimisAdviceProps>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.assets.fixedAssets.deMinimis;
  const { formatMoney } = useWeldbooksFormat();
  const [hasAfs, setHasAfs] = useState(false);
  const settled = useDebounce(amount, 400);
  const ready = settled !== null && settled > 0;
  const advice = useDeMinimisAdvice(
    { amount: settled ?? 0, hasAfs, ...(/^\d{4}-\d{2}-\d{2}$/.test(date) ? { date } : {}) },
    { enabled: ready },
  );

  return (
    <div className="space-y-3 rounded-md border p-4" data-testid="de-minimis-advice">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium">{td.title}</p>
        <div className="flex items-center gap-2">
          <Checkbox id="de-minimis-afs" checked={hasAfs} onCheckedChange={(checked) => setHasAfs(checked === true)} />
          <Label htmlFor="de-minimis-afs" className="text-xs font-normal text-muted-foreground">
            {td.afs}
          </Label>
        </div>
      </div>

      {!ready ? null : advice.isLoading ? (
        <p className="text-sm text-muted-foreground">{td.checking}</p>
      ) : advice.isError || !advice.data ? (
        <p className="text-sm text-muted-foreground">{td.unavailable}</p>
      ) : advice.data.threshold === null ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {td.noRule}
        </p>
      ) : (
        <div className="flex items-start gap-2 text-sm">
          {advice.data.advice === 'expense' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="space-y-1">
            <p className="font-medium" data-testid="de-minimis-verdict">
              {advice.data.advice === 'expense' ? td.expense : td.capitalize}
            </p>
            <p className="text-muted-foreground">
              {fill(advice.data.advice === 'expense' ? td.expenseBody : td.capitalizeBody, {
                amount: formatMoney(advice.data.amount),
                threshold: formatMoney(advice.data.threshold),
              })}
              {advice.data.advice === 'expense' && advice.data.hasAfs ? ` ${td.expenseAfsBody}` : ''}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
