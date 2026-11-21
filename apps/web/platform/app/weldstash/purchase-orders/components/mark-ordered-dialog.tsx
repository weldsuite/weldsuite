import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { getTranslations } from '@/lib/i18n';
import { useMarkPurchaseOrderOrdered } from '@/hooks/queries/use-purchasing-queries';
import { isoDatePart } from '../../lib/numbers';

/** Marks an approved order as ordered: the order date (default today) and, optionally, a new expected date. */
export function MarkOrderedDialog({
  open,
  onOpenChange,
  orderId,
  expectedDate,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; orderId: string; expectedDate: string | null }>) {
  const t = getTranslations('weldstashPurchasing').markOrdered;
  const mutation = useMarkPurchaseOrderOrdered();
  const today = new Date().toISOString().slice(0, 10);
  const [orderDate, setOrderDate] = useState(today);
  const [expected, setExpected] = useState(isoDatePart(expectedDate) ?? '');

  const submit = async () => {
    try {
      await mutation.mutateAsync({
        id: orderId,
        data: {
          orderDate: new Date(`${orderDate || today}T00:00:00Z`).toISOString(),
          ...(expected ? { expectedDate: new Date(`${expected}T00:00:00Z`).toISOString() } : {}),
        },
      });
      toast.success(t.toast);
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message || t.failed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="mo-order-date">{t.orderDate}</Label>
            <Input id="mo-order-date" type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mo-expected-date">{t.expectedDate}</Label>
            <Input id="mo-expected-date" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t.cancel}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={mutation.isPending}>
            {t.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
