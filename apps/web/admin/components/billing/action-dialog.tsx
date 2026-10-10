'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { cn } from '@/lib/utils';
import { adminCopy } from '@/lib/i18n';
import { keepsRequestId, newRequestId } from '@/lib/billing-format';
import type { ActionResult } from '@/actions/workspaces';

/**
 * Dialog shell for every billing change: the dialog's own fields, a required
 * reason (saved in the activity log), and a submit button. Mount it only while
 * open so its state starts fresh each time.
 *
 * One request id per submission becomes the Stripe idempotency key. It is
 * renewed after a definite rejection, so a corrected retry is not mistaken for
 * a replay, and kept after an ambiguous failure (timeout, 5xx), so a retry
 * replays the first attempt instead of repeating it.
 */
export function ActionDialog<T>({
  title,
  description,
  submitLabel,
  destructive = false,
  wide = false,
  invalidMessage,
  onSubmit,
  successMessage,
  onClose,
  children,
}: Readonly<{
  title: React.ReactNode;
  description?: React.ReactNode;
  submitLabel: string;
  destructive?: boolean;
  wide?: boolean;
  /** Set while the dialog's own fields are invalid; shown and blocks submit. */
  invalidMessage?: string | null;
  onSubmit: (reason: string, requestId: string) => Promise<ActionResult<T>>;
  successMessage: string | ((data: NoInfer<T>) => string);
  onClose: () => void;
  children?: React.ReactNode;
}>) {
  const t = adminCopy();
  const [reason, setReason] = useState('');
  const [requestId, setRequestId] = useState(newRequestId);
  const [isPending, startTransition] = useTransition();

  const reasonValid = reason.trim().length >= 3;
  const canSubmit = reasonValid && !invalidMessage && !isPending;

  const submit = () =>
    startTransition(async () => {
      const result = await onSubmit(reason.trim(), requestId);
      if (!result.ok) {
        toast.error(result.error);
        if (!keepsRequestId(result.code)) setRequestId(newRequestId());
        return;
      }
      toast.success(typeof successMessage === 'function' ? successMessage(result.data) : successMessage);
      const warnings = (result.data as { warnings?: unknown } | null)?.warnings;
      if (Array.isArray(warnings)) {
        for (const warning of warnings) if (typeof warning === 'string') toast.warning(warning);
      }
      onClose();
    });

  return (
    <Dialog open onOpenChange={(open) => !open && !isPending && onClose()}>
      <DialogContent className={cn('max-h-[90vh] overflow-y-auto', wide ? 'sm:max-w-xl' : 'sm:max-w-md')}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {children && <div className="space-y-4">{children}</div>}

        <div className="space-y-1.5">
          <Label htmlFor="admin-action-reason" className="text-xs uppercase tracking-wide text-muted-foreground">
            {t.common.reason}
          </Label>
          <Textarea
            id="admin-action-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder={t.common.reasonPlaceholder}
            className="resize-none"
          />
          {reason.length > 0 && !reasonValid && (
            <p className="text-xs text-destructive">{t.common.reasonTooShort}</p>
          )}
        </div>

        {invalidMessage && <p className="text-xs text-destructive">{invalidMessage}</p>}

        <DialogFooter>
          <Button variant="ghost" disabled={isPending} onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} disabled={!canSubmit} onClick={submit}>
            {isPending ? t.common.working : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Label + control + optional hint, stacked. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: Readonly<{ label: React.ReactNode; htmlFor?: string; hint?: React.ReactNode; children: React.ReactNode }>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
