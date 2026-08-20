import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { getTranslations } from '@/lib/i18n';
import { useGenerateWeldstashPickList, useWeldstashWarehouses } from '@/hooks/queries/use-weldstash-queries';

interface GeneratePickListDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GeneratePickListDialog({ open, onOpenChange }: GeneratePickListDialogProps) {
  const t = getTranslations('common').weldstash.pickLists;
  const generate = useGenerateWeldstashPickList();
  const warehouses = useWeldstashWarehouses({ limit: 100 });
  const form = useForm({
    defaultValues: { orderId: '', warehouseId: '', assignedTo: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await generate.mutateAsync({
        orderId: values.orderId.trim(),
        warehouseId: values.warehouseId || undefined,
        assignedTo: values.assignedTo || undefined,
      });
      toast.success(t.toastGenerated);
      onOpenChange(false);
      form.reset();
    } catch (err) {
      toast.error((err as Error).message || t.toastGenerateFailed);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.generateTitle}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="orderId">{t.labelOrderId}</Label>
            <Input id="orderId" {...form.register('orderId', { required: true })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="warehouseId">{t.labelWarehouse}</Label>
            <select
              id="warehouseId"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              {...form.register('warehouseId')}
            >
              <option value="">Default warehouse</option>
              {(warehouses.data?.data ?? []).map((wh) => (
                <option key={wh.id} value={wh.id}>
                  {wh.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="assignedTo">{t.labelAssignee}</Label>
            <Input id="assignedTo" {...form.register('assignedTo')} />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={generate.isPending}>
              {t.newPickList}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
