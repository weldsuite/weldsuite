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
import { MultiSelect, type MultiSelectOption } from '@weldsuite/ui/components/multi-select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useCreateSalesTaxZone,
  useUpdateSalesTaxZone,
} from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type {
  SalesTaxAgency,
  SalesTaxJurisdiction,
  SalesTaxZone,
} from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { Field, describedBy } from '../setup/field';
import { formatRatePercent } from '../setup/format';
import { useSetupTexts } from '../setup/setup-texts';
import { sortJurisdictions } from '../rates/rate-model';
import {
  combinedRate,
  emptyZoneForm,
  formatCombinedRate,
  makeZoneSchema,
  toCreateZoneInput,
  toUpdateZoneInput,
  zoneToForm,
  type ZoneFormValues,
} from './zone-model';
import { countZips, parseZipList } from './zip-list';

export interface ZoneDialogProps {
  agency: SalesTaxAgency;
  /** The agency's jurisdictions: a zone combines some of them. */
  jurisdictions: readonly SalesTaxJurisdiction[];
  /** The zone being edited; none adds a new one. */
  zone?: SalesTaxZone;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ZoneDialog({ agency, jurisdictions, zone, open, onOpenChange }: Readonly<ZoneDialogProps>) {
  const { t, format, plural } = useSetupTexts();
  const tz = t.zones.dialog;
  const create = useCreateSalesTaxZone();
  const update = useUpdateSalesTaxZone();
  const mutation = zone ? update : create;
  const schema = useMemo(() => makeZoneSchema(t.validation, t.zones.problems, format), [t.validation, t.zones.problems, format]);

  const initial = () => (zone ? zoneToForm(zone) : emptyZoneForm());
  const form = useForm<ZoneFormValues>({ resolver: zodResolver(schema), defaultValues: initial() });
  const errors = form.formState.errors;
  const values = form.watch();

  useEffect(() => {
    if (open) {
      form.reset(initial());
      create.reset();
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, zone?.id]);

  const options: MultiSelectOption[] = useMemo(
    () =>
      sortJurisdictions(jurisdictions).map((j) => ({
        value: j.id,
        label: `${j.name} · ${t.levels[j.level]}${j.currentRate === null ? '' : ` · ${formatRatePercent(j.currentRate)}`}`,
      })),
    [jurisdictions, t.levels],
  );

  const parsed = parseZipList(values.zipText);
  const combined = combinedRate(jurisdictions, values.jurisdictionIds);

  const submit = form.handleSubmit(async (data) => {
    try {
      if (zone) {
        await update.mutateAsync({ id: zone.id, input: toUpdateZoneInput(data) });
        toast.success(t.zones.saved);
      } else {
        await create.mutateAsync(toCreateZoneInput(agency.id, data));
        toast.success(t.zones.created);
      }
      onOpenChange(false);
    } catch {
      // The error shows in the dialog (mutation.error).
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{zone ? tz.editTitle : tz.addTitle}</DialogTitle>
          <DialogDescription>{agency.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-4">
          <Field label={tz.name} htmlFor="zone-name" help={tz.nameHelp} error={errors.name?.message}>
            <Input
              id="zone-name"
              {...form.register('name')}
              aria-invalid={!!errors.name}
              aria-describedby={describedBy('zone-name', { help: true, error: !!errors.name })}
            />
          </Field>

          <Field label={tz.jurisdictions} htmlFor="zone-jurisdictions" help={tz.jurisdictionsHelp} error={errors.jurisdictionIds?.message}>
            <Controller
              control={form.control}
              name="jurisdictionIds"
              render={({ field }) => (
                <MultiSelect
                  id="zone-jurisdictions"
                  modal
                  options={options}
                  value={field.value}
                  onChange={field.onChange}
                  placeholder={tz.jurisdictionsPlaceholder}
                  searchPlaceholder={tz.jurisdictionsSearch}
                  emptyText={tz.jurisdictionsEmpty}
                  aria-label={tz.jurisdictions}
                />
              )}
            />
          </Field>

          <Field label={tz.zips} htmlFor="zone-zips" help={tz.zipsHelp} error={errors.zipText?.message}>
            <Textarea
              id="zone-zips"
              rows={3}
              placeholder={tz.zipsPlaceholder}
              spellCheck={false}
              {...form.register('zipText')}
              aria-invalid={!!errors.zipText}
              aria-describedby={describedBy('zone-zips', { help: true, error: !!errors.zipText })}
            />
          </Field>
          {parsed.entries.length > 0 ? (
            <p className="-mt-2 text-xs text-muted-foreground" data-testid="zip-summary">
              {plural(parsed.entries.length, tz.zipsParsed)} · {plural(countZips(parsed.entries), t.zones.zipCount)}
            </p>
          ) : null}

          <div className="flex items-start gap-3">
            <Controller
              control={form.control}
              name="isOrigin"
              render={({ field }) => <Switch id="zone-origin" checked={field.value} onCheckedChange={field.onChange} />}
            />
            <Label htmlFor="zone-origin" className="space-y-0.5 font-normal leading-snug">
              <span className="block font-medium">{tz.origin}</span>
              <span className="block text-xs text-muted-foreground">{tz.originHelp}</span>
            </Label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tz.priority} htmlFor="zone-priority" help={tz.priorityHelp} error={errors.priority?.message}>
              <Input
                id="zone-priority"
                type="number"
                inputMode="numeric"
                min={0}
                max={10000}
                {...form.register('priority')}
                aria-invalid={!!errors.priority}
              />
            </Field>
            <div className="space-y-1.5">
              <p className="text-sm font-medium leading-none">{tz.combined}</p>
              <p className="pt-1 text-2xl font-semibold tabular-nums" data-testid="zone-combined-rate">
                {formatCombinedRate(combined)}
              </p>
            </div>
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
