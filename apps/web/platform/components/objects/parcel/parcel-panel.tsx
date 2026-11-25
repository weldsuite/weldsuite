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
import type { Parcel, ParcelAddress, ParcelDetail, ParcelStatusEvent } from '@weldsuite/app-api-client/schemas/shipping';
import { formatDate } from '@/app/weldstash/lib/numbers';
import { ParcelFileButtons } from '@/app/weldstash/shipping/components/parcel-file-buttons';
import { ShippingErrorNotice } from '@/app/weldstash/shipping/components/shipping-error-notice';
import { parcelStatusLabel, parcelStatusTone } from '@/app/weldstash/shipping/lib/parcel-status';
import { SimpleObjectPanel, SectionHeader, type ObjectPanelComponentProps } from '@/components/objects/_shared/simple-object-panel';
import { detailsTab } from '@/components/objects/_shared/focused-tabs';
import { useCreateReturnLabel, useParcel, useRefreshTracking } from '@/hooks/queries/use-shipping-queries';
import { getLocale, getTranslations } from '@/lib/i18n';

interface PanelField {
  label: string;
  value: string | null | undefined;
  tabular?: boolean;
}

function formatAddress(address: ParcelAddress | null | undefined): string {
  if (!address) return '';
  const number = `${address.houseNumber ?? ''}${address.houseNumberSuffix ?? ''}`.trim();
  const street = [address.street, number].filter(Boolean).join(' ') || address.line1 || '';
  return [street, [address.postalCode, address.city].filter(Boolean).join(' '), address.country].filter(Boolean).join(', ');
}

