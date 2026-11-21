/**
 * The Shipping section of a storefront channel: its shipping zones and
 * rates, in the order the shop offers them. Reordering is by move up and
 * move down buttons (keyboard and screen reader friendly; the order is one
 * `PUT`), with one polite announcement per move, as the Modern Web Guidance
 * dynamic-sort guide asks, and focus kept on the button that was used.
 * Reading needs `commerce_channels:read`; add and edit `:create` and
 * `:update`; delete `:delete`.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import {
  useDeleteShippingRate,
  useReorderShippingRates,
  useShippingRates,
  type CommerceChannel,
  type ShippingRate,
} from '@/hooks/queries/use-commerce-channels-queries';
import { getTranslations } from '@/lib/i18n';
import { countryNames, moveRate } from '@/app/weldcommerce/lib/channels';
import { money } from '@/app/weldcommerce/lib/orders';
import { errorMessage, fill } from '@/app/weldcommerce/lib/text';
import { useConfirmDelete } from '@/app/weldcommerce/lib/use-confirm-delete';
import { ShippingRateDialog } from './shipping-rate-dialog';

interface RowProps {
  rate: ShippingRate;
  index: number;
  count: number;
  channel: CommerceChannel;
  canUpdate: boolean;
  canDelete: boolean;
  busy: boolean;
  onMove: (index: number, direction: -1 | 1) => void;
  onEdit: () => void;
  onDelete: () => void;
}

function RateRow({ rate, index, count, channel, canUpdate, canDelete, busy, onMove, onEdit, onDelete }: Readonly<RowProps>) {
  const t = getTranslations('commerce').channels.shipping;
  const label = `${rate.zoneName}, ${rate.name}`;
  return (
    <TableRow className={rate.active ? undefined : 'text-muted-foreground'}>
      <TableCell className="max-w-[12rem]">
        <span className="block truncate font-medium">{rate.zoneName}</span>
      </TableCell>
      <TableCell className="hidden max-w-[16rem] @2xl:table-cell">
        <span className="block truncate" title={countryNames(rate.countries)}>
          {countryNames(rate.countries)}
        </span>
      </TableCell>
      <TableCell className="max-w-[12rem]">
        <span className="block truncate">{rate.name}</span>
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">{money(rate.price, rate.currency || channel.currency)}</TableCell>
      <TableCell className="hidden whitespace-nowrap tabular-nums @3xl:table-cell">
        {rate.freeShippingThreshold ? money(rate.freeShippingThreshold, rate.currency || channel.currency) : '—'}
      </TableCell>
      <TableCell>
        <SoftBadge tone={rate.active ? 'success' : 'neutral'}>{rate.active ? t.active : t.inactive}</SoftBadge>
      </TableCell>
      <TableCell className="text-right">
        {canUpdate && (
          <div className="flex justify-end gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-move={`${rate.id}:up`}
              aria-label={fill(t.moveUp, { name: label })}
              disabled={index === 0 || busy}
              onClick={() => onMove(index, -1)}
            >
              <ArrowUp className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-move={`${rate.id}:down`}
              aria-label={fill(t.moveDown, { name: label })}
              disabled={index === count - 1 || busy}
              onClick={() => onMove(index, 1)}
            >
              <ArrowDown className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button type="button" variant="ghost" size="icon" aria-label={fill(t.editLabel, { name: label })} onClick={onEdit}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
            </Button>
            {canDelete && (
              <Button type="button" variant="ghost" size="icon" aria-label={fill(t.deleteLabel, { name: label })} onClick={onDelete}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

export function ChannelShippingSection({
  channel,
  canCreate,
  canUpdate,
  canDelete,
}: Readonly<{ channel: CommerceChannel; canCreate: boolean; canUpdate: boolean; canDelete: boolean }>) {
  const t = getTranslations('commerce');
  const ts = t.channels.shipping;
  const rates = useShippingRates(channel.id);
  const reorder = useReorderShippingRates();
  const remove = useDeleteShippingRate();
  const [dialog, setDialog] = useState<{ rate?: ShippingRate } | null>(null);
  const [status, setStatus] = useState('');
  const tableRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);

  const rows = useMemo(() => [...(rates.data?.data ?? [])].sort((a, b) => a.position - b.position), [rates.data]);

  // After a move the rows re-render in their new places; put focus back on the button that was used.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const [id, direction] = target.split(':');
    const wanted = tableRef.current?.querySelector<HTMLButtonElement>(`[data-move="${id}:${direction}"]`);
    const fallback = tableRef.current?.querySelector<HTMLButtonElement>(`[data-move="${id}:${direction === 'up' ? 'down' : 'up'}"]`);
    (wanted && !wanted.disabled ? wanted : fallback)?.focus();
  }, [rows]);

  const confirmDelete = useConfirmDelete<ShippingRate>({
    title: ts.confirmDelete,
    name: (rate) => `${rate.zoneName}, ${rate.name}`,
    onDelete: async (rate) => {
      try {
        await remove.mutateAsync({ channelId: channel.id, rateId: rate.id });
        toast.success(ts.toastDeleted);
      } catch (err) {
        toast.error(errorMessage(err, t.common.deleteFailed));
      }
    },
  });

  const onMove = async (index: number, direction: -1 | 1) => {
    const ids = moveRate(
      rows.map((r) => r.id),
      index,
      direction,
    );
    const moved = rows[index];
    pendingFocus.current = `${moved.id}:${direction === -1 ? 'up' : 'down'}`;
    try {
      await reorder.mutateAsync({ channelId: channel.id, ids });
      setStatus(fill(ts.moved, { name: `${moved.zoneName}, ${moved.name}`, position: index + direction + 1, count: rows.length }));
    } catch (err) {
      pendingFocus.current = null;
      toast.error(errorMessage(err, t.common.saveFailed));
    }
  };

  const addButton = canCreate ? (
    <Button type="button" size="sm" onClick={() => setDialog({})}>
      <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
      {ts.add}
    </Button>
  ) : undefined;

  let body;
  if (rates.isPending) body = <PageLoader fullScreen={false} />;
  else if (rates.isError) body = <ErrorState message={ts.loadFailed} onRetry={() => void rates.refetch()} />;
  else if (rows.length === 0) {
    body = <EmptyState icon={Truck} title={ts.empty} description={ts.emptyDescription} action={addButton} />;
  } else {
    body = (
      <div ref={tableRef} className="@container rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{ts.columns.zone}</TableHead>
              <TableHead className="hidden @2xl:table-cell">{ts.columns.countries}</TableHead>
              <TableHead>{ts.columns.rate}</TableHead>
              <TableHead>{ts.columns.price}</TableHead>
              <TableHead className="hidden @3xl:table-cell">{ts.columns.freeFrom}</TableHead>
              <TableHead>{ts.columns.status}</TableHead>
              <TableHead>
                <span className="sr-only">{ts.columns.actions}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((rate, index) => (
              <RateRow
                key={rate.id}
                rate={rate}
                index={index}
                count={rows.length}
                channel={channel}
                canUpdate={canUpdate}
                canDelete={canDelete}
                busy={reorder.isPending}
                onMove={(i, direction) => void onMove(i, direction)}
                onEdit={() => setDialog({ rate })}
                onDelete={() => confirmDelete.request(rate)}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  return (
    <SettingsSection title={ts.title} description={ts.description}>
      {rows.length > 0 && addButton && <div className="flex justify-end">{addButton}</div>}
      {body}
      {rows.length > 1 && <p className="text-xs text-muted-foreground">{ts.orderHint}</p>}
      {/* One announcement per move, in a region that is in the page before its text changes. */}
      <p role="status" className="sr-only">
        {status}
      </p>

      {dialog && (
        <ShippingRateDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
          channel={channel}
          rate={dialog.rate}
        />
      )}
      {confirmDelete.dialog}
    </SettingsSection>
  );
}
