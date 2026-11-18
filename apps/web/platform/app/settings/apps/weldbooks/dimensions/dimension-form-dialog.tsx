import { useEffect, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useCreateDimensionValue, useUpdateDimensionValue } from '@/hooks/queries/use-accounting-queries';
import type { DimensionKind, DimensionValue } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { descendantIds } from './dimension-tree';

const NO_PARENT = '__none__';

function createSchema(messages: { nameRequired: string }) {
  return z.object({
    name: z.string().trim().min(1, messages.nameRequired).max(255),
    code: z.string().trim().max(30),
    parentId: z.string(),
    isActive: z.boolean(),
  });
}

type FormValues = z.infer<ReturnType<typeof createSchema>>;

interface DimensionFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dimension: DimensionKind;
  /** The value being edited; absent when adding one. */
  value?: DimensionValue | null;
  /** Every value of the dimension, for the parent select. */
  values: readonly DimensionValue[];
}

/** Add or edit a class or a location. */
export function DimensionFormDialog({ open, onOpenChange, dimension, value, values }: Readonly<DimensionFormDialogProps>) {
  const { t } = useI18n();
  const td = t.weldbooksUs.setup.dimensions;
  const createValue = useCreateDimensionValue();
  const updateValue = useUpdateDimensionValue();
  const schema = useMemo(() => createSchema({ nameRequired: td.nameRequired }), [td.nameRequired]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', code: '', parentId: NO_PARENT, isActive: true },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({
      name: value?.name ?? '',
      code: value?.code ?? '',
      parentId: value?.parentId ?? NO_PARENT,
      isActive: value?.isActive ?? true,
    });
    // Reset only when the dialog opens for another value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value?.id]);

  // A value can't sit under itself or under one of its own children.
  const parentOptions = useMemo(() => {
    const blocked = value ? new Set([value.id, ...descendantIds(values, value.id)]) : new Set<string>();
    return values.filter((v) => !blocked.has(v.id) && v.isActive);
  }, [values, value]);
  // The current parent stays selectable even when it has been deactivated since.
  const currentParent = value?.parentId ? values.find((v) => v.id === value.parentId) : undefined;
  const options = currentParent && !currentParent.isActive ? [...parentOptions, currentParent] : parentOptions;

  const pending = createValue.isPending || updateValue.isPending;

  const submit = async (values: FormValues) => {
    const data = {
      name: values.name.trim(),
      code: values.code.trim() || null,
      parentId: values.parentId === NO_PARENT ? null : values.parentId,
      isActive: values.isActive,
    };
    try {
      if (value) {
        await updateValue.mutateAsync({ id: value.id, data });
        toast.success(td.updated);
      } else {
        await createValue.mutateAsync({ dimension, ...data });
        toast.success(td.created);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(td.saveFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const title = value
    ? dimension === 'class' ? td.editClass : td.editLocation
    : dimension === 'class' ? td.addClass : td.addLocation;
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={form.handleSubmit(submit)} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{dimension === 'class' ? td.classHelp : td.locationHelp}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="dimension-name">{td.name} *</Label>
            <Input
              id="dimension-name"
              autoFocus
              aria-invalid={errors.name ? true : undefined}
              {...form.register('name')}
            />
            {errors.name ? <p className="text-sm text-destructive">{errors.name.message}</p> : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="dimension-code">{td.code}</Label>
            <Input id="dimension-code" aria-describedby="dimension-code-help" {...form.register('code')} />
            <p id="dimension-code-help" className="text-xs text-muted-foreground">{td.codeHelp}</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="dimension-parent">{td.parent}</Label>
            <Controller
              control={form.control}
              name="parentId"
              render={({ field }) => (
                <Select
                  value={field.value}
                  // The select reports "" while its options load; nobody can choose it.
                  onValueChange={(next) => {
                    if (next) field.onChange(next);
                  }}
                >
                  <SelectTrigger id="dimension-parent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    <SelectItem value={NO_PARENT}>{td.noParent}</SelectItem>
                    {options.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.code ? `${option.code} · ${option.name}` : option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {value ? (
            <div className="flex items-start justify-between gap-4">
              <div>
                <Label htmlFor="dimension-active">{td.active}</Label>
                <p className="text-xs text-muted-foreground">{td.activeHelp}</p>
              </div>
              <Controller
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <Switch id="dimension-active" checked={field.value} onCheckedChange={field.onChange} />
                )}
              />
            </div>
          ) : null}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              {td.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? td.saving : td.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
