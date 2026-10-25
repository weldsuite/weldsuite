/**
 * A request after it was sent: who has signed, the signed PDF once everyone
 * has, and what its owner can still do: remind, resend a link, correct an
 * email, void it, and read its activity. The caller's own "Sign now" is here
 * too, for a member who is also a signer.
 */

import { useState } from 'react';
import type { SignEnvelopeDetail, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useDateTime } from '../lib/use-date-time';
import { ActivityTimeline } from './activity';
import { FilingNote } from './filing-note';
import { CorrectRecipientDialog } from './correct-recipient-dialog';
import { OverviewActions } from './overview-actions';
import { RecipientList } from './recipient-list';
import { SourceLine } from './source-line';
import { VoidDialog } from './void-dialog';

export function EnvelopeOverview({ envelope, onViewDocuments }: Readonly<{ envelope: SignEnvelopeDetail; onViewDocuments: () => void }>) {
  const { t, format } = useI18n();
  const to = t.weldsign.overview;
  const when = useDateTime();
  const [correcting, setCorrecting] = useState<SignRecipientDto | null>(null);
  const [voiding, setVoiding] = useState(false);

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
          <SourceLine source={envelope.source} />
        </div>
        <OverviewActions envelope={envelope} onViewDocuments={onViewDocuments} onVoid={() => setVoiding(true)} />
      </div>

      <StatusNote envelope={envelope} />
      <FilingNote envelope={envelope} />
      <RecipientList envelope={envelope} onCorrect={setCorrecting} />
      <ActivityTimeline envelopeId={envelope.id} enabled={envelope.isOwner} />

      <CorrectRecipientDialog envelopeId={envelope.id} recipient={correcting} onClose={() => setCorrecting(null)} />
      <VoidDialog envelopeId={envelope.id} title={envelope.title} open={voiding} onClose={() => setVoiding(false)} />
    </div>
  );
}

/** One line about how the request ended; a voided one adds when and why. */
function StatusNote({ envelope }: Readonly<{ envelope: SignEnvelopeDetail }>) {
  const { t, format } = useI18n();
  const to = t.weldsign.overview;
  const when = useDateTime();

  const notes: Partial<Record<string, string>> = {
    completed: to.completedNote,
    declined: to.declinedNote,
    expired: to.expiredNote,
    voided: to.voidedNote,
  };
  const note = notes[envelope.status];
  if (!note) return null;

  const voided = envelope.status === 'voided';
  const details = [
    voided && envelope.voidedAt ? format(to.voidedAt, { date: when(envelope.voidedAt) }) : null,
    voided && envelope.voidedReason ? format(to.voidedReason, { reason: envelope.voidedReason }) : null,
  ].filter((line): line is string => line !== null);

  return (
    <div
      className={cn(
        'rounded-lg border px-4 py-3 text-sm',
        envelope.status === 'completed' ? 'border-emerald-600/30 bg-emerald-600/5' : 'bg-muted/50',
      )}
    >
      <p>{note}</p>
      {details.map((line) => (
        <p key={line} className="break-words text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
  );
}
