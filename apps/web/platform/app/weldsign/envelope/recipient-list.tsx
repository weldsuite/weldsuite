/** The recipients of a sent request, each with their status and (for owners) their actions. */

import { toast } from 'sonner';
import type { SignEnvelopeDetail, SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { useResendSignRecipient } from '@/hooks/queries/use-weldsign-queries';
import { lifecycleErrorMessage } from '../lib/errors';
import { RecipientRow } from './recipient-row';

export function RecipientList({
  envelope,
  onCorrect,
}: Readonly<{ envelope: SignEnvelopeDetail; onCorrect: (recipient: SignRecipientDto) => void }>) {
  const { t, format } = useI18n();
  const to = t.weldsign.overview;
  const resend = useResendSignRecipient(envelope.id, (err) =>
    toast.error(lifecycleErrorMessage(err, to.resendFailed, to.notOpen)),
  );

  const onResend = (recipient: SignRecipientDto) =>
    resend.mutate(recipient.id, {
      onSuccess: () => toast.success(format(to.resendDone, { email: recipient.email ?? '' })),
    });

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">{to.recipients}</h2>
      <ol className="divide-y rounded-lg border">
        {envelope.recipientList.map((recipient, i) => (
          <RecipientRow
            key={recipient.id}
            recipient={recipient}
            colorIndex={i}
            showOrder={envelope.signingOrderEnabled && recipient.role === 'signer'}
            canRemind={envelope.canRemind}
            resending={resend.isPending}
            onResend={onResend}
            onCorrect={onCorrect}
          />
        ))}
      </ol>
      {envelope.recipients.signers === 0 && <p className="text-sm text-muted-foreground">{t.weldsign.editor.recipients.empty}</p>}
    </section>
  );
}
