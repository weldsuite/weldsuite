import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createWmsSupplierSchema } from '@weldsuite/app-api-client/schemas/wms-suppliers';
import type { CreateWmsSupplierInput, UpdateWmsSupplierInput } from '@weldsuite/app-api-client/schemas/wms-suppliers';
import type { WmsSupplier } from '@/hooks/queries/use-weldstash-queries';
import {
  useWeldstashSuppliers,
  useCreateWeldstashSupplier,
  useUpdateWeldstashSupplier,
  useDeleteWeldstashSupplier,
} from '@/hooks/queries/use-weldstash-queries';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@weldsuite/ui/components/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { Badge } from '@weldsuite/ui/components/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Plus, Pencil, Trash2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { useTranslations } from '@weldsuite/i18n/client';

type FormValues = z.input<typeof createWmsSupplierSchema>;

function SupplierDialog({
  open,
  onOpenChange,
  supplier,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplier?: WmsSupplier;
}) {
  const t = getTranslations('common');
  const st = useTranslations();
  const isEdit = !!supplier;
  const create = useCreateWeldstashSupplier();
  const update = useUpdateWeldstashSupplier();

  const form = useForm<FormValues>({
    resolver: zodResolver(createWmsSupplierSchema),
    defaultValues: supplier
      ? {
          name: supplier.name,
          code: supplier.code ?? undefined,
          description: supplier.description ?? undefined,
          contactName: supplier.contactName ?? undefined,
          email: supplier.email ?? undefined,
          phone: supplier.phone ?? undefined,
          website: supplier.website ?? undefined,
          addressLine1: supplier.addressLine1 ?? undefined,
          city: supplier.city ?? undefined,
          country: supplier.country ?? undefined,
          paymentTerms: supplier.paymentTerms ?? undefined,
          currency: supplier.currency ?? undefined,
          taxId: supplier.taxId ?? undefined,
          isActive: supplier.isActive ?? true,
          notes: supplier.notes ?? undefined,
        }
      : { name: '', isActive: true, currency: 'USD' },
  });

  const onSubmit = async (values: FormValues) => {
    try {
      const parsed = createWmsSupplierSchema.parse(values) as CreateWmsSupplierInput;
      if (isEdit && supplier) {
        await update.mutateAsync({ id: supplier.id, data: parsed as UpdateWmsSupplierInput });
        toast.success(t.weldstash.suppliers.toastUpdated);
      } else {
        await create.mutateAsync(parsed);
        toast.success(t.weldstash.suppliers.toastCreated);
      }
      onOpenChange(false);
      form.reset();
    } catch (err) {
      toast.error((err as Error).message || t.weldstash.suppliers.toastSaveFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.weldstash.suppliers.editTitle : t.weldstash.suppliers.newTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="companyName">{t.weldstash.suppliers.labelCompanyName}</Label>
              {/* id="companyName" matches the Playwright selector; schema field is `name` */}
              <Input id="companyName" {...form.register('name')} />
              {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="code">{t.weldstash.suppliers.labelCode}</Label>
              <Input id="code" {...form.register('code')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="email">{t.weldstash.suppliers.labelEmail}</Label>
              <Input id="email" type="email" {...form.register('email')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="phone">{t.weldstash.suppliers.labelPhone}</Label>
              <Input id="phone" {...form.register('phone')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="paymentTerms">{t.weldstash.suppliers.labelPaymentTerms}</Label>
              <Input id="paymentTerms" placeholder={st('sweep.miscB.paymentTermsPlaceholder')} {...form.register('paymentTerms')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="isActive">{t.weldstash.suppliers.labelStatus}</Label>
              <Select
                defaultValue={form.getValues('isActive') === false ? 'inactive' : 'active'}
                onValueChange={(v) => form.setValue('isActive', v === 'active')}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t.weldstash.suppliers.statusActive}</SelectItem>
                  <SelectItem value="inactive">{t.weldstash.suppliers.statusInactive}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="notes">{t.weldstash.suppliers.labelNotes}</Label>
            <Textarea id="notes" rows={3} {...form.register('notes')} />
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

export default function SuppliersPage() {
  const t = getTranslations('common');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<WmsSupplier | undefined>();

  const params = useMemo(() => ({ limit: 50, search: search || undefined }), [search]);
  const { data, isLoading } = useWeldstashSuppliers(params);
  const del = useDeleteWeldstashSupplier();

  const onDelete = async (id: string) => {
    if (!confirm(t.weldstash.suppliers.confirmDelete)) return;
    try {
      await del.mutateAsync(id);
      toast.success(t.weldstash.suppliers.toastDeleted);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="container mx-auto max-w-[1600px] p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder={t.weldstash.suppliers.searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="mr-2 h-4 w-4" /> {t.weldstash.suppliers.newSupplier}</Button>
          </DialogTrigger>
          {createOpen && <SupplierDialog open={createOpen} onOpenChange={setCreateOpen} />}
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.weldstash.suppliers.colCompany}</TableHead>
                <TableHead>{t.weldstash.suppliers.colEmail}</TableHead>
                <TableHead>{t.weldstash.suppliers.colPhone}</TableHead>
                <TableHead>{t.weldstash.suppliers.colPaymentTerms}</TableHead>
                <TableHead>{t.weldstash.suppliers.colStatus}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">{t.weldstash.suppliers.loading}</TableCell></TableRow>
              )}
              {!isLoading && data?.data.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">{t.weldstash.suppliers.empty}</TableCell></TableRow>
              )}
              {data?.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{s.email ?? '—'}</TableCell>
                  <TableCell>{s.phone ?? '—'}</TableCell>
                  <TableCell>{s.paymentTerms ?? '—'}</TableCell>
                  <TableCell><Badge variant={s.isActive ? 'default' : 'secondary'}>{s.isActive ? t.weldstash.suppliers.statusActive : t.weldstash.suppliers.statusInactive}</Badge></TableCell>
                  <TableCell className="flex gap-1 justify-end">
                    <Button size="icon" variant="ghost" onClick={() => setEditing(s)}><Pencil className="h-4 w-4" /></Button>
                    <Button size="icon" variant="ghost" onClick={() => onDelete(s.id)}><Trash2 className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {editing && <SupplierDialog open={!!editing} onOpenChange={(o) => !o && setEditing(undefined)} supplier={editing} />}
    </div>
  );
}
