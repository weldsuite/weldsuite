/**
 * Add / remove / edit sales-channel listings for a product.
 *
 * Price and listing status are per store and are pushed to WooCommerce /
 * Shopify. Remove is local-only (the store listing stays). Used in the
 * catalogue table, the object panel, and the edit dialog so the three
 * surfaces stay in lockstep.
 */

import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import {
  useAddProductSalesChannel,
  useRemoveProductSalesChannel,
  useUpdateProductSalesChannel,
  type ProductSalesChannel,
  type SalesChannelListingStatus,
} from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { interpolate } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { SalesChannelPickerDialog } from './sales-channel-picker-dialog';

function channelLabel(channel: ProductSalesChannel): string {
  return channel.displayName || channel.provider;
}

function formatChannelPrice(amount: string | null | undefined, currency?: string | null): string {
  if (amount == null || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  return `${n.toFixed(2)}${currency ? ` ${currency}` : ''}`;
}

function listingLabel(
  status: string | null | undefined,
  t: { status: { active: string; inactive: string; draft: string } },
): string {
  if (status === 'inactive') return t.status.inactive;
  if (status === 'draft') return t.status.draft;
  return t.status.active;
}

function mappingLabel(
  channel: ProductSalesChannel,
  t: {
    products: {
      salesChannelDeleted: string;
      salesChannelDisconnected: string;
    };
  },
): string | null {
  if (channel.status === 'deleted_remote') return t.products.salesChannelDeleted;
  if (channel.status === 'disconnected') return t.products.salesChannelDisconnected;
  return null;
}

function ChannelListingFields({
  price,
  listingStatus,
  disabled,
  onPriceChange,
  onStatusChange,
  onSave,
  isSaving,
}: {
  price: string;
  listingStatus: SalesChannelListingStatus;
  disabled?: boolean;
  onPriceChange: (value: string) => void;
  onStatusChange: (value: SalesChannelListingStatus) => void;
  onSave: () => void;
  isSaving?: boolean;
}) {
  const t = getTranslations('commerce').module;
  const tc = getTranslations('common');
  return (
    <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
      <div className="grid gap-1">
        <Label className="text-xs">{t.products.salesChannelPrice}</Label>
        <Input
          type="number"
          min="0"
          step="0.01"
          className="h-8"
          value={price}
          disabled={disabled}
          onChange={(e) => onPriceChange(e.target.value)}
          onBlur={() => void onSave()}
        />
      </div>
      <div className="grid gap-1">
        <Label className="text-xs">{t.products.salesChannelListingStatus}</Label>
        <Select
          value={listingStatus}
          disabled={disabled}
          onValueChange={(v) => onStatusChange(v as SalesChannelListingStatus)}
        >
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">{t.status.active}</SelectItem>
            <SelectItem value="draft">{t.status.draft}</SelectItem>
            <SelectItem value="inactive">{t.status.inactive}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button type="button" size="sm" variant="outline" disabled={disabled || isSaving} onClick={() => void onSave()}>
        {tc.actions.save}
      </Button>
    </div>
  );
}

function ChannelEditor({
  productId,
  channel,
  currency,
  compact,
}: {
  productId: string;
  channel: ProductSalesChannel;
  currency?: string | null;
  compact?: boolean;
}) {
  const t = getTranslations('commerce').module;
  const update = useUpdateProductSalesChannel();
  const [price, setPrice] = useState(channel.price ?? '');
  const [listingStatus, setListingStatus] = useState<SalesChannelListingStatus>(channel.listingStatus ?? 'active');
  const mapping = mappingLabel(channel, t);
  const canEdit = channel.status === 'active';

  useEffect(() => {
    setPrice(channel.price ?? '');
    setListingStatus(channel.listingStatus ?? 'active');
  }, [channel.price, channel.listingStatus]);

  const save = async (next?: { price?: string; listingStatus?: SalesChannelListingStatus }) => {
    const nextPrice = next?.price ?? price;
    const nextStatus = next?.listingStatus ?? listingStatus;
    if (nextPrice === (channel.price ?? '') && nextStatus === channel.listingStatus) return;
    try {
      await update.mutateAsync({
        productId,
        channelId: channel.id,
        price: nextPrice,
        listingStatus: nextStatus,
      });
      toast.success(interpolate(t.products.salesChannelUpdated, { name: channelLabel(channel) }));
    } catch (err) {
      toast.error((err as Error).message || t.common.saveFailed);
    }
  };

  if (compact) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="max-w-full truncate text-left"
            title={t.products.editSalesChannel}
          >
            <span className="truncate">{channelLabel(channel)}</span>
            <span className="text-muted-foreground">
              {' · '}
              {formatChannelPrice(channel.price, currency)}
              {' · '}
              {listingLabel(channel.listingStatus, t)}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-80 space-y-3"
          onClick={(e) => e.stopPropagation()}
          onPointerDownOutside={(e) => {
            const target = e.target as HTMLElement | null;
            if (target?.closest('[data-slot="select-content"]')) e.preventDefault();
          }}
        >
          <p className="truncate text-sm font-medium">{channelLabel(channel)}</p>
          {mapping && <p className="text-muted-foreground text-xs">{mapping}</p>}
          <ChannelListingFields
            price={price}
            listingStatus={listingStatus}
            disabled={!canEdit || update.isPending}
            onPriceChange={setPrice}
            onStatusChange={(value) => {
              setListingStatus(value);
              void save({ listingStatus: value });
            }}
            onSave={() => save()}
            isSaving={update.isPending}
          />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <div className="min-w-0 flex-1 space-y-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{channelLabel(channel)}</p>
        <p className="text-muted-foreground truncate text-xs">
          {interpolate(t.products.salesChannelExternalId, { id: channel.externalId })}
          {mapping ? ` · ${mapping}` : ''}
        </p>
      </div>
      <ChannelListingFields
        price={price}
        listingStatus={listingStatus}
        disabled={!canEdit || update.isPending}
        onPriceChange={setPrice}
        onStatusChange={(value) => {
          setListingStatus(value);
          void save({ listingStatus: value });
        }}
        onSave={() => save()}
        isSaving={update.isPending}
      />
    </div>
  );
}

