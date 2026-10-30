/**
 * The last part of a request: the message, reminders and where the signed copy
 * goes (`ReviewSettings`), what is in it (`ReviewSummary`), and Send
 * (`SendButton`), which stays off while something is missing. Sending asks for
 * the expiry date and then emails the first signers (sign-api checks the draft
 * again before anything goes out).
 */

import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import type { SignEnvelopeDetail } from '@weldsuite/app-api-client/schemas/weldsign';
import { useI18n } from '@/lib/i18n/provider';
import { targetOf, useSendSignEnvelope, useUpdateSignEnvelope } from '@/hooks/queries/use-weldsign-queries';
import type { ReadinessProblem } from '../lib/readiness';
import { apiErrorMessage } from '../lib/errors';
import { MessageField, ReminderSettings } from './settings-fields';
import { SignedCopy } from './signed-copy';

const DEFAULT_EXPIRY_DAYS = 30;

/** `yyyy-mm-dd` of the local date `days` from today, for a date input. */
function isoDay(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The message, the reminders and where the signed copy goes. */
export function ReviewSettings({ envelope, editable }: Readonly<{ envelope: SignEnvelopeDetail; editable: boolean }>) {
  const update = useUpdateSignEnvelope(targetOf(envelope));
  return (
    <>
      <MessageField message={envelope.message} disabled={!editable} onSave={(message) => update.mutate({ message })} />
      <ReminderSettings settings={envelope} editable={editable} save={(input) => update.mutate(input)} />
      <SignedCopy envelope={envelope} editable={editable} />
    </>
  );
}

/** What the request holds, as the totals under an invoice. */
export function ReviewSummary({ counts }: Readonly<{ counts: { documents: number; recipients: number; fields: number } }>) {
  const { t } = useI18n();
  const tr = t.weldsign.editor.review;
  const rows = [
    { label: tr.summaryDocuments, value: counts.documents },
    { label: tr.summaryRecipients, value: counts.recipients },
    { label: tr.summaryFields, value: counts.fields },
  ];
  return (
    <dl className="space-y-2 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="text-right font-medium tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface SendButtonProps {
  envelope: SignEnvelopeDetail;
  editable: boolean;
  problems: ReadinessProblem[];
  /** Runs before the send dialog opens, to save what is still unsaved; the dialog stays closed when it rejects. */
  beforeSend?: () => Promise<void>;
}

/** Send, for whoever may send a request that can still be changed, and the dialog that asks for the expiry. */
export function SendButton({ envelope, editable, problems, beforeSend }: Readonly<SendButtonProps>) {
  const { t } = useI18n();
  const tr = t.weldsign.editor.review;
  const send = useSendSignEnvelope(envelope.id);
  const canSend = useCan('sign_envelopes:send');
  const [preparing, setPreparing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [expiresOn, setExpiresOn] = useState(() => isoDay(DEFAULT_EXPIRY_DAYS));

  if (!editable || !canSend) return null;

  const open = async () => {
    setPreparing(true);
    try {
      await beforeSend?.();
      setConfirming(true);
    } catch {
      // The save reported its own failure.
    } finally {
      setPreparing(false);
    }
  };

  return (
    <>
      <Button size="sm" className="h-8" disabled={problems.length > 0 || preparing} onClick={() => void open()}>
        {preparing && <Loader2 className="animate-spin" />}
        {tr.send}
      </Button>

      <Dialog open={confirming} onOpenChange={(next) => !send.isPending && setConfirming(next)}>
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
    </>
  );
}
