import { History, LayoutGrid, MapPinned } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the exemption certificate panel. Every tab is backed by
 * a real endpoint:
 *
 *   overview  → `/exemption-certificates/:id`  (the certificate, its dates and scan)
 *   states    → `/exemption-certificates/:id`  (the states it covers, valid until per state)
 *   history   → `/api/audit-logs?entityType=exemption_certificate`
 */
export interface TaxExemptionCertificateTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'states' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getTaxExemptionCertificateTabs(labels: {
  details: string;
  states: string;
  history: string;
  statesCount?: number;
}): TaxExemptionCertificateTab[] {
  return [
    {
      id: 'overview',
      label: labels.details,
      icon: LayoutGrid,
      required: true,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'states',
      label: labels.states,
      icon: MapPinned,
      count: labels.statesCount,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'history',
      label: labels.history,
      icon: History,
      defaultVisibleInFullscreen: true,
    },
  ];
}
