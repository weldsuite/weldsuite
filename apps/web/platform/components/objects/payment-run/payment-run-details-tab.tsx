/**
 * Details tab of the payment run panel: the banners of an open run, what to do
 * next, the ACH file of an approved ACH run, and the facts of the run (how,
 * from where, when, how much, and what is left out).
 */

import type { ComponentProps } from 'react';
import {
  Banknote,
  Calendar,
  CircleDot,
  Coins,
  FileText,
  Hash,
  Landmark,
  Percent,
  Receipt,
  ShieldAlert,
  StickyNote,
  Users,
  Wallet,
} from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { PropertyRow } from '@/components/objects/_shared/property-row';
import { NachaPanel } from '@/app/weldbooks/payment-runs/components/nacha-panel';
import { RunStatusChip } from '@/app/weldbooks/payment-runs/components/run-badges';
import type { PaymentRunDetail } from '@/lib/api/domains/weldbooks-payment-runs';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { RunAlerts, RunNextStep, type RunActionBusy, type RunActionHandlers } from './run-actions';

const EMPTY = '—';

function MoneyRow({
  icon,
  label,
  value,
}: Readonly<{ icon: ComponentProps<typeof PropertyRow>['icon']; label: string; value: string }>) {
  return (
    <PropertyRow
      icon={icon}
      label={label}
      value={value}
      readOnly
      renderValue={(text) => <span className="tabular-nums">{text}</span>}
    />
  );
}

/** The facts of a run: how, from where, when, how much, and what is left out. */
function RunProperties({ run }: Readonly<{ run: PaymentRunDetail }>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const ts = tp.detail.summary;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const held = Number.parseFloat(run.heldAmount) > 0;
  const withheld = Number.parseFloat(run.withheldAmount) > 0;
  const MethodIcon = run.method === 'check' ? FileText : Banknote;
  const bankAccount = run.bankAccount
    ? `${run.bankAccount.name}${run.bankAccount.accountNumberLast4 ? ` ····${run.bankAccount.accountNumberLast4}` : ''}`
    : null;

  return (
    <div className="space-y-1">
      <MoneyRow icon={Wallet} label={withheld ? ts.settles : ts.toPay} value={formatMoney(run.totalAmount)} />
      <PropertyRow icon={Users} label={ts.vendors} value={String(run.paymentCount)} readOnly />
      <PropertyRow icon={Receipt} label={ts.bills} value={String(run.billCount)} readOnly />
      <PropertyRow
        icon={CircleDot}
        label={ts.status}
        value={tp.statuses[run.status]}
        readOnly
        renderValue={() => <RunStatusChip status={run.status} />}
      />
      <PropertyRow
        icon={MethodIcon}
        label={ts.method}
        value={tp.methods[run.method]}
        readOnly
        renderValue={(value) => (
          <span className="flex flex-wrap items-center gap-1">
            <Badge variant="outline">{value}</Badge>
            {run.method === 'ach' && run.sameDay ? <Badge variant="secondary">{tp.sameDay}</Badge> : null}
          </span>
        )}
      />
      <PropertyRow icon={Landmark} label={ts.bankAccount} value={bankAccount} placeholder={EMPTY} readOnly />
      <PropertyRow icon={Calendar} label={ts.paymentDate} value={formatDate(run.paymentDate)} placeholder={EMPTY} readOnly />
      {withheld ? (
        <>
          <MoneyRow icon={Percent} label={ts.withheld} value={`-${formatMoney(run.withheldAmount)}`} />
          <MoneyRow icon={Coins} label={ts.net} value={formatMoney(run.netAmount)} />
        </>
      ) : null}
      {held ? <MoneyRow icon={ShieldAlert} label={ts.held} value={formatMoney(run.heldAmount)} /> : null}
      {run.method === 'ach' ? (
        <PropertyRow
          icon={Hash}
          label={ts.secCode}
          value={run.secCode ? tp.secCodes[run.secCode] : tp.secCodes.auto}
          readOnly
        />
      ) : null}
      {run.notes ? (
        <PropertyRow
          icon={StickyNote}
          label={ts.notes}
          value={run.notes}
          readOnly
          renderValue={(value) => (
            <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{value}</span>
          )}
        />
      ) : null}
    </div>
  );
}

export function PaymentRunDetailsTab({
  run,
  userId,
  canCreate,
  canManage,
  busy,
  on,
}: Readonly<{
  run: PaymentRunDetail;
  userId: string | null | undefined;
  canCreate: boolean;
  canManage: boolean;
  busy: RunActionBusy;
  on: RunActionHandlers;
}>) {
  return (
    <div className="@container space-y-4 p-4">
      <RunAlerts run={run} />
      <RunNextStep run={run} userId={userId} canCreate={canCreate} canManage={canManage} busy={busy} on={on} />
      <NachaPanel run={run} canManage={canManage} />
      <RunProperties run={run} />
    </div>
  );
}
