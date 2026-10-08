/** My HR → request leave: type, dates and an optional reason. */

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
import type { HrSelfLeave } from '@weldsuite/app-api-client/domains/weldhr';
import { useMyHrRequestLeave } from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, errorMessage, todayIso } from '../../components/shared';
import { ColorDot } from './shared';

function buildSchema(t: (path: string) => string) {
  const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, t('weldhr.me.leave.form.errors.date'));
  return z
    .object({
      leaveTypeId: z.string().min(1, t('weldhr.me.leave.form.errors.type')),
      startDate: isoDate,
      endDate: isoDate,
      reason: z.string().max(2000, t('weldhr.me.leave.form.errors.reason')),
    })
    .refine((values) => values.endDate >= values.startDate, {
      path: ['endDate'],
      message: t('weldhr.me.leave.form.errors.endBeforeStart'),
    });
}

type FormValues = z.infer<ReturnType<typeof buildSchema>>;

export function LeaveRequestDialog({
  types,
  onClose,
}: Readonly<{
  types: HrSelfLeave['types'];
  onClose: () => void;
}>) {
  const t = useTranslations();
  const requestLeave = useMyHrRequestLeave();
  const [failure, setFailure] = useState<string | null>(null);
  const schema = useMemo(() => buildSchema(t), [t]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { leaveTypeId: '', startDate: todayIso(), endDate: todayIso(), reason: '' },
  });

  const selectedType = types.find((type) => type.id === form.watch('leaveTypeId'));
  const startDate = form.watch('startDate');
  const isSubmitting = requestLeave.isPending;

  async function onSubmit(values: FormValues) {
    setFailure(null);
    try {
      await requestLeave.mutateAsync({
        leaveTypeId: values.leaveTypeId,
        startDate: values.startDate,
        endDate: values.endDate,
        reason: values.reason.trim() || null,
      });
      toast.success(t('weldhr.me.leave.form.requestedToast'));
      onClose();
    } catch (err) {
      const message = errorMessage(err, t('weldhr.me.leave.form.failed'));
      setFailure(message.toLowerCase().includes('overlap') ? t('weldhr.me.leave.form.overlap') : message);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !isSubmitting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('weldhr.me.leave.form.title')}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

            <FormField
              control={form.control}
              name="leaveTypeId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('weldhr.me.leave.form.type')}</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={t('weldhr.me.leave.form.selectType')} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {types.map((type) => (
                        <SelectItem key={type.id} value={type.id}>
                          <span className="flex items-center gap-2">
                            <ColorDot color={type.color} />
                            {type.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedType && (
                    <FormDescription>
                      {selectedType.requiresApproval
                        ? t('weldhr.me.leave.form.needsApproval')
                        : t('weldhr.me.leave.form.autoApproved')}
                    </FormDescription>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="startDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.me.leave.form.startDate')}</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t('weldhr.me.leave.form.endDate')}</FormLabel>
                    <FormControl>
                      <Input type="date" min={startDate || undefined} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('weldhr.me.leave.form.reason')}</FormLabel>
                  <FormControl>
                    <Textarea rows={3} placeholder={t('weldhr.me.leave.form.reasonPlaceholder')} {...field} />
                  </FormControl>
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
                {isSubmitting ? t('weldhr.me.leave.form.submitting') : t('weldhr.me.leave.form.submit')}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
