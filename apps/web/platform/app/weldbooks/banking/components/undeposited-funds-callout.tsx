import { Link } from '@tanstack/react-router';
import { Wallet } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { useUndepositedPayments } from '@/hooks/queries/use-weldbooks-banking-queries';
import { useCurrentJurisdiction } from '@/lib/weldbooks/use-jurisdiction';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { sumUndeposited } from '@/app/weldbooks/deposits/deposit-math';

/**
 * "N payments are waiting in Undeposited Funds" with a link to make the
 * deposit. Renders nothing for entities without Undeposited Funds, and while
 * there is nothing to deposit. Used on the bank accounts page and meant for the
 * WeldBooks dashboard too.
 */
export function UndepositedFundsCallout({ className }: Readonly<{ className?: string }>) {
  const { t } = useI18n();
  const tc = t.weldbooksUs.banking.undepositedCallout;
  const { code } = useCurrentJurisdiction();
  const { can } = usePermissions();
  const { formatMoney } = useWeldbooksFormat();
  const { data } = useUndepositedPayments({ enabled: isUsJurisdictionCode(code) });

  if (!data || data.length === 0) return null;
  const total = sumUndeposited(data);

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
        className,
      )}
      data-testid="undeposited-funds-callout"
    >
      <Wallet className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="flex-1 min-w-[16rem]">
        {(data.length === 1 ? tc.messageOne : tc.messageMany)
          .replace('{count}', String(data.length))
          .replace('{total}', formatMoney(total))}
      </p>
      <div className="flex items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to="/weldbooks/deposits">{tc.viewDeposits}</Link>
        </Button>
        {can('banking:create') ? (
          <Button asChild size="sm">
            <Link to="/weldbooks/deposits/new">{tc.makeDeposit}</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
