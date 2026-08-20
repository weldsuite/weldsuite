/**
 * Add / remove sales-channel listings for a product.
 *
 * Remove is local-only (the store listing stays). Add syncs the product to
 * that store. Used in the catalogue table, the object panel, and the edit
 * dialog so the three surfaces stay in lockstep.
 */

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  useAddProductSalesChannel,
  useRemoveProductSalesChannel,
  type ProductSalesChannel,
} from '@/hooks/queries/use-commerce-queries';
import { getTranslations } from '@/lib/i18n';
import { interpolate } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { SalesChannelPickerDialog } from './sales-channel-picker-dialog';

function channelLabel(channel: ProductSalesChannel): string {
  return channel.displayName || channel.provider;
}

function statusLabel(channel: ProductSalesChannel, t: {
  products: {
    salesChannelDeleted: string;
    salesChannelDisconnected: string;
    salesChannelActive: string;
  };
}): string {
  if (channel.status === 'deleted_remote') return t.products.salesChannelDeleted;
  if (channel.status === 'disconnected') return t.products.salesChannelDisconnected;
  return t.products.salesChannelActive;
}

export function ProductSalesChannelsEditor({
  productId,
  channels,
  compact = false,
}: {
  productId: string;
  channels: ProductSalesChannel[];
  compact?: boolean;
}) {
  const t = getTranslations('commerce').module;
  const add = useAddProductSalesChannel();
  const remove = useRemoveProductSalesChannel();
  const [pickerOpen, setPickerOpen] = useState(false);

  const handleAdd = async (connectionIds: string[]) => {
    try {
      for (const connectionId of connectionIds) {
        const result = await add.mutateAsync({ productId, connectionId });
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
                <span className="truncate">{channelLabel(channel)}</span>
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
        <SalesChannelPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          existingConnectionIds={channels.map((c) => c.connectionId)}
          onConfirm={handleAdd}
          isSaving={add.isPending}
        />
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
              className={cn('flex items-center justify-between gap-2 rounded-md border px-3 py-2')}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{channelLabel(channel)}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {interpolate(t.products.salesChannelExternalId, { id: channel.externalId })}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Badge variant="outline" className="text-xs capitalize">
                  {statusLabel(channel, t)}
                </Badge>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  title={t.products.removeSalesChannel}
                  onClick={() => void handleRemove(channel)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground text-xs">{t.products.removeSalesChannelHint}</p>
      <SalesChannelPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        existingConnectionIds={channels.map((c) => c.connectionId)}
        onConfirm={handleAdd}
        isSaving={add.isPending}
      />
    </div>
  );
}
