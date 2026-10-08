import { Badge } from '@weldsuite/ui/components/badge';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { PaymentRunDetail } from '@/lib/api/domains/weldbooks-payment-runs';
import { RunMethodBadge, RunStatusBadge } from './run-badges';

function Detail({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{children}</dd>
    </div>
  );
}

/** The facts of a run: how, from where, when, how much, and what is left out. */
export function RunSummaryCard({ run }: Readonly<{ run: PaymentRunDetail }>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const ts = tp.detail.summary;
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const held = Number.parseFloat(run.heldAmount) > 0;
  const withheld = Number.parseFloat(run.withheldAmount) > 0;

  return (
    <Card>
      <CardContent className="pt-6">
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
          <Detail label={ts.status}>
            <RunStatusBadge status={run.status} />
          </Detail>
          <Detail label={ts.method}>
            <span className="flex flex-wrap items-center gap-1">
              <RunMethodBadge method={run.method} />
              {run.method === 'ach' && run.sameDay ? <Badge variant="secondary">{tp.sameDay}</Badge> : null}
            </span>
          </Detail>
          <Detail label={ts.bankAccount}>
            {run.bankAccount ? (
              <>
                {run.bankAccount.name}
                {run.bankAccount.accountNumberLast4 ? (
                  <span className="text-muted-foreground"> ····{run.bankAccount.accountNumberLast4}</span>
                ) : null}
              </>
            ) : (
              '—'
            )}
          </Detail>
          <Detail label={ts.paymentDate}>{formatDate(run.paymentDate)}</Detail>
          <Detail label={withheld ? ts.settles : ts.toPay}>
            <span className="tabular-nums">{formatMoney(run.totalAmount)}</span>
          </Detail>
          {withheld ? (
            <Detail label={ts.withheld}>
              <span className="tabular-nums">-{formatMoney(run.withheldAmount)}</span>
            </Detail>
          ) : null}
          {withheld ? (
            <Detail label={ts.net}>
              <span className="tabular-nums">{formatMoney(run.netAmount)}</span>
            </Detail>
          ) : null}
          {held ? (
            <Detail label={ts.held}>
              <span className="tabular-nums">{formatMoney(run.heldAmount)}</span>
            </Detail>
          ) : null}
          <Detail label={ts.vendors}>{run.paymentCount}</Detail>
          <Detail label={ts.bills}>{run.billCount}</Detail>
          {run.method === 'ach' ? (
            <Detail label={ts.secCode}>{run.secCode ? tp.secCodes[run.secCode] : tp.secCodes.auto}</Detail>
          ) : null}
          {run.notes ? <Detail label={ts.notes}>{run.notes}</Detail> : null}
        </dl>
      </CardContent>
    </Card>
  );
}
