import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createWarehouseSchema, type CreateWarehouseInput, type WeldstashWarehouse } from '@weldsuite/core-api-client/schemas/weldstash';
import {
  useWeldstashWarehouses,
  useCreateWeldstashWarehouse,
  useUpdateWeldstashWarehouse,
  useDeleteWeldstashWarehouse,
} from '@/hooks/queries/use-weldstash-queries';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Switch } from '@weldsuite/ui/components/switch';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@weldsuite/ui/components/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Badge } from '@weldsuite/ui/components/badge';
import { Plus, Pencil, Trash2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

type FormValues = z.input<typeof createWarehouseSchema>;

function WarehouseDialog({
  open,
  onOpenChange,
  warehouse,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  warehouse?: WeldstashWarehouse;
}) {
  const t = getTranslations('common');
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
          state: warehouse.state ?? undefined,
          postalCode: warehouse.postalCode ?? undefined,
          country: warehouse.country ?? undefined,
          contactName: warehouse.contactName ?? undefined,
          contactEmail: warehouse.contactEmail ?? undefined,
          contactPhone: warehouse.contactPhone ?? undefined,
          isDefault: warehouse.isDefault ?? false,
          isActive: warehouse.isActive ?? true,
        }
      : { name: '', isActive: true },
  });

  const onSubmit = async (values: FormValues) => {
    try {
      const parsed = createWarehouseSchema.parse(values) as CreateWarehouseInput;
      if (isEdit && warehouse) {
        await update.mutateAsync({ id: warehouse.id, data: parsed });
        toast.success(t.weldstash.warehouses.toastUpdated);
      } else {
        await create.mutateAsync(parsed);
        toast.success(t.weldstash.warehouses.toastCreated);
      }
      onOpenChange(false);
      form.reset();
    } catch (err) {
      toast.error((err as Error).message || t.weldstash.warehouses.toastSaveFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.weldstash.warehouses.editTitle : t.weldstash.warehouses.newTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="name">{t.weldstash.warehouses.labelName}</Label>
              <Input id="name" {...form.register('name')} />
              {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="code">{t.weldstash.warehouses.labelCode}</Label>
              <Input id="code" {...form.register('code')} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="addressLine1">{t.weldstash.warehouses.labelAddress}</Label>
            <Input id="addressLine1" {...form.register('addressLine1')} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="city">{t.weldstash.warehouses.labelCity}</Label>
              <Input id="city" {...form.register('city')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="postalCode">{t.weldstash.warehouses.labelPostalCode}</Label>
              <Input id="postalCode" {...form.register('postalCode')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="country">{t.weldstash.warehouses.labelCountry}</Label>
              <Input id="country" {...form.register('country')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="contactName">{t.weldstash.warehouses.labelContactName}</Label>
              <Input id="contactName" {...form.register('contactName')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="contactEmail">{t.weldstash.warehouses.labelContactEmail}</Label>
              <Input id="contactEmail" type="email" {...form.register('contactEmail')} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="description">{t.weldstash.warehouses.labelDescription}</Label>
            <Textarea id="description" rows={2} {...form.register('description')} />
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Switch id="isDefault" checked={form.watch('isDefault') ?? false} onCheckedChange={(v) => form.setValue('isDefault', v)} />
              <Label htmlFor="isDefault" className="cursor-pointer">{t.weldstash.warehouses.labelDefaultWarehouse}</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="isActive" checked={form.watch('isActive') ?? true} onCheckedChange={(v) => form.setValue('isActive', v)} />
              <Label htmlFor="isActive" className="cursor-pointer">{t.weldstash.warehouses.labelActive}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t.actions.cancel}</Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>{isEdit ? t.actions.save : t.actions.create}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function WarehousesPage() {
  const t = getTranslations('common');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<WeldstashWarehouse | undefined>();

  const params = useMemo(() => ({ limit: 50, search: search || undefined }), [search]);
  const { data, isLoading } = useWeldstashWarehouses(params);
  const del = useDeleteWeldstashWarehouse();

  const onDelete = async (id: string) => {
    if (!confirm(t.weldstash.warehouses.confirmDelete)) return;
    try {
      await del.mutateAsync(id);
      toast.success(t.weldstash.warehouses.toastDeleted);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="container mx-auto max-w-[1600px] p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder={t.weldstash.warehouses.searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="mr-2 h-4 w-4" /> {t.weldstash.warehouses.newWarehouse}</Button>
          </DialogTrigger>
          {createOpen && <WarehouseDialog open={createOpen} onOpenChange={setCreateOpen} />}
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.weldstash.warehouses.colName}</TableHead>
                <TableHead>{t.weldstash.warehouses.colCode}</TableHead>
                <TableHead>{t.weldstash.warehouses.colCity}</TableHead>
                <TableHead>{t.weldstash.warehouses.colCountry}</TableHead>
                <TableHead>{t.weldstash.warehouses.colStatus}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">{t.weldstash.warehouses.loading}</TableCell></TableRow>
              )}
              {!isLoading && data?.data.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">{t.weldstash.warehouses.empty}</TableCell></TableRow>
              )}
              {data?.data.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="font-medium">
                    {w.name}
                    {w.isDefault && <Badge variant="secondary" className="ml-2">{t.weldstash.warehouses.badgeDefault}</Badge>}
                  </TableCell>
                  <TableCell>{w.code ?? '—'}</TableCell>
                  <TableCell>{w.city ?? '—'}</TableCell>
                  <TableCell>{w.country ?? '—'}</TableCell>
                  <TableCell><Badge variant={w.isActive ? 'default' : 'secondary'}>{w.isActive ? t.weldstash.warehouses.statusActive : t.weldstash.warehouses.statusInactive}</Badge></TableCell>
                  <TableCell className="flex gap-1 justify-end">
                    <Button size="icon" variant="ghost" onClick={() => setEditing(w)}><Pencil className="h-4 w-4" /></Button>
                    <Button size="icon" variant="ghost" onClick={() => onDelete(w.id)}><Trash2 className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {editing && <WarehouseDialog open={!!editing} onOpenChange={(o) => !o && setEditing(undefined)} warehouse={editing} />}
    </div>
  );
}
