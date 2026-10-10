/**
 * One employee's inputs for a pay run: what was collected from attendance,
 * leave, sick reports and declarations, and the one-off entries added by hand
 * (bonus, overtime, a deduction…). Editing a collected entry turns it into a
 * manual one, which "Collect" then leaves alone.
 */

import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form } from '@weldsuite/ui/components/form';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@weldsuite/ui/components/sheet';
import { useTranslations } from '@weldsuite/i18n/client';
import { componentDef, componentsFor } from '@weldsuite/payroll-domain/components';
import type { HrPayRunDetail, HrPayRunInput } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { createHrPayRunInputSchema } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useCreateHrPayRunInput,
  useDeleteHrPayRunInput,
  useHrPayRunInputs,
  useUpdateHrPayRunInput,
} from '@/hooks/queries/use-weldhr-payroll-queries';
import { EmptyText } from '../../components/page-kit';
import { ErrorBanner, errorMessage, formatDate } from '../../components/shared';
import { formatDecimal, formatQuantity } from '../lib/format';
import { usePayrollLabels } from '../lib/use-payroll-labels';
import { NumberField, SelectField, TextField } from './form-fields';
import { IssueList } from './payroll-ui';

type Values = z.input<typeof createHrPayRunInputSchema>;

export function RunInputsSheet({
  run,
  employeeId,
  employeeName,
  editable,
  onClose,
}: Readonly<{
  run: HrPayRunDetail;
  employeeId: string;
  employeeName: string;
  /** Draft or calculated, and the caller may prepare payroll. */
  editable: boolean;
  onClose: () => void;
}>) {
  const t = useTranslations();
  const labels = usePayrollLabels();
  const { data: inputs, isLoading, error } = useHrPayRunInputs(run.id, { employeeId });
  const deleteInput = useDeleteHrPayRunInput();

  const [dialog, setDialog] = useState<{ input: HrPayRunInput | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HrPayRunInput | null>(null);

  const issues = run.employees.find((employee) => employee.employeeId === employeeId)?.issues ?? [];

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t('weldhr.payroll.inputs.title', { name: employeeName })}</SheetTitle>
          <SheetDescription>{t('weldhr.payroll.inputs.description')}</SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-6">
          {issues.length > 0 && <IssueList issues={issues} currency={run.currency} />}
          <ErrorBanner error={error ? errorMessage(error, t('weldhr.payroll.inputs.loadFailed')) : null} />

          {editable && (
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setDialog({ input: null })}>
                <Plus className="mr-1.5 h-4 w-4" />
                {t('weldhr.payroll.inputs.add')}
              </Button>
            </div>
          )}

          {isLoading && (
            <div className="flex justify-center py-10">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {inputs && inputs.length === 0 && <EmptyText>{t('weldhr.payroll.inputs.empty')}</EmptyText>}

          {inputs && inputs.length > 0 && (
            <ul className="divide-y rounded-md border">
              {inputs.map((input) => {
                const manual = input.source === 'manual';
                const name = input.label ?? labels.component(input.code);
                return (
                  <li key={input.id} className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{name}</span>
                        <Badge variant={manual ? 'outline' : 'secondary'}>{t(`weldhr.payroll.inputSource.${input.source}`)}</Badge>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {[
                          input.quantity ? `${formatQuantity(input.quantity)} ${t(`weldhr.payroll.inputs.unit.${componentDef(input.code)?.entry ?? 'amount'}`)}`.trim() : null,
                          input.rate ? t('weldhr.payroll.inputs.rateLine', { rate: formatQuantity(input.rate) }) : null,
                          input.workDate ? formatDate(input.workDate) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                      {input.notes && <p className="text-xs text-muted-foreground">{input.notes}</p>}
                      {!manual && <p className="text-xs text-muted-foreground">{t('weldhr.payroll.inputs.collectedHint')}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {input.amount !== null && <span className="mr-1 tabular-nums">{formatDecimal(input.amount, run.currency)}</span>}
                      {editable && (
                        <>
                          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t('weldhr.common.edit')} onClick={() => setDialog({ input })}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={t('weldhr.common.delete')} onClick={() => setDeleteTarget(input)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {dialog && <InputDialog run={run} employeeId={employeeId} input={dialog.input} onClose={() => setDialog(null)} />}

        <ConfirmDialog
          open={Boolean(deleteTarget)}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title={t('weldhr.payroll.inputs.deleteTitle')}
          description={t('weldhr.payroll.inputs.deleteDescription')}
          variant="destructive"
          confirmLabel={t('weldhr.common.delete')}
          cancelLabel={t('weldhr.common.cancel')}
          onConfirm={async () => {
            if (!deleteTarget) return;
            try {
              await deleteInput.mutateAsync({ runId: run.id, inputId: deleteTarget.id });
              setDeleteTarget(null);
            } catch (err) {
              toast.error(errorMessage(err, t('weldhr.payroll.inputs.deleteFailed')));
            }
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Add / edit a one-off input
// ---------------------------------------------------------------------------

function InputDialog({
  run,
  employeeId,
  input,
  onClose,
}: Readonly<{ run: HrPayRunDetail; employeeId: string; input: HrPayRunInput | null; onClose: () => void }>) {
  const t = useTranslations();
  const labels = usePayrollLabels();
  const createInput = useCreateHrPayRunInput();
  const updateInput = useUpdateHrPayRunInput();
  const saving = createInput.isPending || updateInput.isPending;

  const options = componentsFor(run.country, 'oneOff').map((def) => ({ value: def.code, label: labels.component(def.code) }));

  const form = useForm<Values, unknown, z.output<typeof createHrPayRunInputSchema>>({
    resolver: zodResolver(createHrPayRunInputSchema),
    defaultValues: {
      employeeId,
      code: input?.code ?? '',
      label: input?.label ?? null,
      quantity: input?.quantity === null || input?.quantity === undefined ? null : Number(input.quantity),
      rate: input?.rate === null || input?.rate === undefined ? null : Number(input.rate),
      amount: input?.amount === null || input?.amount === undefined ? null : Number(input.amount),
      workDate: input?.workDate ?? null,
      notes: input?.notes ?? null,
    },
  });
  const code = useWatch({ control: form.control, name: 'code' });
  const entry = componentDef(code)?.entry ?? null;
  const failure = form.formState.errors.root?.message ?? null;

  async function onSubmit(values: z.output<typeof createHrPayRunInputSchema>) {
    // Only the fields the entry type uses are sent, so switching type does not leave stale numbers behind.
    const fields = {
      label: values.label ?? null,
      quantity: entry === 'hours' || entry === 'days' ? (values.quantity ?? null) : null,
      rate: entry === 'hours' ? (values.rate ?? null) : null,
      amount: entry === 'amount' ? (values.amount ?? null) : null,
      workDate: entry === 'hours' || entry === 'days' ? (values.workDate ?? null) : null,
      notes: values.notes ?? null,
    };
    try {
      if (input) await updateInput.mutateAsync({ runId: run.id, inputId: input.id, ...fields });
      else await createInput.mutateAsync({ runId: run.id, employeeId, code: values.code, ...fields });
      onClose();
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.inputs.saveFailed')) });
    }
  }

  let rateLabel = t('weldhr.payroll.inputs.rate.default');
  if (code === 'hours.overtime' || code === 'nl.sick_pay') rateLabel = t('weldhr.payroll.inputs.rate.percent');

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{input ? t('weldhr.payroll.inputs.editTitle') : t('weldhr.payroll.inputs.addTitle')}</DialogTitle>
          <DialogDescription>{t('weldhr.payroll.inputs.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} />

            <SelectField
              control={form.control}
              name="code"
              label={t('weldhr.payroll.inputs.type')}
              options={options}
              disabled={Boolean(input)}
              placeholder={t('weldhr.payroll.inputs.typePlaceholder')}
            />

            {entry && (
              <>
                {(entry === 'hours' || entry === 'days') && (
                  <div className="grid grid-cols-2 gap-3">
                    <NumberField
                      control={form.control}
                      name="quantity"
                      label={entry === 'hours' ? t('weldhr.payroll.inputs.hours') : t('weldhr.payroll.inputs.days')}
                    />
                    {entry === 'hours' && <NumberField control={form.control} name="rate" label={rateLabel} />}
                  </div>
                )}
                {entry === 'amount' && (
                  <NumberField control={form.control} name="amount" label={t('weldhr.payroll.inputs.amount', { currency: run.currency })} />
                )}
                {(entry === 'hours' || entry === 'days') && (
                  <TextField control={form.control} name="workDate" label={t('weldhr.payroll.inputs.workDate')} type="date" />
                )}
                <TextField control={form.control} name="label" label={t('weldhr.payroll.inputs.label')} description={t('weldhr.payroll.inputs.labelHint')} maxLength={160} />
                <TextField control={form.control} name="notes" label={t('weldhr.payroll.common.notes')} multiline maxLength={1000} />
              </>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={saving || !entry}>
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
