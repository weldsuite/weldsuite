import { History, LayoutGrid, ListChecks } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the VAT return panel. Every tab is backed by a real
 * endpoint:
 *
 *   overview  → `/vat-returns/:id`  (the return, its headline totals and filing)
 *   boxes     → `/vat-returns/:id`  (the rubrieken of the aangifte)
 *   history   → `/api/audit-logs?entityType=vat_return`
 */
export interface VatReturnTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'boxes' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getVatReturnTabs(labels: { details: string; boxes: string; history: string }): VatReturnTab[] {
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
      id: 'boxes',
      label: labels.boxes,
      icon: ListChecks,
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
