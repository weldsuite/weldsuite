
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
import { useEffect } from 'react';

const CALENDAR_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#6366f1',
];

const schema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  color: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

interface CreateCalendarDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, the dialog edits this calendar instead of creating one. */
  editCalendar?: { id: string; name: string; color?: string | null } | null;
}

export function CreateCalendarDialog({ open, onOpenChange, editCalendar }: CreateCalendarDialogProps) {
  const createCalendar = useCreateUserCalendar();
  const updateCalendar = useUpdateUserCalendar();
  const t = getTranslations('weldcalendar');
  const isEdit = !!editCalendar;

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
            <Label>{t.createCalendar.colorLabel}</Label>
            <div className="flex justify-between">
              {CALENDAR_COLORS.map((color) => (
                <Button
                  key={color}
                  type="button"
                  variant="ghost"
                  onClick={() => form.setValue('color', color)}
                  className={`w-7 h-7 rounded-md border-2 transition-transform ${
                    form.watch('color') === color ? 'border-foreground scale-110' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>

          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t.createCalendar.cancel}</Button>
            <Button type="submit" disabled={isPending}>
              {isEdit
                ? (isPending ? t.createCalendar.saving : t.createCalendar.save)
                : (isPending ? t.createCalendar.creating : t.createCalendar.create)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
