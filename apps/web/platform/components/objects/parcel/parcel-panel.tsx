/**
 * Object panel of a parcel on the Shipments page: details, the carrier's
 * tracking history, label and customs downloads, "Refresh tracking" and
 * "Create return label".
 */

import { RefreshCw, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import type { Parcel, ParcelAddress } from '@weldsuite/app-api-client/schemas/shipping';
import { formatDate } from '@/app/weldstash/lib/numbers';
import { ParcelFileButtons } from '@/app/weldstash/shipping/components/parcel-file-buttons';
import { ShippingErrorNotice } from '@/app/weldstash/shipping/components/shipping-error-notice';
import { parcelStatusLabel, parcelStatusTone } from '@/app/weldstash/shipping/lib/parcel-status';
import { SimpleObjectPanel, SectionHeader, type ObjectPanelComponentProps } from '@/components/objects/_shared/simple-object-panel';
import { detailsTab } from '@/components/objects/_shared/focused-tabs';
import { useCreateReturnLabel, useParcel, useRefreshTracking } from '@/hooks/queries/use-shipping-queries';
import { getLocale, getTranslations } from '@/lib/i18n';

function formatAddress(address: ParcelAddress | null | undefined): string {
  if (!address) return '';
  const street =
    [address.street, `${address.houseNumber ?? ''}${address.houseNumberSuffix ?? ''}`.trim()].filter(Boolean).join(' ') ||
    address.line1 ||
    '';
  return [street, [address.postalCode, address.city].filter(Boolean).join(' '), address.country].filter(Boolean).join(', ');
}

function formatDateTime(value: string | null | undefined, locale: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function TrackingLink({ parcel }: Readonly<{ parcel: Parcel }>) {
  if (!parcel.trackingNumber) return <span className="text-muted-foreground">—</span>;
  if (!parcel.trackingUrl) return <span className="font-mono text-sm">{parcel.trackingNumber}</span>;
  return (
    <a href={parcel.trackingUrl} target="_blank" rel="noopener noreferrer" className="font-mono text-sm text-primary underline-offset-2 hover:underline">
      {parcel.trackingNumber}
    </a>
  );
}

export function ParcelPanel(props: Readonly<ObjectPanelComponentProps>) {
  const ts = getTranslations('weldstash').shipping;
  const t = ts.panel;
  const locale = getLocale();
  const { can } = usePermissions();
  const { data, isLoading, error } = useParcel(props.id);
  const refresh = useRefreshTracking();
  const createReturn = useCreateReturnLabel();
  const parcel = data;

  const canUpdate = can('weldstash:parcels:update');
  const canCreate = can('weldstash:parcels:create');
  // Newest first; events without a time go last.
  const history = [...(parcel?.statusHistory ?? [])].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  const canReturn = !!parcel && !parcel.isReturn && parcel.status !== 'cancelled' && parcel.status !== 'draft' && parcel.status !== 'labelling';

  const fields = parcel
    ? [
        { label: t.carrier, value: parcel.carrierName },
        { label: t.service, value: parcel.serviceType },
        { label: t.order, value: parcel.orderNumber },
        { label: t.recipient, value: [parcel.recipientCompany, parcel.recipientName].filter(Boolean).join(' · ') },
        { label: t.address, value: formatAddress(parcel.recipientAddress) },
        { label: t.weight, value: parcel.weight ? t.weightValue.replace('{weight}', parcel.weight) : null },
        { label: t.servicePoint, value: parcel.servicePoint?.name },
        { label: t.shippedAt, value: formatDate(parcel.shippedAt, locale), tabular: true },
        { label: t.estimatedDelivery, value: formatDate(parcel.estimatedDeliveryDate, locale), tabular: true },
        { label: t.delivered, value: formatDate(parcel.actualDeliveryDate, locale), tabular: true },
        {
          label: t.lastScan,
          value: [formatDateTime(parcel.lastScanDate, locale), parcel.lastScanLocation].filter(Boolean).join(' · '),
        },
        {
          label: t.shippingCost,
          value:
            parcel.shippingCost?.credits !== null && parcel.shippingCost?.credits !== undefined
              ? ts.labels.priceCredits.replace('{credits}', String(parcel.shippingCost.credits))
              : null,
        },
      ]
    : [];

  return (
    <SimpleObjectPanel
      {...props}
      objectType="parcel"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!parcel}
      title={parcel?.trackingNumber || parcel?.orderNumber || t.title}
      subtitle={parcel ? [parcel.carrierName, parcel.orderNumber].filter(Boolean).join(' · ') : undefined}
      tabs={[detailsTab(t.tabDetails)]}
      statusBadges={
        parcel && (
          <span className="flex flex-wrap items-center gap-1.5">
            <SoftBadge tone={parcelStatusTone(parcel.status)}>{parcelStatusLabel(ts.statuses, parcel.status)}</SoftBadge>
            {parcel.isReturn ? <SoftBadge tone="neutral">{ts.shipments.returnBadge}</SoftBadge> : null}
          </span>
        )
      }
      fields={fields}
      extras={
        parcel ? (
          <div className="space-y-3 pb-4">
            <div className="flex flex-wrap items-center gap-2 px-4">
              <span className="text-xs text-muted-foreground">{t.tracking}</span>
              <TrackingLink parcel={parcel} />
            </div>

            {canUpdate || canCreate ? (
              <div className="flex flex-wrap gap-2 px-4">
                {canUpdate ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={refresh.isPending}
                    onClick={() =>
                      refresh.mutate(parcel.id, {
                        onSuccess: () => toast.success(t.refreshed),
                        onError: (err) => toast.error((err as Error).message || t.refreshFailed),
                      })
                    }
                  >
                    {refresh.isPending ? <InlineSpinner /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
                    {t.refresh}
                  </Button>
                ) : null}
                {canCreate && canReturn ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={createReturn.isPending}
                    onClick={() =>
                      createReturn.mutate(
                        { id: parcel.id },
                        {
                          onSuccess: () => toast.success(t.returnCreated),
                          onError: () => undefined,
                        },
                      )
                    }
                  >
                    {createReturn.isPending ? <InlineSpinner /> : <Undo2 className="size-3.5" aria-hidden="true" />}
                    {t.returnLabel}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {createReturn.isError ? (
              <div className="px-4">
                <ShippingErrorNotice error={createReturn.error} title={t.returnFailed} />
              </div>
            ) : null}

            <SectionHeader>{t.files}</SectionHeader>
            <div className="space-y-2 px-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm">{t.label}</span>
                <ParcelFileButtons parcelId={parcel.id} kind="label" format={parcel.labelFormat} subject={t.label} fileName={`label-${parcel.trackingNumber ?? parcel.id}`} />
              </div>
              {parcel.customsFormUrl ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm">{t.customsDocument}</span>
                  <ParcelFileButtons parcelId={parcel.id} kind="customs" subject={t.customsDocument} fileName={`customs-${parcel.trackingNumber ?? parcel.id}`} />
                </div>
              ) : null}
            </div>

            {parcel.returnParcels.length > 0 ? (
              <>
                <SectionHeader>{t.returns}</SectionHeader>
                <ul className="space-y-2 px-4">
                  {parcel.returnParcels.map((returnParcel) => (
                    <li key={returnParcel.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                      <div className="min-w-0 space-y-1">
                        <TrackingLink parcel={returnParcel} />
                        <div>
                          <SoftBadge tone={parcelStatusTone(returnParcel.status)}>{parcelStatusLabel(ts.statuses, returnParcel.status)}</SoftBadge>
                        </div>
                      </div>
                      <ParcelFileButtons parcelId={returnParcel.id} kind="label" format={returnParcel.labelFormat} subject={ts.labels.returnLabelResult} fileName={`return-${returnParcel.trackingNumber ?? returnParcel.id}`} />
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <SectionHeader>{t.timeline}</SectionHeader>
            {history.length === 0 ? (
              <p className="px-4 text-sm text-muted-foreground">{t.timelineEmpty}</p>
            ) : (
              <ol className="mx-4 space-y-3 border-s ps-4">
                {history.map((event) => (
                  <li key={`${event.at}-${event.code ?? ''}-${event.description ?? ''}`} className="relative text-sm">
                    <span aria-hidden="true" className="absolute -start-[21px] top-1.5 size-2 rounded-full bg-primary" />
                    <p className="font-medium">{event.description || event.code || '—'}</p>
                    <p className="text-xs text-muted-foreground">
                      {[formatDateTime(event.at, locale), event.location].filter(Boolean).join(' · ')}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ) : null
      }
    />
  );
}
