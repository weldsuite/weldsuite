/** Record that a filing was filed by hand (US returns, or a Dutch loonaangifte sent outside WeldSuite). */

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form } from '@weldsuite/ui/components/form';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrPayrollFiling } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { markHrPayrollFilingFiledSchema } from '@weldsuite/app-api-client/schemas/weldhr-payroll';
import { useMarkHrPayrollFilingFiled } from '@/hooks/queries/use-weldhr-payroll-queries';
import { ErrorBanner, errorMessage, todayIso } from '../../components/shared';
import { TextField } from './form-fields';

type Values = z.input<typeof markHrPayrollFilingFiledSchema>;

export function MarkFiledDialog({ filing, onClose }: Readonly<{ filing: HrPayrollFiling; onClose: () => void }>) {
  const t = useTranslations();
  const markFiled = useMarkHrPayrollFilingFiled();
  const form = useForm<Values, unknown, z.output<typeof markHrPayrollFilingFiledSchema>>({
    resolver: zodResolver(markHrPayrollFilingFiledSchema),
    defaultValues: { externalReference: null, filedOn: todayIso() },
  });
  const failure = form.formState.errors.root?.message ?? null;

  async function onSubmit(values: z.output<typeof markHrPayrollFilingFiledSchema>) {
    try {
      await markFiled.mutateAsync({ id: filing.id, externalReference: values.externalReference ?? null, filedOn: values.filedOn });
      toast.success(t('weldhr.payroll.filings.markedFiled'));
      onClose();
    } catch (err) {
      form.setError('root', { message: errorMessage(err, t('weldhr.payroll.filings.markFiledFailed')) });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !markFiled.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('weldhr.payroll.filings.markFiled.title')}</DialogTitle>
          <DialogDescription>{t('weldhr.payroll.filings.markFiled.description')}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} />
            <TextField
              control={form.control}
              name="externalReference"
              label={t('weldhr.payroll.filings.markFiled.reference')}
              description={t('weldhr.payroll.filings.markFiled.referenceHint')}
              maxLength={120}
            />
            <TextField control={form.control} name="filedOn" label={t('weldhr.payroll.filings.markFiled.filedOn')} type="date" emptyAs="undefined" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={markFiled.isPending}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={markFiled.isPending}>
                {markFiled.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('weldhr.payroll.filings.actions.markFiled')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
