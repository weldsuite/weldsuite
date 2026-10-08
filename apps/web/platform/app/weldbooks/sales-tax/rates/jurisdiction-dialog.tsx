import { useEffect, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
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
import { Switch } from '@weldsuite/ui/components/switch';
import {
  useCreateSalesTaxJurisdiction,
  useUpdateSalesTaxJurisdiction,
} from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import {
  JURISDICTION_LEVELS,
  type SalesTaxAgency,
  type SalesTaxJurisdiction,
} from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { Field, describedBy } from '../setup/field';
import { useSetupTexts } from '../setup/setup-texts';
import {
  emptyJurisdictionForm,
  jurisdictionToForm,
  makeJurisdictionSchema,
  toCreateJurisdictionInput,
  toUpdateJurisdictionInput,
  type JurisdictionFormValues,
} from './rate-model';

export interface JurisdictionDialogProps {
  agency: SalesTaxAgency;
  /** The jurisdiction being edited; none adds a new one with its first rate. */
  jurisdiction?: SalesTaxJurisdiction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The first rate starts the day the registration does, so invoices dated back to then are taxed. */
function firstRateStart(agency: SalesTaxAgency): string {
  return agency.registeredFrom ?? `${new Date().getFullYear()}-01-01`;
}

export function JurisdictionDialog({ agency, jurisdiction, open, onOpenChange }: Readonly<JurisdictionDialogProps>) {
  const { t } = useSetupTexts();
  const td = t.jurisdictions.dialog;
  const create = useCreateSalesTaxJurisdiction();
  const update = useUpdateSalesTaxJurisdiction();
  const mutation = jurisdiction ? update : create;
  const mode = jurisdiction ? 'edit' : 'create';
  const schema = useMemo(() => makeJurisdictionSchema(t.validation, mode), [t.validation, mode]);

  const initial = () => (jurisdiction ? jurisdictionToForm(jurisdiction) : emptyJurisdictionForm(firstRateStart(agency)));
  const form = useForm<JurisdictionFormValues>({ resolver: zodResolver(schema), defaultValues: initial() });
  const errors = form.formState.errors;

  useEffect(() => {
    if (open) {
      form.reset(initial());
      create.reset();
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, jurisdiction?.id]);

  const submit = form.handleSubmit(async (values) => {
    try {
      if (jurisdiction) {
        await update.mutateAsync({ id: jurisdiction.id, input: toUpdateJurisdictionInput(values) });
        toast.success(t.jurisdictions.saved);
      } else {
        await create.mutateAsync(toCreateJurisdictionInput(agency.id, values));
        toast.success(t.jurisdictions.created);
      }
      onOpenChange(false);
    } catch {
      // The error shows in the dialog (mutation.error).
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{jurisdiction ? td.editTitle : td.addTitle}</DialogTitle>
          <DialogDescription>{agency.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Field label={td.level} htmlFor="jurisdiction-level">
              <Controller
                control={form.control}
                name="level"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="jurisdiction-level" aria-label={td.level}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {JURISDICTION_LEVELS.map((level) => (
                        <SelectItem key={level} value={level}>
                          {t.levels[level]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field label={td.name} htmlFor="jurisdiction-name" help={td.nameHelp} error={errors.name?.message}>
              <Input
                id="jurisdiction-name"
                {...form.register('name')}
                aria-invalid={!!errors.name}
                aria-describedby={describedBy('jurisdiction-name', { help: true, error: !!errors.name })}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={td.code} htmlFor="jurisdiction-code" help={td.codeHelp} error={errors.code?.message}>
              <Input id="jurisdiction-code" autoComplete="off" {...form.register('code')} />
            </Field>
            <Field
              label={td.reportingCode}
              htmlFor="jurisdiction-reporting-code"
              help={td.reportingCodeHelp}
              error={errors.reportingCode?.message}
            >
              <Input id="jurisdiction-reporting-code" autoComplete="off" {...form.register('reportingCode')} />
            </Field>
          </div>

          {!jurisdiction ? (
            <fieldset className="space-y-3 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{td.firstRate}</legend>
              <p className="text-xs text-muted-foreground">{td.firstRateHelp}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t.rates.dialog.rate} htmlFor="jurisdiction-rate" error={errors.rate?.message}>
                  <Input
                    id="jurisdiction-rate"
                    inputMode="decimal"
                    autoComplete="off"
                    {...form.register('rate')}
                    aria-invalid={!!errors.rate}
                  />
                </Field>
                <Field label={t.rates.dialog.effectiveFrom} htmlFor="jurisdiction-rate-from" error={errors.effectiveFrom?.message}>
                  <Input
                    id="jurisdiction-rate-from"
                    type="date"
                    {...form.register('effectiveFrom')}
                    aria-invalid={!!errors.effectiveFrom}
                  />
                </Field>
              </div>
            </fieldset>
          ) : null}

          <div className="flex items-start gap-3">
            <Controller
              control={form.control}
              name="isActive"
              render={({ field }) => <Switch id="jurisdiction-active" checked={field.value} onCheckedChange={field.onChange} />}
            />
            <Label htmlFor="jurisdiction-active" className="space-y-0.5 font-normal leading-snug">
              <span className="block font-medium">{td.active}</span>
              <span className="block text-xs text-muted-foreground">{td.activeHelp}</span>
            </Label>
          </div>

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
