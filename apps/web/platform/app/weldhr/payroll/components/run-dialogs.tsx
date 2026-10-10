/** Small dialogs of the pay run page: change the pay date and notes, and mark a run as paid. */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form } from '@weldsuite/ui/components/form';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayRunDetail } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { markHrPayRunPaidSchema, updateHrPayRunSchema } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { useMarkHrPayRunPaid, useUpdateHrPayRun } from '@/hooks/queries/use-weldhr-payroll-queries';
import { ErrorBanner, errorMessage, todayIso } from '../../components/shared';
import { TextField } from './form-fields';

type EditValues = z.input<typeof updateHrPayRunSchema>;
type PaidValues = z.input<typeof markHrPayRunPaidSchema>;

export function EditRunDialog({ run, onClose }: Readonly<{ run: HrPayRunDetail; onClose: () => void }>) {
  const t = useTranslations();
  const updateRun = useUpdateHrPayRun();
  const form = useForm<EditValues, unknown, z.output<typeof updateHrPayRunSchema>>({
    resolver: zodResolver(updateHrPayRunSchema),
    defaultValues: { payDate: run.payDate, notes: run.notes ?? null },
  });
  const failure = form.formState.errors.root?.message ?? null;

  async function onSubmit(values: z.output<typeof updateHrPayRunSchema>) {
    try {
      await updateRun.mutateAsync({ id: run.id, payDate: values.payDate, notes: values.notes ?? null });
      onClose();
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.run.editFailed')) });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !updateRun.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('weldhr.payroll.run.editTitle')}</DialogTitle>
          <DialogDescription>{t('weldhr.payroll.run.editDescription')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} />
            <TextField control={form.control} name="payDate" label={t('weldhr.payroll.common.payDate')} type="date" emptyAs="undefined" />
            <TextField control={form.control} name="notes" label={t('weldhr.payroll.common.notes')} multiline maxLength={2000} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={updateRun.isPending}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={updateRun.isPending}>
                {updateRun.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('weldhr.common.save')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export function MarkPaidDialog({ run, onClose }: Readonly<{ run: HrPayRunDetail; onClose: () => void }>) {
  const t = useTranslations();
  const markPaid = useMarkHrPayRunPaid();
  const form = useForm<PaidValues, unknown, z.output<typeof markHrPayRunPaidSchema>>({
    resolver: zodResolver(markHrPayRunPaidSchema),
    defaultValues: { paidOn: run.payDate <= todayIso() ? run.payDate : todayIso() },
  });
  const failure = form.formState.errors.root?.message ?? null;

  async function onSubmit(values: z.output<typeof markHrPayRunPaidSchema>) {
    try {
      await markPaid.mutateAsync({ id: run.id, paidOn: values.paidOn });
      onClose();
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.run.markPaidFailed')) });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !markPaid.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('weldhr.payroll.run.markPaidTitle')}</DialogTitle>
          <DialogDescription>{t('weldhr.payroll.run.markPaidDescription')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} />
            <TextField control={form.control} name="paidOn" label={t('weldhr.payroll.run.paidOn')} type="date" emptyAs="undefined" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={markPaid.isPending}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={markPaid.isPending}>
                {markPaid.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('weldhr.payroll.run.markPaid')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
