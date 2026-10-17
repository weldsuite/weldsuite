/**
 * The approvals and history tabs of the payment run panel: who made the run
 * and who approved it (with a slot for every approval still missing), and what
 * happened to the run, oldest first.
 */

import { CheckCircle2, Circle } from 'lucide-react';
import { AuditIllustration, TabEmptyState } from '@/components/objects/_shared/tab-empty-state';
import type { PaymentRunDetail, RunHistoryEntry } from '@/lib/api/domains/weldbooks-payment-runs';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

type NameOf = (userId: string | null | undefined) => string;

/** Who made the run and who approved it, with a slot for every approval still missing. */
export function PaymentRunApprovalsTab({ run, nameOf }: Readonly<{ run: PaymentRunDetail; nameOf: NameOf }>) {
  const { t } = useI18n();
  const ta = t.weldbooksUs.payments.detail.approvals;
  const { formatDateTime } = useWeldbooksFormat();
  const waiting = Math.max(0, run.requiredApprovals - run.approvals.length);
  const showSlots = run.status === 'draft' || run.status === 'pending_approval';

  return (
    <div className="space-y-4 p-4">
      <p className="text-sm text-muted-foreground">
        {run.requiredApprovals === 2 ? ta.twoRequired : ta.oneRequired}
      </p>
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
    </div>
  );
}

/** The reason an entry carries, when it has one (a rejection, a released hold). */
function reasonOf(entry: Pick<RunHistoryEntry, 'changes'>): string | null {
  const reason = entry.changes?.reason?.new;
  return typeof reason === 'string' && reason.trim() ? reason : null;
}

/** What happened to the run, oldest first. */
export function PaymentRunHistoryTab({
  history,
  nameOf,
}: Readonly<{ history: readonly RunHistoryEntry[]; nameOf: NameOf }>) {
  const { t } = useI18n();
  const th = t.weldbooksUs.payments.detail.history;
  const labels: Readonly<Record<string, string>> = th.actions;
  const { formatDateTime } = useWeldbooksFormat();

  if (history.length === 0) {
    return <TabEmptyState bare illustration={<AuditIllustration />} title={th.empty} description="" />;
  }

  return (
    <ol className="space-y-3 p-4 text-sm">
      {history.map((entry, index) => {
        const reason = reasonOf(entry);
        return (
          <li key={`${entry.at}-${entry.action}-${index}`} className="border-l-2 pl-3">
            <p className="font-medium">{labels[entry.action] ?? entry.action.replaceAll('_', ' ')}</p>
            <p className="text-xs text-muted-foreground">
              {nameOf(entry.userId)} · {formatDateTime(entry.at)}
            </p>
            {reason ? <p className="mt-0.5 text-muted-foreground">{reason}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