export function ProductSalesChannelsEditor({
  productId,
  channels,
  compact = false,
  catalogPrice,
  catalogStatus,
  currency,
}: {
  productId: string;
  channels: ProductSalesChannel[];
  compact?: boolean;
  catalogPrice?: string | number | null;
  catalogStatus?: string | null;
  currency?: string | null;
}) {
  const t = getTranslations('commerce').module;
  const add = useAddProductSalesChannel();
  const remove = useRemoveProductSalesChannel();
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleAdd = async (payload: {
    connectionIds: string[];
    price: string;
    listingStatus: SalesChannelListingStatus;
  }) => {
    try {
      for (const connectionId of payload.connectionIds) {
        const result = await add.mutateAsync({
          productId,
          connectionId,
          price: payload.price,
          listingStatus: payload.listingStatus,
        });
        const name = result.data?.displayName || result.data?.provider || t.products.salesChannels;
        toast.success(interpolate(t.products.salesChannelAdded, { name }));
      }
    } catch (err) {
      toast.error((err as Error).message || t.common.saveFailed);
      throw err;
    }
  };

  const handleRemove = async (channel: ProductSalesChannel) => {
    try {
      await remove.mutateAsync({ productId, channelId: channel.id });
      toast.success(interpolate(t.products.salesChannelRemoved, { name: channelLabel(channel) }));
    } catch (err) {
      toast.error((err as Error).message || t.common.deleteFailed);
    }
  };

  const picker = (
    <SalesChannelPickerDialog
      open={pickerOpen}
      onOpenChange={setPickerOpen}
      existingConnectionIds={channels.map((c) => c.connectionId)}
      onConfirm={handleAdd}
      isSaving={add.isPending}
      defaultPrice={catalogPrice}
      defaultListingStatus={catalogStatus}
    />
  );

  if (compact) {
    return (
      <div
        className="flex min-w-0 items-center gap-1"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {channels.length === 0 ? (
          <span className="text-muted-foreground">{t.products.salesChannelsNone}</span>
        ) : (
          <div className="flex min-w-0 flex-wrap gap-1">
            {channels.map((channel) => (
              <Badge key={channel.id} variant="outline" className="max-w-full gap-1 pr-1 text-xs font-normal">
                <ChannelEditor key={channel.id} productId={productId} channel={channel} currency={currency} compact />
                <button
                  type="button"
                  className="rounded-sm p-0.5 hover:bg-muted"
                  title={t.products.removeSalesChannel}
                  onClick={() => void handleRemove(channel)}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0"
          title={t.products.addSalesChannel}
          onClick={() => setPickerOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        {picker}
      </div>
    );
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t.products.salesChannels}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t.products.addSalesChannel}
        </Button>
      </div>
      {channels.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t.products.salesChannelsEmpty}</p>
      ) : (
        <ul className="space-y-2">
          {channels.map((channel) => (
            <li
              key={channel.id}
              className={cn('flex items-start justify-between gap-2 rounded-md border px-3 py-2')}
            >
              <ChannelEditor key={channel.id} productId={productId} channel={channel} currency={currency} />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="mt-0.5 h-6 w-6 shrink-0"
                title={t.products.removeSalesChannel}
                onClick={() => void handleRemove(channel)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground text-xs">{t.products.removeSalesChannelHint}</p>
      {picker}
    </div>
  );
}
