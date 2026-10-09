import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
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
import { useI18n } from '@/lib/i18n/provider';

/** The server asks for at least this many characters of a reason (`reasonSchema`, `releaseHold`). */
export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 500;

interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  destructive?: boolean;
  /** Runs with the trimmed reason; the dialog closes when it resolves and stays open (with the error shown by the caller) when it throws. */
  onSubmit: (reason: string) => Promise<void>;
}

/** A dialog that asks why before something that is kept on the record: rejecting a run, releasing a hold. */
export function ReasonDialog({ open, onOpenChange, title, description, label, submitLabel, destructive, onSubmit }: Readonly<ReasonDialogProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;

  const schema = useMemo(
    () =>
      z.object({
        reason: z.string().trim().min(MIN_REASON_LENGTH, tp.common.reasonRequired).max(MAX_REASON_LENGTH),
      }),
    [tp.common.reasonRequired],
  );
  type Values = z.infer<typeof schema>;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { reason: '' } });

  useEffect(() => {
    if (open) reset({ reason: '' });
  }, [open, reset]);

  const submit = async (values: Values) => {
    try {
      await onSubmit(values.reason);
      onOpenChange(false);
    } catch {
      // The caller shows the error; the dialog stays open so the reason is not lost.
    }
  };

  return (
    <Dialog open={open} onOpenChange={isSubmitting ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="reason-dialog-reason">{label}</Label>
            <Textarea id="reason-dialog-reason" rows={3} maxLength={MAX_REASON_LENGTH} aria-invalid={!!errors.reason} {...register('reason')} />
            {errors.reason ? <p className="text-sm text-destructive">{errors.reason.message}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              {tp.common.cancel}
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={isSubmitting}>
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
