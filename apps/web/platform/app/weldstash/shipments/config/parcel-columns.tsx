import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import type { Parcel } from '@weldsuite/app-api-client/schemas/shipping';
import type { ColumnDef } from '@/components/panel-entity-list';
import { formatDate } from '@/app/weldstash/lib/numbers';
import { parcelStatusLabel, parcelStatusTone } from '@/app/weldstash/shipping/lib/parcel-status';
import { getLocale, getTranslations } from '@/lib/i18n';

/** The recipient on one line: company or name, then the city. */
export function recipientSummary(parcel: Parcel): string {
  const who = parcel.recipientCompany || parcel.recipientName || '';
  const city = [parcel.recipientAddress?.city, parcel.recipientAddress?.country].filter(Boolean).join(', ');
  return [who, city].filter(Boolean).join(' · ');
}

export function buildParcelColumns(): ColumnDef<Parcel>[] {
  const t = getTranslations('weldstash').shipping;
  const locale = getLocale();
  return [
    {
      id: 'status',
      header: t.shipments.colStatus,
      width: 'w-[160px]',
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <SoftBadge tone={parcelStatusTone(row.status)}>{parcelStatusLabel(t.statuses, row.status)}</SoftBadge>
          {row.isReturn ? <SoftBadge tone="neutral">{t.shipments.returnBadge}</SoftBadge> : null}
        </span>
      ),
    },
    {
      id: 'tracking',
      header: t.shipments.colTracking,
      width: 'w-[200px]',
      render: (row) => {
        if (!row.trackingNumber) return <span className="text-muted-foreground">—</span>;
        if (!row.trackingUrl) return <span className="block truncate font-mono text-sm">{row.trackingNumber}</span>;
        return (
          <a
            href={row.trackingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate font-mono text-sm text-primary underline-offset-2 hover:underline"
          >
            {row.trackingNumber}
          </a>
        );
      },
    },
    {
      id: 'carrier',
      header: t.shipments.colCarrier,
      width: 'w-[140px]',
      render: (row) => <span className="block truncate text-muted-foreground">{row.carrierName || '—'}</span>,
    },
    {
      id: 'recipient',
      header: t.shipments.colRecipient,
      width: 'flex-1',
      render: (row) => <span className="block truncate">{recipientSummary(row) || '—'}</span>,
    },
    {
      id: 'order',
      header: t.shipments.colOrder,
      width: 'w-[120px]',
      render: (row) => <span className="block truncate text-muted-foreground">{row.orderNumber || '—'}</span>,
    },
    {
      id: 'created',
      header: t.shipments.colCreated,
      width: 'w-[120px]',
      render: (row) => <span className="text-muted-foreground tabular-nums">{formatDate(row.createdAt, locale) || '—'}</span>,
    },
    {
      id: 'shipped',
      header: t.shipments.colShipped,
      width: 'w-[120px]',
      render: (row) => <span className="text-muted-foreground tabular-nums">{formatDate(row.shippedAt, locale) || '—'}</span>,
    },
  ];
}
