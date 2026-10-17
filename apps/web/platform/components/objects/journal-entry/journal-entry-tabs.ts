import { History, LayoutGrid, ListOrdered } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the journal entry panel. Every tab is backed by a real
 * endpoint:
 *
 *   overview → `/journal-entries/:id`            (the entry header and totals)
 *   lines    → `/journal-entries/:id` → `lines`  (the debit and credit lines)
 *   history  → `/api/audit-logs?entityType=journal_entry`
 */
export interface JournalEntryTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'lines' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getJournalEntryTabs(labels: {
  details: string;
  lines: string;
  history: string;
  linesCount?: number;
}): JournalEntryTab[] {
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
      id: 'lines',
      label: labels.lines,
      icon: ListOrdered,
      count: labels.linesCount,
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
