import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Popover as PopoverRoot,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { cn } from '@/lib/utils';
import { createCustomerStatusSchema } from '@weldsuite/core-api-client/schemas/customer-statuses';
import type { CustomerStatus } from '@weldsuite/core-api-client/schemas/customer-statuses';
import { COLOR_OPTIONS, COLOR_SWATCH_MAP } from '@/hooks/queries/use-weldcrm-customer-statuses';
import { useI18n } from '@/lib/i18n/provider';

type CreateValues = z.infer<typeof createCustomerStatusSchema>;

interface StatusFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status?: CustomerStatus;
  onSubmit: (values: CreateValues) => void;
  isPending: boolean;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function StatusFormDialog({
  open,
  onOpenChange,
  status,
  onSubmit,
  isPending,
}: StatusFormDialogProps) {
  const { t } = useI18n();
  const ts = t.crm.settings.customerStatuses;
  const isEdit = !!status;

  const form = useForm<CreateValues>({
    resolver: zodResolver(createCustomerStatusSchema),
    defaultValues: {
      name: status?.name ?? '',
      slug: status?.slug ?? '',
      color: status?.color ?? 'blue',
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: status?.name ?? '',
        slug: status?.slug ?? '',
        color: status?.color ?? 'blue',
      });
    }
  }, [open, status, form]);

  const nameValue = form.watch('name');
  const colorValue = form.watch('color');

  // Auto-derive slug from name only while the user hasn't manually changed it.
  useEffect(() => {
    if (!isEdit && nameValue) {
      const derived = slugify(nameValue);
      if (!form.formState.dirtyFields.slug) {
        form.setValue('slug', derived, { shouldValidate: false });
      }
    }
  }, [nameValue, isEdit, form]);

  const handleSubmit = form.handleSubmit((values) => {
    onSubmit(values);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? ts.editStatus : ts.addStatus}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="status-name">{ts.form.name}</Label>
            <Input
              id="status-name"
              {...form.register('name')}
              placeholder={ts.form.namePlaceholder}
              className="shadow-none"
            />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          {/* Slug */}
          <div className="space-y-1.5">
            <Label htmlFor="status-slug">{ts.form.slug}</Label>
            <Input
              id="status-slug"
              {...form.register('slug', {
                onChange: (e) => {
                  const next = (e.target.value as string).replace(/\s+/g, '_');
                  form.setValue('slug', next, { shouldDirty: true });
                },
              })}
              placeholder={ts.form.slugPlaceholder}
              className="shadow-none font-mono text-sm"
            />
            {form.formState.errors.slug ? (
              <p className="text-xs text-destructive">{form.formState.errors.slug.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{ts.form.slugHint}</p>
            )}
          </div>

          {/* Color */}
          <div className="space-y-1.5">
            <Label>{ts.form.color}</Label>
            <PopoverRoot>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="flex items-center gap-2 h-9 px-3 rounded-md border border-input bg-background text-sm hover:bg-accent transition-colors shadow-none"
                >
                  <span
                    className={cn(
                      'w-4 h-4 rounded-sm',
                      COLOR_SWATCH_MAP[colorValue] ?? 'bg-gray-400'
                    )}
                  />
                  <span className="capitalize">{colorValue}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-2" align="start">
                <div className="grid grid-cols-5 gap-1.5">
                  {COLOR_OPTIONS.map((c) => (
                    <Button
                      key={c}
                      type="button"
                      variant="ghost"
                      onClick={() => form.setValue('color', c, { shouldDirty: true })}
                      className={cn(
                        'w-7 h-7 rounded-md relative transition-all hover:scale-110 p-0',
                        COLOR_SWATCH_MAP[c],
                        colorValue === c && 'ring-2 ring-offset-1 ring-gray-900 dark:ring-gray-100'
                      )}
                      title={c}
                    >
                      {colorValue === c && (
                        <Check className="absolute inset-0 m-auto h-3 w-3 text-white" />
                      )}
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </PopoverRoot>
          </div>

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="shadow-none"
            >
              {ts.form.cancel}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isEdit ? ts.form.save : ts.form.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
