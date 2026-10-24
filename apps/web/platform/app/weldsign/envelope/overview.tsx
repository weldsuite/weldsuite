/**
 * A request after it was sent: who has signed, and the signed PDF once
 * everyone has. The activity timeline, reminders and voiding come in phase 3
 * of docs/plans/weldsign.md.
 */

import { CheckCircle2, Circle, Clock, Download, Eye, Mail, XCircle, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import type { SignEnvelopeDetail, SignRecipientStatus } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useDownloadSignedPdf } from '@/hooks/queries/use-weldsign-queries';
import { recipientColor } from '../lib/recipient-colors';

const STATUS_ICON: Record<SignRecipientStatus, { icon: LucideIcon; className: string }> = {
  pending: { icon: Circle, className: 'text-muted-foreground' },
  sent: { icon: Mail, className: 'text-sky-600' },
  opened: { icon: Eye, className: 'text-amber-600' },
  signed: { icon: CheckCircle2, className: 'text-emerald-600' },
  declined: { icon: XCircle, className: 'text-destructive' },
};

export function EnvelopeOverview({ envelope, onViewDocuments }: Readonly<{ envelope: SignEnvelopeDetail; onViewDocuments: () => void }>) {
  const { t, format, language } = useI18n();
  const to = t.weldsign.overview;
  const download = useDownloadSignedPdf(envelope.id);
  const dateTime = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' });
  const when = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : '');

  const signers = envelope.recipientList.filter((r) => r.role === 'signer');
  const note =
    envelope.status === 'completed'
      ? to.completedNote
      : envelope.status === 'declined'
        ? to.declinedNote
        : envelope.status === 'expired'
          ? to.expiredNote
          : envelope.status === 'voided'
            ? to.voidedNote
            : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <span className="text-base font-medium text-foreground">
            {format(to.progress, { signed: envelope.recipients.signed, total: envelope.recipients.signers })}
          </span>
          {envelope.sentAt && <span>{format(to.sentAt, { date: when(envelope.sentAt) })}</span>}
          {envelope.completedAt ? (
            <span>{format(to.completedAt, { date: when(envelope.completedAt) })}</span>
          ) : (
            envelope.expiresAt && <span>{format(to.expiresAt, { date: when(envelope.expiresAt) })}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onViewDocuments}>
            <Eye />
            {to.viewDocuments}
          </Button>
          {envelope.status === 'completed' && (
            <Button
              size="sm"
              disabled={download.isPending}
              onClick={() => download.mutate(envelope.title, { onError: () => toast.error(to.downloadFailed) })}
            >
              <Download />
              {to.download}
            </Button>
          )}
        </div>
      </div>

      {note && (
        <p
          className={cn(
            'rounded-lg border px-4 py-3 text-sm',
            envelope.status === 'completed' ? 'border-emerald-600/30 bg-emerald-600/5' : 'bg-muted/50',
          )}
        >
          {note}
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">{to.recipients}</h2>
        <ol className="divide-y rounded-lg border">
          {envelope.recipientList.map((r, i) => {
            const status = STATUS_ICON[r.status];
            const Icon = r.role === 'cc' ? Clock : status.icon;
            return (
              <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: recipientColor(i).border }} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.name || r.email}</p>
                  <p className="truncate text-xs text-muted-foreground">{r.email}</p>
                </div>
                {envelope.signingOrderEnabled && r.role === 'signer' && (
                  <span className="text-xs tabular-nums text-muted-foreground">#{r.routingOrder}</span>
                )}
                <span className={cn('flex shrink-0 items-center gap-1.5 text-xs', r.role === 'cc' ? 'text-muted-foreground' : status.className)}>
                  <Icon className="size-4" />
                  {r.role === 'cc'
                    ? to.copy
                    : r.status === 'signed' && r.signedAt
                      ? format(to.signedAt, { date: when(r.signedAt) })
                      : to.statuses[r.status]}
                </span>
              </li>
            );
          })}
        </ol>
        {signers.length === 0 && <p className="text-sm text-muted-foreground">{t.weldsign.editor.recipients.empty}</p>}
      </section>
    </div>
  );
}
