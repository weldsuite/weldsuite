import { CreditCard, Terminal } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { fill } from '@/lib/i18n';
import { formatDay } from '@/lib/billing-format';
import { mollieBillingCopy } from '@/lib/mollie-billing-copy';
import { BILLING_CLI_PREFIX, billingCliCommands, mandateSummary, mollieAccountSummary } from '@/lib/mollie-billing';
import type { MollieBillingAccount, WorkspaceBilling } from '@/lib/billing-types';
import { Notice } from './subscription-card';

/**
 * The Mollie side of a paying workspace on a Kubernetes edition (master
 * `billing_accounts`, ADR BILL-014). Read-only: changes run from the
 * `weldsuite admin billing` CLI, which the card lists.
 */
export function MollieBillingCard({
  workspaceId,
  account,
  billing,
}: Readonly<{ workspaceId: string; account: MollieBillingAccount; billing: WorkspaceBilling }>) {
  const c = mollieBillingCopy();
  const summary = mollieAccountSummary(c, account, billing.subscriptionCycle);

  const rows: Array<[string, React.ReactNode]> = [
    [c.rows.customer, <span key="customer" className="font-mono text-xs">{account.customerId ?? '—'}</span>],
    [
      c.rows.paymentMethod,
      <span key="mandate" className="inline-flex flex-col items-end">
        <span>{mandateSummary(c, account)}</span>
        {account.mandateId && <span className="font-mono text-[11px] text-muted-foreground">{account.mandateId}</span>}
      </span>,
    ],
    [c.rows.seatPrice, summary.seatPrice],
    [c.rows.nextCharge, summary.nextCharge],
  ];
  if (summary.billingDay) rows.push([c.rows.billingDay, summary.billingDay]);
  const pastDue = summary.pastDue;

  return (
    <Card className={pastDue ? 'border-destructive/40 py-4' : 'py-4'}>
      <CardContent className="space-y-4 px-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-medium">{c.title}</h2>
            {pastDue && <Badge variant="destructive">{c.pastDueBadge}</Badge>}
          </div>
        </div>

        {pastDue && (
          <Notice tone="destructive">
            <div className="space-y-0.5">
              <div className="font-medium">{pastDue.since}</div>
              <div>{pastDue.charge}</div>
              {pastDue.failure && <div>{pastDue.failure}</div>}
              {pastDue.reminded && <div className="text-xs opacity-80">{pastDue.reminded}</div>}
            </div>
          </Notice>
        )}

        <DetailRows rows={rows} />

        {summary.scheduled.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
              {fill(c.scheduled.title, { date: formatDay(billing.currentPeriodEnd) })}
            </h3>
            <DetailRows rows={summary.scheduled} />
          </div>
        )}

        <div className="space-y-2 rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Terminal className="h-3.5 w-3.5 shrink-0" />
            <span>{c.cli.intro}</span>
          </div>
          <code className="block break-all font-mono text-[11px] text-foreground">{BILLING_CLI_PREFIX} …</code>
          <ul className="space-y-1">
            {billingCliCommands(workspaceId).map(({ key, args }) => (
              <li key={key}>
                <code className="break-all font-mono text-[11px] text-foreground">{args}</code>
                <span> · {c.cli[key]}</span>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}


function DetailRows({ rows }: Readonly<{ rows: Array<[string, React.ReactNode]> }>) {
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 border-b border-border/50 pb-1.5">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
