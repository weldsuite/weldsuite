/** Create/edit dialog for an announcement: title, message, pin, audience and (on create) the push notification. */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { MultiSelect } from '@weldsuite/ui/components/multi-select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTranslations } from '@weldsuite/i18n/client';
import { createHrAnnouncementSchema, type CreateHrAnnouncementInput } from '@weldsuite/app-api-client/schemas/weldhr';
import type { HrAnnouncement } from '@weldsuite/app-api-client/domains/weldhr';
import { useCreateHrAnnouncement, useHrDepartments, useUpdateHrAnnouncement } from '@/hooks/queries/use-weldhr-queries';
import { ErrorBanner, errorMessage } from '../../components/shared';

export function AnnouncementDialog({ announcement, onClose }: Readonly<{ announcement?: HrAnnouncement; onClose: () => void }>) {
  const t = useTranslations();
  const createAnnouncement = useCreateHrAnnouncement();
  const updateAnnouncement = useUpdateHrAnnouncement();
  const { data: departments } = useHrDepartments();
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<CreateHrAnnouncementInput>({
    resolver: zodResolver(createHrAnnouncementSchema),
    mode: 'onChange',
    defaultValues: {
      title: announcement?.title ?? '',
      body: announcement?.body ?? '',
      pinned: announcement?.pinned ?? false,
      departmentIds: announcement?.departmentIds ?? [],
      notify: false,
    },
  });
  const pending = createAnnouncement.isPending || updateAnnouncement.isPending;

  async function onSubmit(values: CreateHrAnnouncementInput) {
    setFailure(null);
    try {
      if (announcement) {
        // The push goes out once, when the announcement is created.
        await updateAnnouncement.mutateAsync({
          id: announcement.id,
          title: values.title,
          body: values.body,
          pinned: values.pinned,
          departmentIds: values.departmentIds,
        });
      } else {
        await createAnnouncement.mutateAsync(values);
      }
      onClose();
    } catch (err) {
      setFailure(errorMessage(err, t('weldhr.announcements.form.failed')));
    }
  }

  let submitLabel: string;
  if (pending) submitLabel = t('weldhr.announcements.form.saving');
  else if (announcement) submitLabel = t('weldhr.announcements.form.save');
  else submitLabel = t('weldhr.announcements.form.create');

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{announcement ? t('weldhr.announcements.editTitle') : t('weldhr.announcements.addTitle')}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('weldhr.announcements.form.title')}</FormLabel>
                  <FormControl>
                    <Input {...field} maxLength={200} placeholder={t('weldhr.announcements.form.titlePlaceholder')} autoFocus />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="body"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('weldhr.announcements.form.body')}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={8} maxLength={20000} placeholder={t('weldhr.announcements.form.bodyPlaceholder')} />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="departmentIds"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t('weldhr.announcements.form.audience')}</FormLabel>
                  <FormControl>
                    <MultiSelect
                      modal
                      options={(departments ?? []).map((department) => ({ value: department.id, label: department.name }))}
                      value={field.value ?? []}
                      onChange={field.onChange}
                      placeholder={t('weldhr.announcements.everyone')}
                      searchPlaceholder={t('weldhr.announcements.form.searchDepartments')}
                      emptyText={t('weldhr.announcements.form.noDepartments')}
                    />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">{t('weldhr.announcements.form.audienceHint')}</p>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="pinned"
              render={({ field }) => (
                <FormItem className="flex items-start justify-between gap-4 rounded-md border p-3">
                  <div className="space-y-1">
                    <FormLabel>{t('weldhr.announcements.form.pinned')}</FormLabel>
                    <p className="text-xs text-muted-foreground">{t('weldhr.announcements.form.pinnedHint')}</p>
                  </div>
                  <FormControl>
                    <Switch checked={field.value ?? false} onCheckedChange={field.onChange} />
                  </FormControl>
                </FormItem>
              )}
            />

            {!announcement && (
              <FormField
                control={form.control}
                name="notify"
                render={({ field }) => (
                  <FormItem className="flex items-start gap-3 rounded-md border p-3">
                    <FormControl>
                      <Checkbox checked={field.value ?? false} onCheckedChange={(checked) => field.onChange(checked === true)} className="mt-0.5" />
                    </FormControl>
                    <div className="space-y-1">
                      <FormLabel>{t('weldhr.announcements.form.notify')}</FormLabel>
                      <p className="text-xs text-muted-foreground">{t('weldhr.announcements.form.notifyHint')}</p>
                    </div>
                  </FormItem>
                )}
              />
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                {t('weldhr.announcements.form.cancel')}
              </Button>
              <Button type="submit" disabled={!form.formState.isValid || pending}>
                {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
