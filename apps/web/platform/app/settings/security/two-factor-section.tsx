
import { useState } from 'react';
import { useUser, useReverification } from '@clerk/clerk-react';
import { isReverificationCancelledError } from '@clerk/clerk-react/errors';
import type { TOTPResource } from '@clerk/types';
import { QRCodeSVG } from 'qrcode.react';
import { Copy, Loader2, ShieldCheck } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { getClerkErrorMessage } from '@/app/auth/utils';

/** Clerk's error code for a wrong one-time code. */
function isIncorrectCode(error: unknown): boolean {
  const errors = (error as { errors?: Array<{ code?: string }> } | null)?.errors;
  return Array.isArray(errors) && errors.some((e) => e.code === 'form_code_incorrect');
}

/**
 * Settings → Security: two-step verification with an authenticator app (Clerk
 * TOTP) and its backup codes. A second factor is what connecting a bank asks
 * for (books-api `requireSecondFactor`); a passkey is a sign-in method in
 * Clerk, not a second factor. Turning it on or off and making new backup codes
 * go through Clerk's reverification, like the passkeys.
 */
export function TwoFactorSection() {
  const { user } = useUser();
  const { t } = useI18n();
  const tf = t.settings.security.twoFactor;

  const [isStarting, setIsStarting] = useState(false);
  const [setup, setSetup] = useState<TOTPResource | null>(null);
  const [code, setCode] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const createTotp = useReverification(async () => user?.createTOTP());
  const disableTotp = useReverification(async () => user?.disableTOTP());
  const createBackupCodes = useReverification(async () => user?.createBackupCode());

  const enabled = user?.totpEnabled ?? false;
  const unknownError = t.settings.security.unknown;

  const handleStart = async () => {
    if (!user) return;
    setIsStarting(true);
    try {
      const totp = await createTotp();
      if (totp) {
        setCode('');
        setSetup(totp);
      }
    } catch (error) {
      if (isReverificationCancelledError(error)) return;
      console.error('Failed to start two-step verification setup:', error);
      toast.error(tf.messages.setupFailed.replace('{error}', getClerkErrorMessage(error, unknownError)));
    } finally {
      setIsStarting(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = code.replace(/\s+/g, '');
    if (!user || !value) return;
    setIsVerifying(true);
    try {
      const verified = await user.verifyTOTP({ code: value });
      await user.reload();
      setSetup(null);
      setBackupCodes(verified.backupCodes?.length ? verified.backupCodes : null);
      toast.success(tf.messages.enabled);
    } catch (error) {
      if (isIncorrectCode(error)) {
        toast.error(tf.messages.invalidCode);
      } else {
        console.error('Failed to verify the authenticator code:', error);
        toast.error(tf.messages.setupFailed.replace('{error}', getClerkErrorMessage(error, unknownError)));
      }
    } finally {
      setIsVerifying(false);
    }
  };

  const handleDisable = async () => {
    // Close the confirm dialog first: its focus trap would otherwise block
    // Clerk's reverification modal if the session needs re-confirming.
    setConfirmDisable(false);
    if (!user) return;
    try {
      await disableTotp();
      await user.reload();
      toast.success(tf.messages.disabled);
    } catch (error) {
      if (isReverificationCancelledError(error)) return;
      console.error('Failed to turn off two-step verification:', error);
      toast.error(tf.messages.disableFailed.replace('{error}', getClerkErrorMessage(error, unknownError)));
    }
  };

  const handleNewCodes = async () => {
    if (!user) return;
    try {
      const created = await createBackupCodes();
      await user.reload();
      if (created?.codes?.length) setBackupCodes(created.codes);
    } catch (error) {
      if (isReverificationCancelledError(error)) return;
      console.error('Failed to make new backup codes:', error);
      toast.error(tf.messages.codesFailed.replace('{error}', getClerkErrorMessage(error, unknownError)));
    }
  };

  const copyCodes = async () => {
    if (!backupCodes) return;
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'));
      toast.success(tf.messages.codesCopied);
    } catch {
      // Clipboard blocked: the codes are still on screen to copy by hand.
    }
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-medium">{tf.title}</h3>
            <Badge variant={enabled ? 'default' : 'secondary'}>{enabled ? tf.enabled : tf.disabled}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">{tf.description}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {enabled ? (
            <>
              <Button variant="outline" size="sm" className="shadow-none h-[34px]" onClick={handleNewCodes}>
                {tf.regenerateCodes}
              </Button>
              <Button variant="outline" size="sm" className="shadow-none h-[34px]" onClick={() => setConfirmDisable(true)}>
                {tf.disable}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="shadow-none h-[34px]"
              disabled={isStarting || !user}
              onClick={handleStart}
            >
              {isStarting ? <Loader2 className="h-4 w-4 mr-0.5 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-0.5" />}
              {tf.enable}
            </Button>
          )}
        </div>
      </div>

      <Dialog open={!!setup} onOpenChange={(open) => !open && !isVerifying && setSetup(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <form onSubmit={handleVerify}>
            <DialogHeader>
              <DialogTitle>{tf.setupTitle}</DialogTitle>
              <DialogDescription>{tf.setupScan}</DialogDescription>
            </DialogHeader>
            {setup?.uri ? (
              <div className="mt-4 flex justify-center rounded-md border bg-white p-3">
                <QRCodeSVG value={setup.uri} size={168} />
              </div>
            ) : null}
            {setup?.secret ? (
              <p className="mt-3 text-sm">
                <span className="text-muted-foreground">{tf.setupKey}: </span>
                <code className="break-all font-mono">{setup.secret}</code>
              </p>
            ) : null}
            <label className="mt-4 block text-sm font-medium" htmlFor="totp-code">
              {tf.codeLabel}
            </label>
            <Input
              id="totp-code"
              className="mt-1.5"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={tf.codePlaceholder}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={10}
              disabled={isVerifying}
              autoFocus
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setSetup(null)} disabled={isVerifying}>
                {tf.cancel}
              </Button>
              <Button type="submit" disabled={isVerifying || !code.trim()}>
                {isVerifying && <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />}
                {tf.verify}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!backupCodes} onOpenChange={(open) => !open && setBackupCodes(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{tf.backupTitle}</DialogTitle>
            <DialogDescription>{tf.backupDescription}</DialogDescription>
          </DialogHeader>
          <ul className="mt-4 grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-3 font-mono text-sm">
            {backupCodes?.map((backupCode) => <li key={backupCode}>{backupCode}</li>)}
          </ul>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={copyCodes}>
              <Copy className="h-4 w-4 mr-0.5" />
              {tf.copyCodes}
            </Button>
            <Button type="button" onClick={() => setBackupCodes(null)}>
              {tf.done}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title={tf.disableTitle}
        description={tf.disableDescription}
        confirmLabel={tf.disableConfirm}
        cancelLabel={tf.cancel}
        variant="destructive"
        onConfirm={handleDisable}
      />
    </div>
  );
}