function formatDateTime(value: string | null | undefined, locale: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function parcelFields(parcel: Parcel, locale: string): PanelField[] {
  const ts = getTranslations('weldstash').shipping;
  const t = ts.panel;
  const credits = parcel.shippingCost?.credits;
  return [
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
    { label: t.lastScan, value: [formatDateTime(parcel.lastScanDate, locale), parcel.lastScanLocation].filter(Boolean).join(' · ') },
    { label: t.shippingCost, value: credits === null || credits === undefined ? null : ts.labels.priceCredits.replace('{credits}', String(credits)) },
  ];
}

/** Newest first; events without a time go last. */
function sortedHistory(history: ParcelStatusEvent[] | null | undefined): ParcelStatusEvent[] {
  return [...(history ?? [])].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
}

function canCreateReturn(parcel: Parcel): boolean {
  return !parcel.isReturn && !['cancelled', 'draft', 'labelling'].includes(parcel.status);
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

/** "Refresh tracking" and "Create return label", as far as the caller may. */
function ParcelActions({ parcel }: Readonly<{ parcel: Parcel }>) {
  const t = getTranslations('weldstash').shipping.panel;
  const { can } = usePermissions();
  const refresh = useRefreshTracking();
  const createReturn = useCreateReturnLabel();
  const canUpdate = can('weldstash:parcels:update');
  const canReturn = can('weldstash:parcels:create') && canCreateReturn(parcel);
  if (!canUpdate && !canReturn) return null;

  const onRefresh = () =>
    refresh.mutate(parcel.id, {
      onSuccess: () => toast.success(t.refreshed),
      onError: (err) => toast.error((err as Error).message || t.refreshFailed),
    });
  // A failed return label shows its notice below the buttons.
  const onReturn = () => createReturn.mutate({ id: parcel.id }, { onSuccess: () => toast.success(t.returnCreated), onError: () => undefined });

  return (
    <>
      <div className="flex flex-wrap gap-2 px-4">
        {canUpdate ? (
          <Button type="button" size="sm" variant="outline" disabled={refresh.isPending} onClick={onRefresh}>
            {refresh.isPending ? <InlineSpinner /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
            {t.refresh}
          </Button>
        ) : null}
        {canReturn ? (
          <Button type="button" size="sm" variant="outline" disabled={createReturn.isPending} onClick={onReturn}>
            {createReturn.isPending ? <InlineSpinner /> : <Undo2 className="size-3.5" aria-hidden="true" />}
            {t.returnLabel}
          </Button>
        ) : null}
      </div>
      {createReturn.isError ? (
        <div className="px-4">
          <ShippingErrorNotice error={createReturn.error} title={t.returnFailed} />
        </div>
      ) : null}
    </>
  );
}

function ParcelFiles({ parcel }: Readonly<{ parcel: Parcel }>) {
  const t = getTranslations('weldstash').shipping.panel;
  const name = parcel.trackingNumber ?? parcel.id;
  return (
    <>
      <SectionHeader>{t.files}</SectionHeader>
      <div className="space-y-2 px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm">{t.label}</span>
          <ParcelFileButtons parcelId={parcel.id} kind="label" format={parcel.labelFormat} subject={t.label} fileName={`label-${name}`} />
        </div>
        {parcel.customsFormUrl ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">{t.customsDocument}</span>
            <ParcelFileButtons parcelId={parcel.id} kind="customs" subject={t.customsDocument} fileName={`customs-${name}`} />
          </div>
        ) : null}
      </div>
    </>
  );
}

function ReturnParcels({ parcels }: Readonly<{ parcels: Parcel[] }>) {
  const ts = getTranslations('weldstash').shipping;
  if (parcels.length === 0) return null;
  return (
    <>
      <SectionHeader>{ts.panel.returns}</SectionHeader>
      <ul className="space-y-2 px-4">
        {parcels.map((returnParcel) => (
          <li key={returnParcel.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
            <div className="min-w-0 space-y-1">
              <TrackingLink parcel={returnParcel} />
              <div>
                <SoftBadge tone={parcelStatusTone(returnParcel.status)}>{parcelStatusLabel(ts.statuses, returnParcel.status)}</SoftBadge>
              </div>
            </div>
            <ParcelFileButtons
              parcelId={returnParcel.id}
              kind="label"
              format={returnParcel.labelFormat}
              subject={ts.labels.returnLabelResult}
              fileName={`return-${returnParcel.trackingNumber ?? returnParcel.id}`}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

function Timeline({ history, locale }: Readonly<{ history: ParcelStatusEvent[]; locale: string }>) {
  const t = getTranslations('weldstash').shipping.panel;
  return (
    <>
      <SectionHeader>{t.timeline}</SectionHeader>
      {history.length === 0 ? (
        <p className="px-4 text-sm text-muted-foreground">{t.timelineEmpty}</p>
      ) : (
        <ol className="mx-4 space-y-3 border-s ps-4">
          {history.map((event) => (
            <li key={`${event.at}-${event.code ?? ''}-${event.description ?? ''}`} className="relative text-sm">
              <span aria-hidden="true" className="absolute -start-[21px] top-1.5 size-2 rounded-full bg-primary" />
              <p className="font-medium">{event.description || event.code || '—'}</p>
              <p className="text-xs text-muted-foreground">{[formatDateTime(event.at, locale), event.location].filter(Boolean).join(' · ')}</p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function ParcelExtras({ parcel, locale }: Readonly<{ parcel: ParcelDetail; locale: string }>) {
  const t = getTranslations('weldstash').shipping.panel;
  return (
    <div className="space-y-3 pb-4">
      <div className="flex flex-wrap items-center gap-2 px-4">
        <span className="text-xs text-muted-foreground">{t.tracking}</span>
        <TrackingLink parcel={parcel} />
      </div>
      <ParcelActions parcel={parcel} />
      <ParcelFiles parcel={parcel} />
      <ReturnParcels parcels={parcel.returnParcels} />
      <Timeline history={sortedHistory(parcel.statusHistory)} locale={locale} />
    </div>
  );
}

function ParcelBadges({ parcel }: Readonly<{ parcel: Parcel }>) {
  const ts = getTranslations('weldstash').shipping;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <SoftBadge tone={parcelStatusTone(parcel.status)}>{parcelStatusLabel(ts.statuses, parcel.status)}</SoftBadge>
      {parcel.isReturn ? <SoftBadge tone="neutral">{ts.shipments.returnBadge}</SoftBadge> : null}
    </span>
  );
}

export function ParcelPanel(props: Readonly<ObjectPanelComponentProps>) {
  const ts = getTranslations('weldstash').shipping;
  const locale = getLocale();
  const { data: parcel, isLoading, error } = useParcel(props.id);

  return (
    <SimpleObjectPanel
      {...props}
      objectType="parcel"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!parcel}
      title={parcel?.trackingNumber || parcel?.orderNumber || ts.panel.title}
      subtitle={parcel ? [parcel.carrierName, parcel.orderNumber].filter(Boolean).join(' · ') : undefined}
      tabs={[detailsTab(ts.panel.tabDetails)]}
      statusBadges={parcel ? <ParcelBadges parcel={parcel} /> : undefined}
      fields={parcel ? parcelFields(parcel, locale) : []}
      extras={parcel ? <ParcelExtras parcel={parcel} locale={locale} /> : null}
    />
  );
}
