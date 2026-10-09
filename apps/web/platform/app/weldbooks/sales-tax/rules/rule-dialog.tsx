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
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  useCreateSalesTaxRule,
  useUpdateSalesTaxRule,
} from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import { TAX_USES, type SalesTaxAgency, type SalesTaxRule } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { Field, describedBy } from '../setup/field';
import { useSetupTexts } from '../setup/setup-texts';
import {
  WELD_TAX_CODES,
  emptyRuleForm,
  isWeldTaxCode,
  makeRuleSchema,
  ruleToForm,
  toCreateRuleInput,
  toUpdateRuleInput,
  type RuleFormValues,
} from './rule-model';

export interface RuleDialogProps {
  agency: SalesTaxAgency;
  /** The rule being edited; none adds a new one. */
  rule?: SalesTaxRule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RuleDialog({ agency, rule, open, onOpenChange }: Readonly<RuleDialogProps>) {
  const { t } = useSetupTexts();
  const tr = t.rules.dialog;
  const { today } = useWeldbooksFormat();
  const create = useCreateSalesTaxRule();
  const update = useUpdateSalesTaxRule();
  const mutation = rule ? update : create;
  const schema = useMemo(() => makeRuleSchema(t.validation), [t.validation]);

  const initial = () => (rule ? ruleToForm(rule) : emptyRuleForm(today()));
  const form = useForm<RuleFormValues>({ resolver: zodResolver(schema), defaultValues: initial() });
  const errors = form.formState.errors;
  const taxable = form.watch('taxable');
  const taxCode = form.watch('taxCode');

  useEffect(() => {
    if (open) {
      form.reset(initial());
      create.reset();
      update.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule?.id]);

  const submit = form.handleSubmit(async (values) => {
    try {
      if (rule) {
        await update.mutateAsync({ id: rule.id, input: toUpdateRuleInput(values) });
        toast.success(t.rules.saved);
      } else {
        await create.mutateAsync(toCreateRuleInput(agency.id, values));
        toast.success(t.rules.created);
      }
      onOpenChange(false);
    } catch {
      // The error shows in the dialog (mutation.error): an overlap names the rule it clashes with.
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{rule ? tr.editTitle : tr.addTitle}</DialogTitle>
          <DialogDescription>{agency.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-4">
          <Field label={tr.taxCode} htmlFor="rule-tax-code" help={tr.taxCodeHelp} error={errors.taxCode?.message}>
            <Controller
              control={form.control}
              name="taxCode"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="rule-tax-code" aria-label={tr.taxCode}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WELD_TAX_CODES.map((code) => (
                      <SelectItem key={code} value={code}>
                        {t.taxCodes[code].label}
                      </SelectItem>
                    ))}
                    {/* A rule saved with a provider code keeps showing as it is. */}
                    {taxCode && !isWeldTaxCode(taxCode) ? <SelectItem value={taxCode}>{taxCode}</SelectItem> : null}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          {isWeldTaxCode(taxCode) ? <p className="-mt-2 text-xs text-muted-foreground">{t.taxCodes[taxCode].description}</p> : null}

          <div className="flex items-start gap-3">
            <Controller
              control={form.control}
              name="taxable"
              render={({ field }) => <Switch id="rule-taxable" checked={field.value} onCheckedChange={field.onChange} />}
            />
            <Label htmlFor="rule-taxable" className="space-y-0.5 font-normal leading-snug">
              <span className="block font-medium">{tr.taxable}</span>
              <span className="block text-xs text-muted-foreground">{tr.taxableHelp}</span>
            </Label>
          </div>

          {taxable ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={tr.percent} htmlFor="rule-percent" help={tr.percentHelp} error={errors.taxablePercent?.message}>
                  <Input
                    id="rule-percent"
                    inputMode="decimal"
                    autoComplete="off"
                    {...form.register('taxablePercent')}
                    aria-invalid={!!errors.taxablePercent}
                    aria-describedby={describedBy('rule-percent', { help: true, error: !!errors.taxablePercent })}
                  />
                </Field>
                <Field label={tr.rateOverride} htmlFor="rule-override" help={tr.rateOverrideHelp} error={errors.rateOverride?.message}>
                  <Input
                    id="rule-override"
                    inputMode="decimal"
                    autoComplete="off"
                    {...form.register('rateOverride')}
                    aria-invalid={!!errors.rateOverride}
                    aria-describedby={describedBy('rule-override', { help: true, error: !!errors.rateOverride })}
                  />
                </Field>
              </div>
              <Field label={tr.use} htmlFor="rule-use" help={tr.useHelp}>
                <Controller
                  control={form.control}
                  name="appliesToUse"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="rule-use" aria-label={tr.use}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TAX_USES.map((use) => (
                          <SelectItem key={use} value={use}>
                            {t.uses[use]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
            </>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={tr.effectiveFrom} htmlFor="rule-from" help={tr.effectiveFromHelp} error={errors.effectiveFrom?.message}>
              <Input id="rule-from" type="date" {...form.register('effectiveFrom')} aria-invalid={!!errors.effectiveFrom} />
            </Field>
            <Field label={tr.effectiveTo} htmlFor="rule-to" error={errors.effectiveTo?.message}>
              <Input id="rule-to" type="date" {...form.register('effectiveTo')} aria-invalid={!!errors.effectiveTo} />
            </Field>
          </div>

          <Field label={tr.notes} htmlFor="rule-notes" error={errors.notes?.message}>
            <Textarea id="rule-notes" rows={2} {...form.register('notes')} />
          </Field>

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
