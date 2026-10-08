/** The signed-in employee's leave balances as tiles, shared by the Overview and Leave tabs. */

import { useTranslations } from '@weldsuite/i18n/client';
import type { HrLeaveBalance } from '@weldsuite/app-api-client/domains/weldhr';
import { EmptyText } from '../../components/page-kit';
import { ColorDot } from './shared';

export function LeaveBalanceTiles({ balances }: Readonly<{ balances: HrLeaveBalance[] }>) {
  const t = useTranslations();

  if (balances.length === 0) return <EmptyText>{t('weldhr.me.leave.balances.empty')}</EmptyText>;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {balances.map((balance) => (
        <div key={balance.leaveTypeId} className="rounded-lg border p-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ColorDot color={balance.color} />
            <span className="truncate">{balance.name}</span>
          </div>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {balance.remaining ?? t('weldhr.me.leave.balances.unlimited')}
          </p>
          <p className="text-xs text-muted-foreground">
            {balance.allowance === null
              ? t('weldhr.me.leave.balances.used', { used: balance.used })
              : t('weldhr.me.leave.balances.usedOf', { used: balance.used, allowance: balance.allowance })}
            {balance.pending > 0 && ` · ${t('weldhr.me.leave.balances.pending', { pending: balance.pending })}`}
          </p>
        </div>
      ))}
    </div>
  );
}
