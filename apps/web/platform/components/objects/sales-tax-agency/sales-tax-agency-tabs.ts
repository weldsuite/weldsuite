import { Building2, History, LayoutGrid, MapPinned, Scale } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the sales tax agency panel. Every tab is backed by a
 * real endpoint:
 *
 *   overview       → `/sales-tax-agencies/:id`                 (the registration)
 *   jurisdictions  → `/sales-tax-jurisdictions?agencyId=:id`   (with their dated rates)
 *   zones          → `/sales-tax-zones?agencyId=:id`
 *   rules          → `/sales-tax-rules?agencyId=:id`
 *   history        → `/api/audit-logs?entityType=sales_tax_agency`
 */
export interface SalesTaxAgencyTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'jurisdictions' | 'zones' | 'rules' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getSalesTaxAgencyTabs(labels: {
  details: string;
  jurisdictions: string;
  zones: string;
  rules: string;
  history: string;
}): SalesTaxAgencyTab[] {
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
      id: 'jurisdictions',
      label: labels.jurisdictions,
      icon: Building2,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'zones',
      label: labels.zones,
      icon: MapPinned,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
    {
      id: 'rules',
      label: labels.rules,
      icon: Scale,
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
