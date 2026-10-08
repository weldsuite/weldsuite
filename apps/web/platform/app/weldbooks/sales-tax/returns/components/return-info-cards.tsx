import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useI18n } from '@/lib/i18n/provider';
import { useUpdateTaxReturn } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { TaxReturnDetail } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { ReturnStatusBadge } from '../../shared/badges';
import { fill, toCents } from '../../shared/text';

/** When the return was filed and paid, with its confirmation number and the payment entry. */
export function FilingCard({ ret }: Readonly<{ ret: TaxReturnDetail }>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.salesTax.center.returnPage.filing;
  const { formatMoney, formatDate, formatDateTime } = useWeldbooksFormat();
  const payment = ret.summary?.payment;
  const entryId = ret.paymentJournalEntryId ?? payment?.journalEntryId ?? null;

  return (
    <Card data-testid="filing-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{tf.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">{tf.filedOn}</dt>
            <dd className="font-medium">{ret.filedAt ? formatDateTime(ret.filedAt) : tf.notFiledYet}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{tf.confirmation}</dt>
            <dd className="font-medium" data-testid="confirmation-number">
              {ret.confirmationNumber ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{tf.paidOn}</dt>
            <dd className="font-medium">{ret.paidAt ? formatDate(ret.paidAt) : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{tf.amountPaid}</dt>
            <dd className="font-medium tabular-nums">
              {ret.paymentAmount === null ? '—' : formatMoney(ret.paymentAmount)}
              {payment && toCents(payment.difference) !== 0 ? (
                <span className="block text-xs font-normal text-muted-foreground">
                  {tf.difference}: {formatMoney(payment.difference)}
                </span>
              ) : null}
            </dd>
          </div>
        </dl>
        {entryId ? (
          <p className="mt-3 text-sm">
            <Link to="/weldbooks/journal/$id" params={{ id: entryId }} className="text-primary hover:underline">
              {tf.viewEntry}
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface NotesCardProps {
  ret: TaxReturnDetail;
  canEdit: boolean;
}

/** Free notes on the return, for the user's own records. */
export function NotesCard({ ret, canEdit }: Readonly<NotesCardProps>) {
  const { t } = useI18n();
  const tn = t.weldbooksUs.salesTax.center.returnPage.notes;
  const tt = t.weldbooksUs.salesTax.center.returnPage.toasts;
  const update = useUpdateTaxReturn(ret.id);
  const [notes, setNotes] = useState(ret.notes ?? '');

  useEffect(() => {
    setNotes(ret.notes ?? '');
  }, [ret.notes]);

  const dirty = notes !== (ret.notes ?? '');

  const save = async () => {
    try {
      await update.mutateAsync({ notes: notes.trim() === '' ? null : notes });
      toast.success(tt.notesSaved);
    } catch (err) {
      toast.error(tt.notesFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  if (!canEdit && !ret.notes) return null;

  return (
    <Card data-testid="notes-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{tn.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Textarea
          rows={3}
          maxLength={2000}
          value={notes}
          readOnly={!canEdit}
          placeholder={tn.placeholder}
          aria-label={tn.title}
          onChange={(event) => setNotes(event.target.value)}
        />
        {canEdit && dirty ? (
          <Button type="button" size="sm" onClick={() => void save()} disabled={update.isPending}>
            {update.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {update.isPending ? tn.saving : tn.save}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The returns that amend this one. */
export function AmendmentsCard({ ret }: Readonly<{ ret: TaxReturnDetail }>) {
  const { t } = useI18n();
  const ta = t.weldbooksUs.salesTax.center.returnPage.amendments;
  const { formatDate } = useWeldbooksFormat();
  if (ret.amendments.length === 0) return null;

  return (
    <Card data-testid="amendments-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{ta.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-md border text-sm">
          {ret.amendments.map((amendment) => (
            <li key={amendment.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <Link
                to="/weldbooks/sales-tax/returns/$id"
                params={{ id: amendment.id }}
                className="font-medium text-primary hover:underline"
              >
                {ta.item}
              </Link>
              <span className="flex items-center gap-2 text-muted-foreground">
                <ReturnStatusBadge status={amendment.status} />
                {amendment.filedAt ? fill(ta.filedOn, { date: formatDate(amendment.filedAt) }) : ta.notFiled}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
