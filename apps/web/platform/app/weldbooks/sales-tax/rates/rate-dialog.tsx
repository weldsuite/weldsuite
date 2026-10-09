import { useEffect, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
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
  useCreateSalesTaxRate,
  useUpdateSalesTaxRate,
} from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type { JurisdictionRate, SalesTaxJurisdiction } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { Field, describedBy } from '../setup/field';
import { formatRatePercent } from '../setup/format';
import { useSetupTexts } from '../setup/setup-texts';
import {
  emptyRateForm,
  makeRateSchema,
  openEndedRateBefore,
  rateToForm,
  toCreateRateInput,
  toUpdateRateInput,
  type RateFormValues,
} from './rate-model';

export interface RateDialogProps {
  jurisdiction: SalesTaxJurisdiction;
  /** The rate being edited; none adds a new one. */
  rate?: JurisdictionRate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Add a rate to a jurisdiction (offering to end the open-ended one before it), or edit one. */
export function RateDialog({ jurisdiction, rate, open, onOpenChange }: Readonly<RateDialogProps>) {
  const { t, format } = useSetupTexts();
  const tr = t.rates.dialog;
  const { today, formatDate } = useWeldbooksFormat();
  const create = useCreateSalesTaxRate();
  const update = useUpdateSalesTaxRate();
  const mutation = rate ? update : create;
  const schema = useMemo(() => makeRateSchema(t.validation), [t.validation]);

  const initial = (): RateFormValues => {
    if (rate) return rateToForm(rate);
    const from = today();
    return { ...emptyRateForm(from), closePrevious: !!openEndedRateBefore(jurisdiction.rates, from) };
  };

  const form = useForm<RateFormValues>({ resolver: zodResolver(schema), defaultValues: initial() });
  const errors = form.formState.errors;
  const effectiveFrom = form.watch('effectiveFrom');
  // Only a new rate can end the one before it, and only when there is one to end.
  const previous = rate ? undefined : openEndedRateBefore(jurisdiction.rates, effectiveFrom);

  useEffect(() => {
    if (open) {
      form.reset(initial());
      create.reset();
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rate, jurisdiction.id]);

  const submit = form.handleSubmit(async (values) => {
    try {
      if (rate) {
        await update.mutateAsync({ jurisdictionId: jurisdiction.id, rateId: rate.id, input: toUpdateRateInput(values) });
      } else {
        await create.mutateAsync({
          jurisdictionId: jurisdiction.id,
          input: toCreateRateInput({ ...values, closePrevious: values.closePrevious && !!previous }),
        });
      }
      toast.success(t.rates.saved);
      onOpenChange(false);
    } catch {
      // The error shows in the dialog (mutation.error): an overlap names the rate it clashes with.
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{rate ? tr.editTitle : format(tr.addTitle, { name: jurisdiction.name })}</DialogTitle>
          <DialogDescription>{tr.overlapNote}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-4">
          <Field label={tr.rate} htmlFor="rate-value" help={tr.rateHelp} error={errors.rate?.message}>
            <Input
              id="rate-value"
              inputMode="decimal"
              autoComplete="off"
              {...form.register('rate')}
              aria-invalid={!!errors.rate}
              aria-describedby={describedBy('rate-value', { help: true, error: !!errors.rate })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr.effectiveFrom} htmlFor="rate-from" error={errors.effectiveFrom?.message}>
              <Input id="rate-from" type="date" {...form.register('effectiveFrom')} aria-invalid={!!errors.effectiveFrom} />
            </Field>
            <Field label={tr.effectiveTo} htmlFor="rate-to" help={tr.effectiveToHelp} error={errors.effectiveTo?.message}>
              <Input id="rate-to" type="date" {...form.register('effectiveTo')} aria-invalid={!!errors.effectiveTo} />
            </Field>
          </div>

          {previous ? (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-3">
              <Controller
                control={form.control}
                name="closePrevious"
                render={({ field }) => (
                  <Checkbox
                    id="rate-close-previous"
                    checked={field.value}
                    onCheckedChange={(checked) => field.onChange(checked === true)}
                    className="mt-0.5"
                  />
                )}
              />
              <Label htmlFor="rate-close-previous" className="space-y-0.5 font-normal leading-snug">
                <span className="block font-medium">{tr.closePrevious}</span>
                <span className="block text-xs text-muted-foreground">
                  {format(tr.closePreviousHelp, {
                    rate: `${formatRatePercent(previous.rate)} (${formatDate(previous.effectiveFrom)})`,
                  })}
                </span>
              </Label>
            </div>
          ) : null}

          {mutation.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {mutation.error instanceof Error && mutation.error.message ? mutation.error.message : t.common.saveError}
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
              {mutation.isPending ? t.common.saving : t.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
