import { History, LayoutGrid, ListChecks, MessageSquare } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the VAT return panel. Every tab is backed by a real
 * endpoint:
 *
 *   overview  → `/vat-returns/:id`  (the return, its headline totals and filing)
 *   boxes     → `/vat-returns/:id`  (the rubrieken of the aangifte)
 *   chat      → the return's record chat, with the questions to the accountant (`books-questions`)
 *   history   → `/api/audit-logs?entityType=vat_return`
 */
export interface VatReturnTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'boxes' | 'chat' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getVatReturnTabs(labels: {
  details: string;
  boxes: string;
  history: string;
  /** Label of the Chat tab; with `showChat`. */
  chat?: string;
  /** The edition has questions to the accountant (`books-questions`). */
  showChat?: boolean;
}): VatReturnTab[] {
  const tabs: VatReturnTab[] = [
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
  ];
  if (labels.showChat && labels.chat) {
    tabs.push({
      id: 'chat',
      label: labels.chat,
      icon: MessageSquare,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    });
  }
  tabs.push({
    id: 'history',
    label: labels.history,
    icon: History,
    defaultVisibleInFullscreen: true,
  });
  return tabs;
}
