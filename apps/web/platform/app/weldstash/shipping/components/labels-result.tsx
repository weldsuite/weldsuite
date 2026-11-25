/**
 * The labels a pick list has: tracking numbers, print and download per label,
 * the return label and customs document, the carrier's warnings, "Void labels"
 * (until the list is shipped) and "Mark as shipped".
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { DialogFooter } from '@weldsuite/ui/components/dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import type { CreateLabelsResult, Parcel, PickListShipping } from '@weldsuite/app-api-client/schemas/shipping';
import { useVoidLabels } from '@/hooks/queries/use-shipping-queries';
import { useShipWeldstashPickList } from '@/hooks/queries/use-weldstash-queries';
import { getTranslations } from '@/lib/i18n';
import { parcelStatusLabel, parcelStatusTone } from '../lib/parcel-status';
import { ParcelFileButtons } from './parcel-file-buttons';
import { ShippingErrorNotice } from './shipping-error-notice';

interface LabelsResultProps {
  pickListId: string;
  shipping: PickListShipping;
  /** What the last "Create labels" returned, for its warnings and charge. */
  created: CreateLabelsResult | null;
  onVoided: () => void;
  onClose: () => void;
}

function TrackingLink({ parcel }: Readonly<{ parcel: Parcel }>) {
  if (!parcel.trackingNumber) return <span className="text-muted-foreground">—</span>;
  if (!parcel.trackingUrl) return <span className="font-mono text-sm">{parcel.trackingNumber}</span>;
  return (
    <a
      href={parcel.trackingUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-sm text-primary underline-offset-2 hover:underline"
    >
      {parcel.trackingNumber}
    </a>
  );
}

function ParcelRow({ parcel, subject, returnLabel }: Readonly<{ parcel: Parcel; subject: string; returnLabel?: boolean }>) {
  const ts = getTranslations('weldstash').shipping;
  const t = ts.labels;
  return (
    <li className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{subject}</p>
          <p className="text-xs text-muted-foreground">
            {t.tracking}: <TrackingLink parcel={parcel} />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SoftBadge tone={parcelStatusTone(parcel.status)}>{parcelStatusLabel(ts.statuses, parcel.status)}</SoftBadge>
          {parcel.labelUrl || parcel.status !== 'draft' ? (
            <ParcelFileButtons parcelId={parcel.id} kind="label" format={parcel.labelFormat} subject={subject} fileName={`label-${parcel.trackingNumber ?? parcel.id}`} />
          ) : null}
        </div>
      </div>
      {!returnLabel && parcel.customsFormUrl ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <p className="text-sm">{t.customsDocument}</p>
          <ParcelFileButtons parcelId={parcel.id} kind="customs" subject={`${t.customsDocument} ${subject}`} fileName={`customs-${parcel.trackingNumber ?? parcel.id}`} />
        </div>
      ) : null}
    </li>
  );
}

export function LabelsResult({ pickListId, shipping, created, onVoided, onClose }: Readonly<LabelsResultProps>) {
  const ts = getTranslations('weldstash').shipping;
  const t = ts.labels;
  const { can } = usePermissions();
  const voidLabels = useVoidLabels();
  const ship = useShipWeldstashPickList();
  const [confirmVoid, setConfirmVoid] = useState(false);

  const all: Parcel[] = created
    ? [...created.parcels, ...(created.returnParcel ? [created.returnParcel] : [])]
    : shipping.parcels;
  const outbound = all.filter((p) => !p.isReturn);
  const returns = all.filter((p) => p.isReturn);
  const isShipped = shipping.status === 'shipped';
  const canChange = can('weldstash:parcels:update');
  const warnings = created?.warnings ?? [];

  const doVoid = async () => {
    try {
      await voidLabels.mutateAsync(pickListId);
      toast.success(t.voided);
      setConfirmVoid(false);
      onVoided();
    } catch (err) {
      toast.error((err as Error).message || t.voidFailed);
    }
  };

  const markShipped = () =>
    ship.mutate(pickListId, {
      onSuccess: () => {
        toast.success(t.shipped);
        onClose();
      },
      onError: (err) => toast.error((err as Error).message || t.shipFailed),
    });

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">
          {t.resultTitle} <span className="font-normal text-muted-foreground">({t.resultCount.replace('{count}', String(outbound.length))})</span>
        </h3>
        <ul className="mt-2 space-y-2">
          {outbound.map((parcel, index) => (
            <ParcelRow key={parcel.id} parcel={parcel} subject={t.piece.replace('{number}', String(parcel.colloNumber ?? index + 1))} />
          ))}
          {returns.map((parcel) => (
            <ParcelRow key={parcel.id} parcel={parcel} subject={t.returnLabelResult} returnLabel />
          ))}
        </ul>
      </div>

      {warnings.length > 0 ? (
        <InfoBanner variant="warning" title={t.warnings}>
          <ul className="list-disc space-y-0.5 pl-4">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </InfoBanner>
      ) : null}

      {created?.credits !== null && created?.credits !== undefined ? (
        <p className="text-sm text-muted-foreground">
          {t.credits.replace('{credits}', new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(created.credits))}
        </p>
      ) : null}

      {isShipped ? <InfoBanner variant="info">{t.alreadyShipped}</InfoBanner> : null}
      {ship.isError ? <ShippingErrorNotice error={ship.error} title={t.shipFailed} /> : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t.close}
        </Button>
        {!isShipped && canChange ? (
          <>
            <Button type="button" variant="outline" onClick={() => setConfirmVoid(true)} disabled={voidLabels.isPending}>
              {t.voidAction}
            </Button>
            <Button type="button" onClick={markShipped} disabled={ship.isPending}>
              {ship.isPending ? <InlineSpinner /> : null}
              {t.markShipped}
            </Button>
          </>
        ) : null}
      </DialogFooter>

      <ConfirmDialog
        open={confirmVoid}
        onOpenChange={setConfirmVoid}
        title={t.voidTitle}
        description={t.voidDescription}
        confirmLabel={t.voidAction}
        variant="destructive"
        loading={voidLabels.isPending}
        onConfirm={doVoid}
      />
    </div>
  );
}
