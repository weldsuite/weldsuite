/**
 * Verify a trunk number for outbound caller id: pick call or SMS, get a code
 * from Telnyx, enter it. A verified number may be shown as the caller id.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import type { DeskSipVerificationMethod } from '@weldsuite/core-api-client/schemas/desk-sip-trunks';
import { getTranslations } from '@/lib/i18n';
import {
  sipTrunkErrorCode,
  useConfirmDeskSipVerification,
  useStartDeskSipVerification,
} from '@/hooks/queries/use-desk-sip-trunk-queries';

export interface SipNumberVerificationProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trunkId: string;
  number: { id: string; phoneNumber: string } | null;
}

type VerificationErrors = ReturnType<typeof getTranslations<'deskSipTrunks'>>['verification']['errors'];

/** What to say when sending the code failed. */
function sendErrorText(code: string | null, errors: VerificationErrors): string {
  if (code === 'verification_refused') return errors.refused;
  if (code === 'already_verified') return errors.alreadyVerified;
  return errors.failed;
}

/** What to say when the entered code was not accepted. */
function confirmErrorText(code: string | null, errors: VerificationErrors): string {
  if (code === 'code_expired') return errors.codeExpired;
  if (code === 'already_verified') return errors.alreadyVerified;
  return errors.wrongCode;
}

export function SipNumberVerification({ open, onOpenChange, trunkId, number }: Readonly<SipNumberVerificationProps>) {
  const t = getTranslations('deskSipTrunks').verification;
  const [method, setMethod] = useState<DeskSipVerificationMethod>('call');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const start = useStartDeskSipVerification();
  const confirm = useConfirmDeskSipVerification();

  const close = (next: boolean) => {
    if (!next) {
      setSent(false);
      setCode('');
      setError(null);
    }
    onOpenChange(next);
  };

  const send = async () => {
    if (!number) return;
    setError(null);
    try {
      await start.mutateAsync({ trunkId, numberId: number.id, method });
      setSent(true);
      toast.success(t.sent);
    } catch (err) {
      setError(sendErrorText(sipTrunkErrorCode(err), t.errors));
    }
  };

  const submit = async () => {
    if (!number) return;
    setError(null);
    try {
      await confirm.mutateAsync({ trunkId, numberId: number.id, code: code.trim() });
      toast.success(t.success);
      close(false);
    } catch (err) {
      setError(confirmErrorText(sipTrunkErrorCode(err), t.errors));
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md" data-testid="sip-verification">
        <DialogHeader>
          <DialogTitle>{t.title.replace('{number}', number?.phoneNumber ?? '')}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>

        {sent ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="sip-verification-code">{t.code}</Label>
              <Input
                id="sip-verification-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t.codePlaceholder}
                inputMode="numeric"
                autoComplete="one-time-code"
                className="font-mono"
              />
            </div>
            {error && <InlineError>{error}</InlineError>}
            <DialogFooter className="gap-2 sm:justify-between">
              <Button type="button" variant="ghost" onClick={() => setSent(false)}>
                {t.resend}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={confirm.isPending || code.trim() === ''}>
                {confirm.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {confirm.isPending ? t.confirming : t.confirm}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>{t.method}</Label>
              <RadioGroup value={method} onValueChange={(value) => setMethod(value as DeskSipVerificationMethod)}>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="call" id="sip-verify-call" />
                  <Label htmlFor="sip-verify-call">{t.byCall}</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="sms" id="sip-verify-sms" />
                  <Label htmlFor="sip-verify-sms">{t.bySms}</Label>
                </div>
              </RadioGroup>
            </div>
            {error && <InlineError>{error}</InlineError>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {t.close}
              </Button>
              <Button type="button" onClick={() => void send()} disabled={start.isPending}>
                {start.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {start.isPending ? t.sending : t.send}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
