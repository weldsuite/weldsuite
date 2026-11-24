import type { SoftTone } from '@weldsuite/ui/components/soft-badge';
import type { ParcelStatus } from '@weldsuite/app-api-client/schemas/shipping';

/** Badge tone per parcel status. */
export const PARCEL_STATUS_TONES: Readonly<Record<ParcelStatus, SoftTone>> = {
  draft: 'neutral',
  labelling: 'warning',
  label_created: 'neutral',
  shipped: 'warning',
  in_transit: 'warning',
  at_service_point: 'warning',
  delivered: 'success',
  exception: 'danger',
  returned: 'neutral',
  cancelled: 'neutral',
};

export function parcelStatusTone(status: string): SoftTone {
  return PARCEL_STATUS_TONES[status as ParcelStatus] ?? 'neutral';
}

/** The label of a status, falling back to the raw code for one this build does not know. */
export function parcelStatusLabel(labels: Readonly<Record<string, string>>, status: string): string {
  return labels[status] ?? status.replace(/_/g, ' ');
}
