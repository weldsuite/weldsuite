import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { differenceIsZero, type StatementBalances } from '../reconciliation-math';

interface StatementSummaryProps {
  balances: StatementBalances;
  accountKind: 'bank' | 'credit_card';
  formatAmount: (amount: number) => string;
}

function Figure({
  label,
  value,
  emphasis,
  testId,
}: Readonly<{ label: string; value: string; emphasis?: 'ok' | 'bad'; testId?: string }>) {
  return (
    <div className="min-w-[8.5rem] space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'text-sm font-semibold tabular-nums',
          emphasis === 'ok' && 'text-emerald-600 dark:text-emerald-400',
          emphasis === 'bad' && 'text-destructive',
        )}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}

/** Beginning balance, what is ticked, the cleared balance and the difference to the statement. */
export function StatementSummary({ balances, accountKind, formatAmount }: Readonly<StatementSummaryProps>) {
  const { t } = useI18n();
  const tw = t.weldbooksUs.banking.worksheet;
  const card = accountKind === 'credit_card';
  const zero = differenceIsZero(balances);

  return (
    <dl className="flex flex-wrap items-end gap-x-6 gap-y-2" data-testid="statement-summary">
      <Figure label={card ? tw.beginningBalanceOwed : tw.beginningBalance} value={formatAmount(balances.beginningBalance)} testId="summary-beginning" />
      <Figure
        label={(card ? tw.clearedInflowsCard : tw.clearedInflows).replace('{count}', String(balances.clearedInflows.count))}
        value={formatAmount(balances.clearedInflows.total)}
        testId="summary-inflows"
      />
      <Figure
        label={(card ? tw.clearedOutflowsCard : tw.clearedOutflows).replace('{count}', String(balances.clearedOutflows.count))}
        value={formatAmount(balances.clearedOutflows.total)}
        testId="summary-outflows"
      />
      <Figure label={card ? tw.clearedBalanceOwed : tw.clearedBalance} value={formatAmount(balances.clearedBalance)} testId="summary-cleared" />
      <Figure
        label={card ? tw.statementBalanceOwed : tw.statementBalance}
        value={formatAmount(balances.statementEndingBalance)}
        testId="summary-ending"
      />
      <Figure label={tw.difference} value={formatAmount(balances.difference)} emphasis={zero ? 'ok' : 'bad'} testId="summary-difference" />
    </dl>
  );
}
