/**
 * A recurring pay component of an employee: a fixed allowance, a pension
 * contribution, a company car, a 401(k) deferral… The catalog says which
 * components exist per country and which parameters each one takes.
 */

import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form } from '@weldsuite/ui/components/form';
import { useTranslations } from '@weldsuite/i18n/client';
import { componentDef, componentsFor, type ComponentParamDef } from '@weldsuite/payroll-domain/components';
import type { HrPayComponent, HrPayrollCountry } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { createHrPayComponentSchema } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { useCreateHrPayComponent, useUpdateHrPayComponent } from '@/hooks/queries/use-weldhr-payroll-queries';
import { ErrorBanner, errorMessage, todayIso } from '../../components/shared';
import { NumberField, SelectField, SwitchField, TextField } from '../components/form-fields';
import { usePayrollLabels } from '../lib/use-payroll-labels';

type Values = z.input<typeof createHrPayComponentSchema>;
type Parsed = z.output<typeof createHrPayComponentSchema>;

export function ComponentDialog({
  employeeId,
  country,
  currency,
  component,
  onClose,
}: Readonly<{ employeeId: string; country: HrPayrollCountry; currency: string; component: HrPayComponent | null; onClose: () => void }>) {
  const t = useTranslations();
  const labels = usePayrollLabels();
  const create = useCreateHrPayComponent();
  const update = useUpdateHrPayComponent();
  const saving = create.isPending || update.isPending;

  const form = useForm<Values, unknown, Parsed>({
    resolver: zodResolver(createHrPayComponentSchema),
    defaultValues: {
      code: component?.code ?? '',
      label: component?.label ?? null,
      amount: component?.amount === null || component?.amount === undefined ? null : Number(component.amount),
      params: component?.params ?? {},
      effectiveFrom: component?.effectiveFrom ?? todayIso(),
      effectiveTo: component?.effectiveTo ?? null,
    },
  });
  const code = useWatch({ control: form.control, name: 'code' });
  const def = componentDef(code);
  const failure = form.formState.errors.root?.message ?? null;

  const options = componentsFor(country, 'recurring').map((candidate) => ({ value: candidate.code, label: labels.component(candidate.code) }));

  async function onSubmit(values: Parsed) {
    // Required parameters are part of the catalog, not of the shared schema.
    let missing = false;
    for (const param of def?.params ?? []) {
      if (param.required && (values.params?.[param.key] === null || values.params?.[param.key] === undefined || values.params?.[param.key] === '')) {
        form.setError(`params.${param.key}`, { message: t('weldhr.payroll.employee.components.paramRequired') });
        missing = true;
      }
    }
    if (missing) return;

    // Only the parameters this component takes are kept.
    const allowed = new Set((def?.params ?? []).map((param) => param.key));
    const params = Object.fromEntries(Object.entries(values.params ?? {}).filter(([key, value]) => allowed.has(key) && value !== null && value !== ''));
    const fields = {
      label: values.label ?? null,
      amount: def?.entry === 'params' ? null : (values.amount ?? null),
      params,
      effectiveFrom: values.effectiveFrom,
      effectiveTo: values.effectiveTo ?? null,
    };
    try {
      if (component) await update.mutateAsync({ id: component.id, ...fields });
      else await create.mutateAsync({ employeeId, code: values.code, ...fields });
      toast.success(t('weldhr.payroll.employee.components.saved'));
      onClose();
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.employee.components.saveFailed')) });
    }
  }

  function renderParam(param: ComponentParamDef) {
    const name = `params.${param.key}` as const;
    const label = `${t(`weldhr.payroll.params.${param.key}`)}${param.required ? ' *' : ''}`;
    switch (param.type) {
      case 'boolean':
        return <SwitchField key={param.key} control={form.control} name={name} label={label} />;
      case 'date':
        return <TextField key={param.key} control={form.control} name={name} label={label} type="date" />;
      case 'percent':
        return <NumberField key={param.key} control={form.control} name={name} label={`${label} (%)`} />;
      case 'money':
        return <NumberField key={param.key} control={form.control} name={name} label={`${label} (${currency})`} />;
      default:
        return <NumberField key={param.key} control={form.control} name={name} label={label} />;
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{component ? t('weldhr.payroll.employee.components.editTitle') : t('weldhr.payroll.employee.components.addTitle')}</DialogTitle>
          <DialogDescription>{t('weldhr.payroll.employee.components.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} />
            <SelectField control={form.control} name="code" label={t('weldhr.payroll.employee.components.type')} options={options} disabled={Boolean(component)} placeholder={t('weldhr.payroll.inputs.typePlaceholder')} />

            {def && (
              <>
                {def.entry !== 'params' && (
                  <NumberField
                    control={form.control}
                    name="amount"
                    label={t('weldhr.payroll.employee.components.amount', { currency })}
                    description={def.params && def.params.length > 0 ? t('weldhr.payroll.employee.components.amountOrParams') : t('weldhr.payroll.employee.components.amountHint')}
                  />
                )}
                {def.params && def.params.length > 0 && <div className="grid gap-3 sm:grid-cols-2">{def.params.map(renderParam)}</div>}
                <TextField control={form.control} name="label" label={t('weldhr.payroll.inputs.label')} description={t('weldhr.payroll.inputs.labelHint')} maxLength={160} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField control={form.control} name="effectiveFrom" label={t('weldhr.payroll.employee.components.effectiveFrom')} type="date" emptyAs="string" />
                  <TextField control={form.control} name="effectiveTo" label={t('weldhr.payroll.employee.components.effectiveTo')} type="date" />
                </div>
              </>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={saving || !def}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('weldhr.common.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
