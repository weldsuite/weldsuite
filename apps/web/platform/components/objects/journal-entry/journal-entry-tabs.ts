import { History, LayoutGrid, ListOrdered } from 'lucide-react';
import type { ConfigurablePanelTab } from '@/components/objects/_shared/configurable-panel-tabs';

/**
 * Tab descriptors for the journal entry panel. Every tab is backed by a real
 * endpoint:
 *
 *   overview → `/journal-entries/:id`            (the entry header and totals)
 *   lines    → `/journal-entries/:id` → `lines`  (the debit and credit lines)
 *   history  → `/api/audit-logs?entityType=journal_entry`
 */
export type JournalEntryTab = ConfigurablePanelTab<'overview' | 'lines' | 'history'>;

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
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
  ];
}
