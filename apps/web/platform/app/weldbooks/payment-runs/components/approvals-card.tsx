import { CheckCircle2, Circle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { PaymentRunDetail } from '@/lib/api/domains/weldbooks-payment-runs';

interface ApprovalsCardProps {
  run: PaymentRunDetail;
  nameOf: (userId: string | null | undefined) => string;
}

/** Who made the run and who approved it, with a slot for every approval still missing. */
export function ApprovalsCard({ run, nameOf }: Readonly<ApprovalsCardProps>) {
  const { t } = useI18n();
  const ta = t.weldbooksUs.payments.detail.approvals;
  const { formatDateTime } = useWeldbooksFormat();
  const waiting = Math.max(0, run.requiredApprovals - run.approvals.length);
  const showSlots = run.status === 'draft' || run.status === 'pending_approval';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{ta.title}</CardTitle>
        <CardDescription>
          {run.requiredApprovals === 2 ? ta.twoRequired : ta.oneRequired}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3 text-sm">
          <li className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div>
              <p className="font-medium">{ta.created.replace('{name}', nameOf(run.createdBy))}</p>
              <p className="text-xs text-muted-foreground">{formatDateTime(run.createdAt)}</p>
            </div>
          </li>
          {run.approvals.map((approval, index) => (
            <li key={`${approval.userId}-${approval.at}`} className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <div>
                <p className="font-medium">
                  {ta.approvedBy.replace('{name}', nameOf(approval.userId)).replace('{n}', String(index + 1))}
                </p>
                <p className="text-xs text-muted-foreground">{formatDateTime(approval.at)}</p>
              </div>
            </li>
          ))}
          {showSlots
            ? Array.from({ length: waiting }, (_, index) => (
                <li key={`waiting-${index}`} className="flex items-start gap-3 text-muted-foreground">
                  <Circle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <p>
                    {ta.waiting.replace('{n}', String(run.approvals.length + index + 1))}
                    {run.status === 'draft' ? ` ${ta.afterSubmit}` : ''}
                  </p>
                </li>
              ))
            : null}
        </ol>
      </CardContent>
    </Card>
  );
}
