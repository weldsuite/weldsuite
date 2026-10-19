import { History, LayoutGrid, ScrollText } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the payroll run panel. Every tab is backed by a real
 * endpoint:
 *
 *   overview  → `/payroll/imports/:id`  (the payroll, its totals and its source)
 *   journal   → `/payroll/imports/:id`  (the journal entry lines it posted)
 *   history   → `/api/audit-logs?entityType=payroll_import`
 */
export interface PayrollRunTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'journal' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getPayrollRunTabs(labels: {
  details: string;
  journal: string;
  history: string;
  journalCount?: number;
}): PayrollRunTab[] {
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
      id: 'journal',
      label: labels.journal,
      icon: ScrollText,
      count: labels.journalCount,
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
