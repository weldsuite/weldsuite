/**
 * Report sick. One form, three uses: an employee reporting themselves
 * (`self`), HR filing a report for someone (`create`) and HR correcting one
 * (`edit`). Only HR picks the employee and can enter a last sick day here;
 * an employee closes their own report with "Report recovered".
 */

import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrAbsence } from '@weldsuite/app-api-client/domains/weldhr';
import { useCreateHrAbsence, useMyHrReportSick, useUpdateHrAbsence } from '@/hooks/queries/use-weldhr-queries';
import { EmployeePicker, ErrorBanner, todayIso } from '../../components/shared';
import { absenceFailure } from './shared';

type Mode = { kind: 'self' } | { kind: 'create' } | { kind: 'edit'; absence: HrAbsence };

function buildSchema(t: (path: string) => string, mode: Mode['kind']) {
  const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, t('weldhr.absenteeism.form.errors.date'));
  return z
    .object({
      employeeId: mode === 'create' ? z.string().min(1, t('weldhr.absenteeism.form.errors.employee')) : z.string(),
      startDate: isoDate,
      firstDay: z.enum(['full', 'half']),
      /** Empty while the employee is still absent. */
      endDate: z.union([z.literal(''), isoDate]),
      note: z.string().max(1000, t('weldhr.absenteeism.form.errors.note')),
    })
    .refine((values) => mode !== 'self' || values.startDate <= todayIso(), {
      path: ['startDate'],
      message: t('weldhr.absenteeism.form.errors.future'),
    })
    .refine((values) => !values.endDate || values.endDate >= values.startDate, {
      path: ['endDate'],
      message: t('weldhr.absenteeism.form.errors.endBeforeStart'),
    });
}

type FormValues = z.infer<ReturnType<typeof buildSchema>>;

export function AbsenceDialog({ mode, onClose }: Readonly<{ mode: Mode; onClose: () => void }>) {
  const t = useTranslations();
  const reportSick = useMyHrReportSick();
  const createAbsence = useCreateHrAbsence();
  const updateAbsence = useUpdateHrAbsence();
  const [failure, setFailure] = useState<string | null>(null);
  const [employeeLabel, setEmployeeLabel] = useState<string | null>(mode.kind === 'edit' ? mode.absence.employeeName : null);
  const schema = useMemo(() => buildSchema(t, mode.kind), [t, mode.kind]);
  const existing = mode.kind === 'edit' ? mode.absence : null;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      employeeId: existing?.employeeId ?? '',
      startDate: existing?.startDate ?? todayIso(),
      firstDay: existing?.firstDay ?? 'full',
      endDate: existing?.endDate ?? '',
      note: existing?.note ?? '',
    },
  });

  const startDate = form.watch('startDate');
  const isSubmitting = reportSick.isPending || createAbsence.isPending || updateAbsence.isPending;
  const isSelf = mode.kind === 'self';

  async function onSubmit(values: FormValues) {
    setFailure(null);
    const report = { startDate: values.startDate, firstDay: values.firstDay, note: values.note.trim() || null };
    try {
      if (mode.kind === 'self') {
        await reportSick.mutateAsync(report);
        toast.success(t('weldhr.absenteeism.form.reportedToast'));
      } else if (mode.kind === 'create') {
        await createAbsence.mutateAsync({ ...report, employeeId: values.employeeId, endDate: values.endDate || null });
      } else {
        await updateAbsence.mutateAsync({ ...report, id: mode.absence.id, endDate: values.endDate || null });
      }
      onClose();
    } catch (err) {
      setFailure(absenceFailure(err, t));
    }
  }

  let submitLabel = t(isSelf || mode.kind === 'create' ? 'weldhr.absenteeism.form.submit' : 'weldhr.absenteeism.form.save');
  if (isSubmitting) submitLabel = t(mode.kind === 'edit' ? 'weldhr.absenteeism.form.saving' : 'weldhr.absenteeism.form.submitting');

  return (
    <Dialog open onOpenChange={(open) => !open && !isSubmitting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(mode.kind === 'edit' ? 'weldhr.absenteeism.form.editTitle' : 'weldhr.absenteeism.form.reportTitle')}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

            {!isSelf && (
              <FormField
                control={form.control}
                name="employeeId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.absenteeism.form.employee')}</FormLabel>
                    <EmployeePicker
                      value={field.value || null}
                      valueLabel={employeeLabel}
                      disabled={mode.kind === 'edit'}
                      onChange={(id, label) => {
                        field.onChange(id ?? '');
                        setEmployeeLabel(label);
                      }}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="startDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('weldhr.absenteeism.form.firstSickDay')}</FormLabel>
                  <FormControl>
                    <Input type="date" max={isSelf ? todayIso() : undefined} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="firstDay"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('weldhr.absenteeism.form.firstDay')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="full">{t('weldhr.absenteeism.firstDay.full')}</SelectItem>
                      <SelectItem value="half">{t('weldhr.absenteeism.firstDay.half')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {!isSelf && (
              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.absenteeism.form.lastSickDay')}</FormLabel>
                    <FormControl>
                      <Input type="date" min={startDate || undefined} {...field} />
                    </FormControl>
                    <FormDescription>{t('weldhr.absenteeism.form.lastSickDayOpenHint')}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('weldhr.absenteeism.form.note')}</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder={isSelf ? t('weldhr.absenteeism.form.notePlaceholder') : undefined} {...field} />
                  </FormControl>
                  {isSelf && <FormDescription>{t('weldhr.absenteeism.form.noteHint')}</FormDescription>}
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                {t('weldhr.common.cancel')}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
