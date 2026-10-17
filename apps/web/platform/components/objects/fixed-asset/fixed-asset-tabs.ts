import { History, LayoutGrid, TrendingDown } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the fixed asset panel. Every tab is backed by a real
 * endpoint:
 *
 *   overview     → `/fixed-assets/:id`                      (the asset, what is posted, disposal)
 *   depreciation → `/fixed-assets/:id` → `books`, `ledgerRows` (the schedule of every book)
 *   history      → `/api/audit-logs?entityType=fixed_asset`
 */
export interface FixedAssetTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'depreciation' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getFixedAssetTabs(labels: {
  details: string;
  depreciation: string;
  history: string;
  booksCount?: number;
}): FixedAssetTab[] {
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
      id: 'depreciation',
      label: labels.depreciation,
      icon: TrendingDown,
      count: labels.booksCount,
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
