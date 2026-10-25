'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { usePortal } from './portal-context';

interface DeclineDialogProps {
  open: boolean;
  /** Resolves when the decline went through, rejects with a message to show. */
  onSubmit: (reason: string) => Promise<void>;
  onClose: () => void;
}

export function DeclineDialog({ open, onSubmit, onClose }: Readonly<DeclineDialogProps>) {
  const { t } = usePortal();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = reason.trim();
    if (!value) {
      setError(t.decline.reasonRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
    } catch {
      setError(t.decline.failed);
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent showCloseButton={false}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t.decline.title}</DialogTitle>
            <DialogDescription>{t.decline.body}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sign-decline-reason">{t.decline.reasonLabel}</Label>
            <Textarea
              id="sign-decline-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t.decline.reasonPlaceholder}
              maxLength={1000}
              rows={4}
              required
              className="text-base"
              aria-invalid={error ? true : undefined}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t.decline.cancel}
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || !reason.trim()}>
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {busy ? t.decline.submitting : t.decline.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
