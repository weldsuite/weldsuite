import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createProductSchema, type CreateProductInput, type WeldstashProduct } from '@weldsuite/core-api-client/schemas/weldstash';
import {
  useWeldstashProducts,
  useCreateWeldstashProduct,
  useUpdateWeldstashProduct,
  useDeleteWeldstashProduct,
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

type FormValues = z.input<typeof createProductSchema>;

function ProductDialog({
  open,
  onOpenChange,
  product,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: WeldstashProduct;
}) {
  const t = getTranslations('common');
  const isEdit = !!product;
  const create = useCreateWeldstashProduct();
  const update = useUpdateWeldstashProduct();

  const form = useForm<FormValues>({
    resolver: zodResolver(createProductSchema),
    defaultValues: product
      ? {
          name: product.name,
          sku: product.sku ?? undefined,
          barcode: product.barcode ?? undefined,
          description: product.description ?? undefined,
          price: Number(product.price ?? 0),
          costPrice: product.costPrice != null ? Number(product.costPrice) : undefined,
          currency: product.currency ?? undefined,
          lowStockThreshold: product.lowStockThreshold ?? 5,
          trackInventory: product.trackInventory ?? true,
          status: (product.status as 'active' | 'inactive' | 'draft') ?? 'active',
          brand: product.brand ?? undefined,
          vendor: product.vendor ?? undefined,
        }
      : { name: '', price: 0, lowStockThreshold: 5, trackInventory: true, status: 'active' },
  });

  const onSubmit = async (values: FormValues) => {
    try {
      const parsed = createProductSchema.parse(values) as CreateProductInput;
      if (isEdit && product) {
        await update.mutateAsync({ id: product.id, data: parsed });
        toast.success(t.weldstash.products.toastUpdated);
      } else {
        await create.mutateAsync(parsed);
        toast.success(t.weldstash.products.toastCreated);
      }
      onOpenChange(false);
      form.reset();
    } catch (err) {
      toast.error((err as Error).message || t.weldstash.products.toastSaveFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? t.weldstash.products.editTitle : t.weldstash.products.newTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="name">{t.weldstash.products.labelName}</Label>
            <Input id="name" {...form.register('name')} />
            {form.formState.errors.name && <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="sku">{t.weldstash.products.labelSku}</Label>
              <Input id="sku" {...form.register('sku')} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="barcode">{t.weldstash.products.labelBarcode}</Label>
              <Input id="barcode" {...form.register('barcode')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="price">{t.weldstash.products.labelPrice}</Label>
              <Input id="price" type="number" step="0.01" {...form.register('price', { valueAsNumber: true })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="costPrice">{t.weldstash.products.labelCostPrice}</Label>
              <Input id="costPrice" type="number" step="0.01" {...form.register('costPrice', { valueAsNumber: true })} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="lowStockThreshold">{t.weldstash.products.labelLowStockThreshold}</Label>
              <Input id="lowStockThreshold" type="number" {...form.register('lowStockThreshold', { valueAsNumber: true })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="status">{t.weldstash.products.labelStatus}</Label>
              <Select defaultValue={form.getValues('status')} onValueChange={(v) => form.setValue('status', v as 'active' | 'inactive' | 'draft')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t.weldstash.products.statusActive}</SelectItem>
                  <SelectItem value="inactive">{t.weldstash.products.statusInactive}</SelectItem>
                  <SelectItem value="draft">{t.weldstash.products.statusDraft}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="description">{t.weldstash.products.labelDescription}</Label>
            <Textarea id="description" rows={3} {...form.register('description')} />
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

export default function ProductsPage() {
  const t = getTranslations('common');
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<WeldstashProduct | undefined>();

  const params = useMemo(() => ({ limit: 50, search: search || undefined }), [search]);
  const { data, isLoading } = useWeldstashProducts(params);
  const del = useDeleteWeldstashProduct();

  const onDelete = async (id: string) => {
    if (!confirm(t.weldstash.products.confirmDelete)) return;
    try {
      await del.mutateAsync(id);
      toast.success(t.weldstash.products.toastDeleted);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <div className="container mx-auto max-w-[1600px] p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder={t.weldstash.products.searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="mr-2 h-4 w-4" /> {t.weldstash.products.newProduct}</Button>
          </DialogTrigger>
          {createOpen && <ProductDialog open={createOpen} onOpenChange={setCreateOpen} />}
        </Dialog>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.weldstash.products.colName}</TableHead>
                <TableHead>{t.weldstash.products.colSku}</TableHead>
                <TableHead>{t.weldstash.products.colPrice}</TableHead>
                <TableHead>{t.weldstash.products.colStock}</TableHead>
                <TableHead>{t.weldstash.products.colStatus}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">{t.weldstash.products.loading}</TableCell></TableRow>
              )}
              {!isLoading && data?.data.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">{t.weldstash.products.empty}</TableCell></TableRow>
              )}
              {data?.data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell>{p.sku ?? '—'}</TableCell>
                  <TableCell>{Number(p.price ?? 0).toFixed(2)} {p.currency ?? ''}</TableCell>
                  <TableCell>{p.inventoryQuantity ?? 0}</TableCell>
                  <TableCell><Badge variant={p.status === 'active' ? 'default' : 'secondary'}>{p.status}</Badge></TableCell>
                  <TableCell className="flex gap-1 justify-end">
                    <Button size="icon" variant="ghost" onClick={() => setEditing(p)}><Pencil className="h-4 w-4" /></Button>
                    <Button size="icon" variant="ghost" onClick={() => onDelete(p.id)}><Trash2 className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {editing && <ProductDialog open={!!editing} onOpenChange={(o) => !o && setEditing(undefined)} product={editing} />}
    </div>
  );
}
