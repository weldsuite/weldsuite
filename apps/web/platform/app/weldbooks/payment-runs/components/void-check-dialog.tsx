import { useEffect, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useVoidCheck } from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import type { VoidCheckInput, VoidCheckResult } from '@/lib/api/domains/weldbooks-payment-runs';
import { describeRunError } from '../run-errors';
import { MAX_REASON_LENGTH, MIN_REASON_LENGTH } from './reason-dialog';

/** The check being voided, as the dialog names it. */
export interface VoidableCheck {
  paymentId: string;
  checkNumber: string | null;
  payeeName: string;
  /** What the check is written for: the net amount. */
  amount: string;
  /** Backup withholding kept back from the vendor with this check; reversed by the void. */
  backupWithholdingAmount?: string | null;
}

interface VoidCheckDialogProps {
  check: VoidableCheck | null;
  onOpenChange: (open: boolean) => void;
  /** Called after the check is voided (and the replacement written, when asked for). */
  onVoided?: (result: VoidCheckResult) => void;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The request a void makes: the reason is trimmed, the date only goes with a reissue. */
export function buildVoidInput(values: { reason: string; reissue: boolean; date: string }): VoidCheckInput {
  return {
    reason: values.reason.trim(),
    reissue: values.reissue,
    ...(values.reissue ? { date: values.date } : {}),
  };
}

/** Voids a check, and writes a replacement under the next check number when asked. A reason is required: it stays on the check. */
export function VoidCheckDialog({ check, onOpenChange, onVoided }: Readonly<VoidCheckDialogProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const tv = tp.voidCheck;
  const { today, formatMoney } = useWeldbooksFormat();
  const voidCheck = useVoidCheck();

  const schema = useMemo(
    () =>
      z
        .object({
          reason: z.string().trim().min(MIN_REASON_LENGTH, tp.common.reasonRequired).max(MAX_REASON_LENGTH),
          reissue: z.boolean(),
          date: z.string(),
        })
        .refine((values) => !values.reissue || ISO_DAY.test(values.date), { path: ['date'], message: tv.dateInvalid }),
    [tp.common.reasonRequired, tv.dateInvalid],
  );
  type Values = z.infer<typeof schema>;

  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { reason: '', reissue: false, date: '' } });

  const open = check !== null;
  useEffect(() => {
    if (open) reset({ reason: '', reissue: false, date: today() });
  }, [open, reset, today]);

  const reissue = watch('reissue');

  const onSubmit = (values: Values) => {
    if (!check) return;
    voidCheck.mutate(
      { paymentId: check.paymentId, input: buildVoidInput(values) },
      {
        onSuccess: (result) => {
          toast.success(result.replacement ? tv.voidedAndReissued.replace('{number}', result.replacement.checkNumber ?? '') : tv.voided);
          onVoided?.(result);
          onOpenChange(false);
        },
        onError: (err) => toast.error(tv.failed, { description: describeRunError(err, tp.errors, tp.errors.generic) }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={voidCheck.isPending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {tv.title.replace('{number}', check?.checkNumber ?? '')}
          </DialogTitle>
          <DialogDescription>
            {check ? tv.description.replace('{payee}', check.payeeName).replace('{amount}', formatMoney(check.amount)) : ''}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="void-check-reason">{tv.reason}</Label>
            <Textarea id="void-check-reason" rows={3} maxLength={MAX_REASON_LENGTH} aria-invalid={!!errors.reason} {...register('reason')} />
            {errors.reason ? <p className="text-sm text-destructive">{errors.reason.message}</p> : null}
          </div>

          <div className="flex items-start gap-2">
            <Controller
              control={control}
              name="reissue"
              render={({ field }) => (
                <Checkbox id="void-check-reissue" checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
              )}
            />
            <div className="space-y-0.5">
              <Label htmlFor="void-check-reissue">{tv.reissue}</Label>
              <p className="text-xs text-muted-foreground">{tv.reissueHint}</p>
            </div>
          </div>

          {reissue ? (
            <div className="space-y-2">
              <Label htmlFor="void-check-date">{tv.replacementDate}</Label>
              <Input id="void-check-date" type="date" {...register('date')} />
              {errors.date ? <p className="text-sm text-destructive">{errors.date.message}</p> : null}
            </div>
          ) : null}

          <p className="text-xs text-muted-foreground">{tv.effects}</p>
          {check?.backupWithholdingAmount ? (
            <p className="text-xs text-muted-foreground">{tv.withholdingEffect.replace('{withheld}', formatMoney(check.backupWithholdingAmount))}</p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={voidCheck.isPending}>
              {tp.common.cancel}
            </Button>
            <Button type="submit" variant="destructive" disabled={voidCheck.isPending}>
              {voidCheck.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {reissue ? tv.voidAndReissue : tv.void}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
