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
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useUpdateSalesTaxAgency } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import { FILING_FREQUENCIES, type SalesTaxAgency } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { getSalesTaxState } from '@/lib/weldbooks/us-sales-tax-states';
import { Field } from '../setup/field';
import { useSetupTexts } from '../setup/setup-texts';
import {
  agencyToEditValues,
  cashBasisAvailable,
  makeAgencyEditSchema,
  toUpdateAgencyInput,
  type AgencyEditValues,
} from './agency-model';

export interface AgencyEditDialogProps {
  agency: SalesTaxAgency;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Edit what was typed at registration: number, dates, filing setup, portal, notes. The state never changes. */
export function AgencyEditDialog({ agency, open, onOpenChange }: Readonly<AgencyEditDialogProps>) {
  const { t, format } = useSetupTexts();
  const tw = t.wizard.registrationStep;
  const update = useUpdateSalesTaxAgency();
  const schema = useMemo(() => makeAgencyEditSchema(t.validation, agency), [t.validation, agency]);
  const form = useForm<AgencyEditValues>({ resolver: zodResolver(schema), defaultValues: agencyToEditValues(agency) });
  const errors = form.formState.errors;
  const state = getSalesTaxState(agency.stateCode);
  const cashOffered = cashBasisAvailable(state, agency.level === 'local');

  // Start from what is saved each time the dialog opens.
  useEffect(() => {
    if (open) {
      form.reset(agencyToEditValues(agency));
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agency]);

  const submit = form.handleSubmit(async (values) => {
    try {
      await update.mutateAsync({ id: agency.id, input: toUpdateAgencyInput(values) });
      toast.success(t.agency.saved);
      onOpenChange(false);
    } catch {
      // The error shows in the dialog (update.error).
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t.agency.editTitle}</DialogTitle>
          <DialogDescription>{agency.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tw.name} htmlFor="edit-agency-name" error={errors.name?.message}>
              <Input id="edit-agency-name" {...form.register('name')} aria-invalid={!!errors.name} />
            </Field>
            <Field label={tw.registrationNumber} htmlFor="edit-agency-number" error={errors.registrationNumber?.message}>
              <Input id="edit-agency-number" autoComplete="off" {...form.register('registrationNumber')} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={tw.registeredFrom}
              htmlFor="edit-agency-from"
              help={tw.registeredFromHelp}
              error={errors.registeredFrom?.message}
            >
              <Input id="edit-agency-from" type="date" {...form.register('registeredFrom')} aria-invalid={!!errors.registeredFrom} />
            </Field>
            <Field label={t.agency.fields.registeredUntil} htmlFor="edit-agency-until" error={errors.registeredUntil?.message}>
              <Input id="edit-agency-until" type="date" {...form.register('registeredUntil')} aria-invalid={!!errors.registeredUntil} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tw.frequency} htmlFor="edit-agency-frequency">
              <Controller
                control={form.control}
                name="filingFrequency"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="edit-agency-frequency" aria-label={tw.frequency}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FILING_FREQUENCIES.map((f) => (
                        <SelectItem key={f} value={f}>
                          {t.frequencies[f]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field label={tw.firstPeriodStart} htmlFor="edit-agency-first-period" error={errors.firstPeriodStart?.message}>
              <Input id="edit-agency-first-period" type="date" {...form.register('firstPeriodStart')} />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tw.dueDay} htmlFor="edit-agency-due-day" help={tw.dueDayHelp} error={errors.dueDay?.message}>
              <Input
                id="edit-agency-due-day"
                type="number"
                inputMode="numeric"
                min={1}
                max={31}
                {...form.register('dueDay')}
                aria-invalid={!!errors.dueDay}
              />
            </Field>
            <Field label={tw.basis} htmlFor="edit-agency-basis" error={errors.reportingBasis?.message}>
              {cashOffered ? (
                <Controller
                  control={form.control}
                  name="reportingBasis"
                  render={({ field }) => (
                    <RadioGroup id="edit-agency-basis" value={field.value} onValueChange={field.onChange} className="flex gap-6 pt-1">
                      {(['accrual', 'cash'] as const).map((basis) => (
                        <div key={basis} className="flex items-center gap-2">
                          <RadioGroupItem value={basis} id={`edit-agency-basis-${basis}`} />
                          <Label htmlFor={`edit-agency-basis-${basis}`} className="font-normal">
                            {t.bases[basis]}
                          </Label>
                        </div>
                      ))}
                    </RadioGroup>
                  )}
                />
              ) : (
                <p id="edit-agency-basis" className="pt-1 text-sm text-muted-foreground">
                  {format(tw.basisAccrualOnly, { state: state?.name ?? agency.stateCode })}
                </p>
              )}
            </Field>
          </div>

          <div className="flex items-start gap-2">
            <Controller
              control={form.control}
              name="sstMember"
              render={({ field }) => (
                <Checkbox id="edit-agency-sst" checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
              )}
            />
            <Label htmlFor="edit-agency-sst" className="font-normal leading-snug">
              {tw.sst}
            </Label>
          </div>

          <Field label={tw.portalUrl} htmlFor="edit-agency-portal" error={errors.portalUrl?.message}>
            <Input id="edit-agency-portal" type="url" inputMode="url" {...form.register('portalUrl')} aria-invalid={!!errors.portalUrl} />
          </Field>

          <Field label={tw.notes} htmlFor="edit-agency-notes" error={errors.notes?.message}>
            <Textarea id="edit-agency-notes" rows={3} {...form.register('notes')} />
          </Field>

          {update.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {update.error instanceof Error && update.error.message ? update.error.message : t.common.saveError}
              </AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
              {update.isPending ? t.common.saving : t.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
