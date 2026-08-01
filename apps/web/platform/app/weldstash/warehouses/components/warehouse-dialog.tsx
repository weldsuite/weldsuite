import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import {
  createWarehouseSchema,
  type CreateWarehouseInput,
  type WeldstashWarehouse,
} from '@weldsuite/core-api-client/schemas/weldstash';
import {
  useCreateWeldstashWarehouse,
  useUpdateWeldstashWarehouse,
} from '@/hooks/queries/use-weldstash-queries';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Switch } from '@weldsuite/ui/components/switch';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

type FormValues = z.input<typeof createWarehouseSchema>;

export function WarehouseDialog({
  open,
  onOpenChange,
  warehouse,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  warehouse?: WeldstashWarehouse;
}) {
  const t = getTranslations('commerce').module;
  const ts = getTranslations('common');
  const isEdit = !!warehouse;
  const create = useCreateWeldstashWarehouse();
  const update = useUpdateWeldstashWarehouse();

  const form = useForm<FormValues>({
    resolver: zodResolver(createWarehouseSchema),
    defaultValues: warehouse
      ? {
          name: warehouse.name,
          code: warehouse.code ?? undefined,
          description: warehouse.description ?? undefined,
          addressLine1: warehouse.addressLine1 ?? undefined,
          city: warehouse.city ?? undefined,
          postalCode: warehouse.postalCode ?? undefined,
          country: warehouse.country ?? undefined,
          contactName: warehouse.contactName ?? undefined,
          isDefault: warehouse.isDefault ?? false,
          isActive: warehouse.isActive ?? true,
        }
      : { name: '', isActive: true, isDefault: false },
  });

  const onSubmit = async (values: FormValues) => {
    try {
      const parsed = createWarehouseSchema.parse(values) as CreateWarehouseInput;
      if (isEdit && warehouse) {
        await update.mutateAsync({ id: warehouse.id, data: parsed });
        toast.success(ts.weldstash.warehouses.toastUpdated);
      } else {
        await create.mutateAsync(parsed);
        toast.success(ts.weldstash.warehouses.toastCreated);
      }
      onOpenChange(false);
      form.reset();
    } catch (err) {
      toast.error((err as Error).message || t.common.saveFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? ts.weldstash.warehouses.editTitle : ts.weldstash.warehouses.newTitle}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="name">{t.fields.name}</Label>
              <Input id="name" {...form.register('name')} />
              {form.formState.errors.name && (
                <p className="text-xs text-destructive">{String(form.formState.errors.name.message ?? '')}</p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="code">{t.fields.code}</Label>
              <Input id="code" {...form.register('code')} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="addressLine1">{t.fields.address}</Label>
            <Input id="addressLine1" {...form.register('addressLine1')} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="city">{t.fields.city}</Label>
              <Input id="city" {...form.register('city')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="postalCode">{ts.weldstash.warehouses.labelPostalCode}</Label>
              <Input id="postalCode" {...form.register('postalCode')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="country">{t.fields.country}</Label>
              <Input id="country" {...form.register('country')} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="contactName">{t.fields.contact}</Label>
            <Input id="contactName" {...form.register('contactName')} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="description">{t.fields.description}</Label>
            <Textarea id="description" rows={2} {...form.register('description')} />
          </div>
          <div className="flex items-center gap-3">
            {/* Controlled via Controller: with defaultChecked the Switch keeps
                its own state, so form.reset() (or reopening the dialog for a
                different warehouse) would leave the toggle showing the previous
                value while the form held another. */}
            <Controller
              control={form.control}
              name="isDefault"
              render={({ field }) => (
                <Switch
                  id="isDefault"
                  checked={field.value ?? false}
                  onCheckedChange={field.onChange}
                />
              )}
            />
            <Label htmlFor="isDefault">{t.fields.isDefault}</Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {ts.actions.cancel}
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {isEdit ? ts.actions.save : ts.actions.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
