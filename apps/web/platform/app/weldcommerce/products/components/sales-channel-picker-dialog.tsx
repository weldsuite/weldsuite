/**
 * Picker for listing a product on a connected store (WooCommerce / Shopify).
 *
 * Adding a channel syncs the product to that store with the chosen price and
 * listing status. Connections the product is already on are shown but not
 * selectable.
 */

import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import {
  useSalesChannelTargets,
  type SalesChannelListingStatus,
} from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export interface AddSalesChannelPayload {
  connectionIds: string[];
  price: string;
  listingStatus: SalesChannelListingStatus;
}

function toPriceInput(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '0.00';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

export function SalesChannelPickerDialog({
  open,
  onOpenChange,
  existingConnectionIds,
  onConfirm,
  isSaving,
  defaultPrice,
  defaultListingStatus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingConnectionIds: string[];
  onConfirm: (payload: AddSalesChannelPayload) => Promise<void> | void;
  isSaving?: boolean;
  defaultPrice?: string | number | null;
  defaultListingStatus?: SalesChannelListingStatus | string | null;
}) {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [price, setPrice] = useState(toPriceInput(defaultPrice));
  const [listingStatus, setListingStatus] = useState<SalesChannelListingStatus>(
    defaultListingStatus === 'inactive' || defaultListingStatus === 'draft' ? defaultListingStatus : 'active',
  );
  const { data, isLoading } = useSalesChannelTargets(open);
  const rows = data?.data ?? [];
  const existing = useMemo(() => new Set(existingConnectionIds), [existingConnectionIds]);

  useEffect(() => {
    if (!open) return;
    setPrice(toPriceInput(defaultPrice));
    setListingStatus(
      defaultListingStatus === 'inactive' || defaultListingStatus === 'draft' ? defaultListingStatus : 'active',
    );
  }, [open, defaultPrice, defaultListingStatus]);

  const reset = () => {
    setSelected(new Set());
    setPrice(toPriceInput(defaultPrice));
    setListingStatus(
      defaultListingStatus === 'inactive' || defaultListingStatus === 'draft' ? defaultListingStatus : 'active',
    );
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = async () => {
    if (selected.size === 0) return;
    await onConfirm({ connectionIds: [...selected], price, listingStatus });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.products.addSalesChannelTitle}</DialogTitle>
        </DialogHeader>

        <div className="max-h-[320px] overflow-y-auto rounded-md border">
          {isLoading && <p className="p-4 text-sm text-muted-foreground">{t.common.loading}</p>}
          {!isLoading && rows.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">{t.products.noSalesChannelTargets}</p>
          )}
          {!isLoading &&
            rows.map((target) => {
              const alreadyIn = existing.has(target.id);
              const label = target.displayName || target.label;
              return (
                <button
                  key={target.id}
                  type="button"
                  disabled={alreadyIn}
                  onClick={() => toggle(target.id)}
                  className={cn(
                    'flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0',
                    alreadyIn ? 'opacity-50' : 'hover:bg-muted/50',
                  )}
                >
                  <Checkbox
                    checked={alreadyIn || selected.has(target.id)}
                    disabled={alreadyIn}
                    className="pointer-events-none"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{label}</span>
                    <span className="text-muted-foreground block truncate text-xs">{target.label}</span>
                  </span>
                  {alreadyIn && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Check className="h-3 w-3" />
                      {t.products.salesChannelAlreadyAdded}
                    </span>
                  )}
                </button>
              );
            })}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="sales-channel-price">{t.products.salesChannelPrice}</Label>
            <Input
              id="sales-channel-price"
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{t.products.salesChannelListingStatus}</Label>
            <Select value={listingStatus} onValueChange={(v) => setListingStatus(v as SalesChannelListingStatus)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">{t.status.active}</SelectItem>
                <SelectItem value="draft">{t.status.draft}</SelectItem>
                <SelectItem value="inactive">{t.status.inactive}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {tc.actions.cancel}
          </Button>
          <Button type="button" disabled={selected.size === 0 || isSaving} onClick={handleConfirm}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t.linking.addSelected.replace('{count}', String(selected.size))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
