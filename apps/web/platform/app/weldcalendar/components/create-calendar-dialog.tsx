
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { useCreateUserCalendar, useUpdateUserCalendar } from '@/hooks/queries/use-calendar-queries';
import { getTranslations } from '@/lib/i18n';
import { useEffect, useId, useMemo } from 'react';

/** Swatch colours, each with the i18n key of its accessible name. */
const CALENDAR_COLORS = [
  { value: '#3b82f6', name: 'blue' },
  { value: '#ef4444', name: 'red' },
  { value: '#22c55e', name: 'green' },
  { value: '#f59e0b', name: 'amber' },
  { value: '#8b5cf6', name: 'violet' },
  { value: '#ec4899', name: 'pink' },
  { value: '#06b6d4', name: 'cyan' },
  { value: '#f97316', name: 'orange' },
  { value: '#14b8a6', name: 'teal' },
  { value: '#6366f1', name: 'indigo' },
] as const;

/** `nameRequired` is the translated message. The name is trimmed: only spaces is as empty as nothing. */
const buildSchema = (nameRequired: string) =>
  z.object({
    name: z.string().trim().min(1, nameRequired).max(255),
    color: z.string().optional(),
  });

type FormValues = z.infer<ReturnType<typeof buildSchema>>;

interface CreateCalendarDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, the dialog edits this calendar instead of creating one. */
  editCalendar?: { id: string; name: string; color?: string | null } | null;
}

export function CreateCalendarDialog({ open, onOpenChange, editCalendar }: Readonly<CreateCalendarDialogProps>) {
  const createCalendar = useCreateUserCalendar();
  const updateCalendar = useUpdateUserCalendar();
  const t = getTranslations('weldcalendar');
  const isEdit = !!editCalendar;

  const schema = useMemo(() => buildSchema(t.createCalendar.nameRequired), [t.createCalendar.nameRequired]);
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', color: '#3b82f6' },
  });

  // Sync the form with the calendar being edited each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    form.reset(
      editCalendar
        ? { name: editCalendar.name, color: editCalendar.color || '#3b82f6' }
        : { name: '', color: '#3b82f6' },
    );
  }, [open, editCalendar, form]);

  const isPending = createCalendar.isPending || updateCalendar.isPending;
  const selectedColor = form.watch('color');
  // Without a name there is nothing to create: the button stays off instead of doing nothing.
  const nameIsEmpty = !form.watch('name')?.trim();
  const colorLabelId = useId();

  let submitLabel: string;
  if (isEdit) {
    submitLabel = isPending ? t.createCalendar.saving : t.createCalendar.save;
  } else {
    submitLabel = isPending ? t.createCalendar.creating : t.createCalendar.create;
  }

  const onSubmit = async (values: FormValues) => {
    if (editCalendar) {
      await updateCalendar.mutateAsync({ id: editCalendar.id, data: values });
    } else {
      await createCalendar.mutateAsync(values);
    }
    form.reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.createCalendar.editTitle : t.createCalendar.title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cal-name">{t.createCalendar.nameLabel}</Label>
            <Input id="cal-name" placeholder={t.createCalendar.namePlaceholder} {...form.register('name')} />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label id={colorLabelId}>{t.createCalendar.colorLabel}</Label>
            <div className="flex justify-between" role="group" aria-labelledby={colorLabelId}>
              {CALENDAR_COLORS.map(({ value, name }) => {
                const selected = selectedColor === value;
                return (
                  <Button
                    key={value}
                    type="button"
                    variant="ghost"
                    aria-label={t.createCalendar.colorNames[name]}
                    aria-pressed={selected}
                    onClick={() => form.setValue('color', value)}
                    className={`w-7 h-7 rounded-md border-2 transition-transform focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                      selected ? 'border-foreground scale-110' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: value }}
                  />
                );
              })}
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t.createCalendar.cancel}</Button>
            <Button type="submit" disabled={isPending || nameIsEmpty}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
