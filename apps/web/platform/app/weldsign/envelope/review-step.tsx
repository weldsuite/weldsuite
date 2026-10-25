/**
 * Step 4: the message, reminders, where the signed copy goes, what is still
 * missing, and Send. Sending asks for the expiry date and then emails the
 * first signers (sign-api checks the draft again before anything goes out).
 */

import { useState } from 'react';
import { Send } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import type { SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { targetOf, useSendSignEnvelope, useUpdateSignEnvelope } from '@/hooks/queries/use-weldsign-queries';
import { readinessProblems } from '../lib/readiness';
import { apiErrorMessage } from '../lib/errors';
import { MessageField, ReadinessChecklist, ReminderSettings, SummaryStats } from './settings-fields';
import { SignedCopy } from './signed-copy';

const DEFAULT_EXPIRY_DAYS = 30;

/** `yyyy-mm-dd` of the local date `days` from today, for a date input. */
function isoDay(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ReviewStep({ envelope, editable }: Readonly<{ envelope: SignEnvelopeDetail; editable: boolean }>) {
  const { t } = useI18n();
  const tr = t.weldsign.editor.review;
  const update = useUpdateSignEnvelope(targetOf(envelope));
  const send = useSendSignEnvelope(envelope.id);
  const canSend = useCan('sign_envelopes:send');
  const [confirming, setConfirming] = useState(false);
  const [expiresOn, setExpiresOn] = useState(() => isoDay(DEFAULT_EXPIRY_DAYS));

  const problems = readinessProblems(envelope);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <div>
        <h2 className="text-lg font-semibold">{tr.title}</h2>
        <p className="text-sm text-muted-foreground">{tr.description}</p>
      </div>

      <MessageField message={envelope.message} disabled={!editable} onSave={(message) => update.mutate({ message })} />

      <ReminderSettings settings={envelope} editable={editable} save={(input) => update.mutate(input)} />

      <SignedCopy envelope={envelope} editable={editable} />

      <SummaryStats
        title={tr.summary}
        stats={[
          { label: tr.summaryDocuments, value: envelope.documents.length },
          { label: tr.summaryRecipients, value: envelope.recipientList.length },
          { label: tr.summaryFields, value: envelope.fields.length },
        ]}
      />

      <ReadinessChecklist
        problems={problems}
        heading={tr.problems}
        messages={{
          ready: tr.ready,
          noDocuments: tr.noDocuments,
          noSigners: tr.noSigners,
          signerWithoutSignature: tr.signerWithoutSignature,
        }}
      />

      {editable && canSend && (
        <div className="flex justify-end">
          <Button disabled={problems.length > 0} onClick={() => setConfirming(true)}>
            <Send />
            {tr.send}
          </Button>
        </div>
      )}

      <Dialog open={confirming} onOpenChange={(open) => !send.isPending && setConfirming(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tr.sendTitle}</DialogTitle>
            <DialogDescription>{tr.sendDescription}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sign-expires">{tr.expiresOn}</Label>
            <Input
              id="sign-expires"
              type="date"
              min={isoDay(1)}
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={send.isPending} onClick={() => setConfirming(false)}>
              {t.common.actions.cancel}
            </Button>
            <Button
              disabled={send.isPending || !expiresOn}
              onClick={() =>
                send.mutate(
                  // The end of the chosen day, in the sender's time zone.
                  { expiresAt: new Date(`${expiresOn}T23:59:59`).toISOString() },
                  {
                    onSuccess: () => {
                      setConfirming(false);
                      toast.success(tr.sent);
                    },
                    onError: (err) => toast.error(`${tr.sendFailed}: ${apiErrorMessage(err)}`),
                  },
                )
              }
            >
              <Send />
              {send.isPending ? tr.sending : tr.sendConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
