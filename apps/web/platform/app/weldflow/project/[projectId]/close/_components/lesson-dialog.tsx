import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { Lesson, LessonCategory } from '@weldsuite/app-api-client/domains/project-closing';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateLesson, useUpdateLesson } from '@/hooks/queries/use-project-closing-queries';
import { LESSON_COLUMNS } from '../_lib/close';
import { apiMessage } from '../_lib/api-error';
import { closingResolverOptions, lessonFormSchema, type LessonFormValues } from '../_lib/form';
import { useClose } from './close-context';

export type LessonDialogState = { mode: 'create'; category: LessonCategory } | { mode: 'edit'; lesson: Lesson };

function LessonForm({ state, onClose }: Readonly<{ state: LessonDialogState; onClose: () => void }>) {
  const { t, format } = useI18n();
  const copy = t.flowClosing.close.lessons;
  const { projectId } = useClose();
  const create = useCreateLesson();
  const update = useUpdateLesson();
  const options = useMemo(() => closingResolverOptions(t.flowClosing.shared.validation, format), [t, format]);
  const edit = state.mode === 'edit' ? state.lesson : null;
  const form = useForm<LessonFormValues>({
    resolver: zodResolver(lessonFormSchema, options),
    defaultValues: edit ? { category: edit.category, text: edit.text } : { category: state.mode === 'create' ? state.category : 'went_well', text: '' },
  });
  const pending = create.isPending || update.isPending;

  const submit = async (values: LessonFormValues) => {
    try {
      if (edit) {
        await update.mutateAsync({ id: edit.id, data: values });
        toast.success(copy.dialog.updated);
      } else {
        await create.mutateAsync({ projectId, ...values });
        toast.success(copy.dialog.created);
      }
      onClose();
    } catch (error) {
      toast.error(apiMessage(error, edit ? copy.dialog.updateFailed : copy.dialog.createFailed));
    }
  };

  return (
    <Form {...form}>
      <form noValidate onSubmit={form.handleSubmit(submit)} className="space-y-4">
        <FormField
          control={form.control}
          name="category"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{copy.dialog.category}</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {LESSON_COLUMNS.map((category) => (
                    <SelectItem key={category} value={category}>
                      {copy.columns[category]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="text"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{copy.dialog.text}</FormLabel>
              <FormControl>
                <Textarea {...field} rows={5} placeholder={copy.dialog.textPlaceholder} autoFocus />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {t.flowClosing.shared.cancel}
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {pending ? copy.dialog.saving : edit ? copy.dialog.save : copy.dialog.submit}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

/** Add a lesson (category preselected) or edit one. */
export function LessonDialog({ state, onClose }: Readonly<{ state: LessonDialogState | null; onClose: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowClosing.close.lessons.dialog;
  return (
    <Dialog open={state !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        {state ? (
          <>
            <DialogHeader>
              <DialogTitle>{state.mode === 'edit' ? copy.editTitle : copy.createTitle}</DialogTitle>
              <DialogDescription>{copy.description}</DialogDescription>
            </DialogHeader>
            <LessonForm key={state.mode === 'edit' ? state.lesson.id : `new-${state.category}`} state={state} onClose={onClose} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
