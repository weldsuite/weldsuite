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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useI18n } from '@/lib/i18n/provider';
import { useUpdatePaymentRun } from '@/hooks/queries/use-weldbooks-payment-runs-queries';
import { ACH_SEC_CODES, type PaymentRunDetail, type UpdateRunInput } from '@/lib/api/domains/weldbooks-payment-runs';
import { describeRunError } from '../run-errors';

interface EditRunDialogProps {
  run: PaymentRunDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lowering an ACH run below two approvals takes `banking:manage`. */
  canManage: boolean;
  /** Same Day ACH is on for the run's bank account. */
  sameDayAllowed: boolean;
}

/** Edits what a draft run says about itself: the date, who approves, ACH options and the note. The bills stay as planned. */
export function EditRunDialog({ run, open, onOpenChange, canManage, sameDayAllowed }: Readonly<EditRunDialogProps>) {
  const { t } = useI18n();
  const tp = t.weldbooksUs.payments;
  const te = tp.detail.edit;
  const tw = tp.wizard.setup;
  const update = useUpdatePaymentRun();

  const schema = useMemo(
    () =>
      z.object({
        paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, tw.paymentDateInvalid),
        requiredApprovals: z.enum(['1', '2']),
        secCode: z.string(),
        sameDay: z.boolean(),
        notes: z.string().max(2000),
      }),
    [tw.paymentDateInvalid],
  );
  type Values = z.infer<typeof schema>;

  const defaults = useMemo<Values>(
    () => ({
      paymentDate: run.paymentDate,
      requiredApprovals: run.requiredApprovals === 2 ? '2' : '1',
      secCode: run.secCode ?? 'auto',
      sameDay: run.sameDay,
      notes: run.notes ?? '',
    }),
    [run],
  );

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults });

  useEffect(() => {
    if (open) reset(defaults);
  }, [open, defaults, reset]);

  const isAch = run.method === 'ach';
  const approvalsLocked = isAch && !canManage;

  const onSubmit = (values: Values) => {
    const notes = values.notes.trim();
    const input: UpdateRunInput = {
      paymentDate: values.paymentDate,
      requiredApprovals: values.requiredApprovals === '2' ? 2 : 1,
      notes: notes || null,
      ...(isAch
        ? {
            secCode: values.secCode === 'auto' ? null : (values.secCode as (typeof ACH_SEC_CODES)[number]),
            sameDay: values.sameDay,
          }
        : {}),
    };
    update.mutate(
      { id: run.id, input },
      {
        onSuccess: () => {
          toast.success(te.saved);
          onOpenChange(false);
        },
        onError: (err) => toast.error(te.failed, { description: describeRunError(err, tp.errors, tp.errors.generic) }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={update.isPending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{te.title}</DialogTitle>
          <DialogDescription>{te.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="edit-run-date">{tw.paymentDate}</Label>
            <Input id="edit-run-date" type="date" {...register('paymentDate')} />
            {errors.paymentDate ? <p className="text-sm text-destructive">{errors.paymentDate.message}</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-run-approvals">{tw.approvals}</Label>
            <Controller
              control={control}
              name="requiredApprovals"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={approvalsLocked}>
                  <SelectTrigger id="edit-run-approvals">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">{tw.approvalsOne}</SelectItem>
                    <SelectItem value="2">{tw.approvalsTwo}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {isAch ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="edit-run-sec">{tw.secCode}</Label>
                <Controller
                  control={control}
                  name="secCode"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="edit-run-sec">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">{tp.secCodes.auto}</SelectItem>
                        {ACH_SEC_CODES.map((code) => (
                          <SelectItem key={code} value={code}>{tp.secCodes[code]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div className="flex items-start gap-2">
                <Controller
                  control={control}
                  name="sameDay"
                  render={({ field }) => (
                    <Checkbox
                      id="edit-run-same-day"
                      checked={field.value}
                      disabled={!sameDayAllowed}
                      onCheckedChange={(checked) => field.onChange(checked === true)}
                    />
                  )}
                />
                <div className="space-y-0.5">
                  <Label htmlFor="edit-run-same-day">{tp.sameDay}</Label>
                  <p className="text-xs text-muted-foreground">{sameDayAllowed ? tw.sameDayHint : tw.sameDayOff}</p>
                </div>
              </div>
            </>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="edit-run-notes">{tw.notes}</Label>
            <Textarea id="edit-run-notes" rows={2} maxLength={2000} {...register('notes')} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={update.isPending}>
              {tp.common.cancel}
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {tp.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
