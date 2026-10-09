import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { useI18n } from '@/lib/i18n/provider';
import { useFileTaxReturn } from '@/hooks/queries/use-weldbooks-sales-tax-center-queries';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import type { FileReturnResult, TaxReturnDetail } from '@/lib/api/domains/weldbooks-sales-tax-center';
import { Notice } from '../../shared/notice';
import { fill } from '../../shared/text';
import { isRecalculateConflict } from '../return-model';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface FileReturnDialogProps {
  ret: TaxReturnDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Issues the pre-file check found, when it ran. */
  findingsCount?: number;
  /** The ledger moved since the calculation: calculate the return again. False when it did not work. */
  onRecalculate: () => Promise<boolean>;
  /** Go on to the payment after filing. */
  onRecordPayment: () => void;
}

/** Marks a return filed with the agency's confirmation number, and shows what the server says about it. */
export function FileReturnDialog({
  ret,
  open,
  onOpenChange,
  findingsCount = 0,
  onRecalculate,
  onRecordPayment,
}: Readonly<FileReturnDialogProps>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.salesTax.center.returnPage.fileDialog;
  const { today, formatDate } = useWeldbooksFormat();
  const fileReturn = useFileTaxReturn(ret.id);
  const [result, setResult] = useState<FileReturnResult | null>(null);
  const [recalcNeeded, setRecalcNeeded] = useState(false);
  const [recalculating, setRecalculating] = useState(false);

  const schema = useMemo(
    () =>
      z
        .object({
          confirmationNumber: z.string().trim().min(1, tf.confirmationRequired).max(255),
          filedAt: z.string().regex(DAY, tf.dateRequired),
        })
        .refine((values) => values.filedAt >= ret.periodEnd, {
          path: ['filedAt'],
          message: fill(tf.dateBeforePeriod, { date: formatDate(ret.periodEnd) }),
        }),
    [tf, ret.periodEnd, formatDate],
  );
  type Values = z.infer<typeof schema>;

  const defaults = useMemo<Values>(() => {
    const now = today();
    return { confirmationNumber: '', filedAt: now >= ret.periodEnd ? now : ret.periodEnd };
  }, [today, ret.periodEnd]);

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults });

  // Every opening starts from a clean form.
  useEffect(() => {
    if (open) {
      reset(defaults);
      setResult(null);
      setRecalcNeeded(false);
    }
  }, [open, defaults, reset]);

  const filedAt = watch('filedAt');
  const late = Boolean(ret.dueDate && DAY.test(filedAt) && filedAt > ret.dueDate);
  const warningTitles = tf.warningTitles as Record<string, string>;
  const warningDescriptions = tf.warningDescriptions as Record<string, string>;

  const onSubmit = async (values: Values) => {
    setRecalcNeeded(false);
    try {
      setResult(await fileReturn.mutateAsync({ confirmationNumber: values.confirmationNumber.trim(), filedAt: values.filedAt }));
    } catch (err) {
      if (isRecalculateConflict(err)) {
        setRecalcNeeded(true);
        return;
      }
      toast.error(tf.failed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const recalculate = async () => {
    setRecalculating(true);
    try {
      if (await onRecalculate()) onOpenChange(false);
    } finally {
      setRecalculating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{result ? tf.filedTitle : tf.title}</DialogTitle>
          <DialogDescription>
            {result ? (result.warnings.length === 0 ? tf.noWarnings : tf.warningsTitle) : fill(tf.description, { agency: ret.agency.name })}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3" data-testid="file-result">
            {result.warnings.length === 0 ? (
              <Notice tone="success">
                <p>{tf.noWarnings}</p>
              </Notice>
            ) : (
              result.warnings.map((warning) => (
                <Notice key={warning.code} tone="warning" title={warningTitles[warning.code] ?? warning.code}>
                  <p>{warningDescriptions[warning.code] ?? warning.message}</p>
                </Notice>
              ))
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {tf.later}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onRecordPayment();
                }}
              >
                {tf.recordPayment}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            {recalcNeeded ? (
              <Notice
                tone="danger"
                title={tf.recalcTitle}
                data-testid="recalculate-notice"
                action={
                  <Button type="button" size="sm" onClick={() => void recalculate()} disabled={recalculating}>
                    {recalculating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                    {tf.recalcAction}
                  </Button>
                }
              >
                <p>{tf.recalcDescription}</p>
              </Notice>
            ) : null}
            {findingsCount > 0 ? (
              <Notice tone="warning">
                <p>{findingsCount === 1 ? tf.findingsNoteOne : fill(tf.findingsNoteMany, { count: findingsCount })}</p>
              </Notice>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="file-confirmation">{tf.confirmation}</Label>
              <Input
                id="file-confirmation"
                autoComplete="off"
                maxLength={255}
                aria-invalid={Boolean(errors.confirmationNumber)}
                {...register('confirmationNumber')}
              />
              {errors.confirmationNumber ? (
                <p className="text-sm text-destructive">{errors.confirmationNumber.message}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{tf.confirmationHint}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="file-date">{tf.filedDate}</Label>
              <Input id="file-date" type="date" aria-invalid={Boolean(errors.filedAt)} {...register('filedAt')} />
              {errors.filedAt ? <p className="text-sm text-destructive">{errors.filedAt.message}</p> : null}
            </div>

            {late && ret.dueDate ? (
              <Notice tone="warning" data-testid="late-notice">
                <p>{fill(tf.late, { date: formatDate(ret.dueDate) })}</p>
              </Notice>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t.weldbooksUs.salesTax.center.common.cancel}
              </Button>
              <Button type="submit" disabled={fileReturn.isPending}>
                {fileReturn.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                {fileReturn.isPending ? tf.submitting : tf.submit}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
