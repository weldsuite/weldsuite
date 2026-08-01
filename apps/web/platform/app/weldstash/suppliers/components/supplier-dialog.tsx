import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createWmsSupplierSchema } from '@weldsuite/app-api-client/schemas/wms-suppliers';
import type { CreateWmsSupplierInput } from '@weldsuite/app-api-client/schemas/wms-suppliers';
import {
  useCreateWeldstashSupplier,
  useUpdateWeldstashSupplier,
  type WmsSupplier,
} from '@/hooks/queries/use-weldstash-queries';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

type FormValues = z.input<typeof createWmsSupplierSchema>;

export function SupplierDialog({
  open,
  onOpenChange,
  supplier,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplier?: WmsSupplier;
}) {
  const t = getTranslations('commerce').module;
  const ts = getTranslations('common');
  const isEdit = !!supplier;
  const create = useCreateWeldstashSupplier();
  const update = useUpdateWeldstashSupplier();

  const form = useForm<FormValues>({
    resolver: zodResolver(createWmsSupplierSchema),
    defaultValues: supplier
      ? {
          name: supplier.name,
          code: supplier.code ?? undefined,
          contactName: supplier.contactName ?? undefined,
          email: supplier.email ?? undefined,
          phone: supplier.phone ?? undefined,
          city: supplier.city ?? undefined,
          country: supplier.country ?? undefined,
          defaultLeadTimeDays: supplier.defaultLeadTimeDays ?? undefined,
          notes: supplier.notes ?? undefined,
        }
      : { name: '' },
  });

  const onSubmit = async (values: FormValues) => {
    try {
      const parsed = createWmsSupplierSchema.parse(values) as CreateWmsSupplierInput;
      if (isEdit && supplier) {
        await update.mutateAsync({ id: supplier.id, data: parsed });
        toast.success(ts.weldstash.suppliers.toastUpdated);
      } else {
        await create.mutateAsync(parsed);
        toast.success(ts.weldstash.suppliers.toastCreated);
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
            {isEdit ? ts.weldstash.suppliers.editTitle : ts.weldstash.suppliers.newTitle}
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
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="contactName">{t.fields.contact}</Label>
              <Input id="contactName" {...form.register('contactName')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="defaultLeadTimeDays">{t.fields.leadTime}</Label>
              <Input
                id="defaultLeadTimeDays"
                type="number"
                {...form.register('defaultLeadTimeDays', { valueAsNumber: true })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="email">{t.fields.email}</Label>
              <Input id="email" type="email" {...form.register('email')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="phone">{t.fields.phone}</Label>
              <Input id="phone" {...form.register('phone')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="city">{t.fields.city}</Label>
              <Input id="city" {...form.register('city')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="country">{t.fields.country}</Label>
              <Input id="country" {...form.register('country')} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="notes">{t.fields.description}</Label>
            <Textarea id="notes" rows={3} {...form.register('notes')} />
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
