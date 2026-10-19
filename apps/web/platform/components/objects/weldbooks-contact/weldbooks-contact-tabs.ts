import { FileCheck2, History, LayoutGrid } from 'lucide-react';
import type { ObjectPanelTabDescriptor } from '@/components/object-panel';

/**
 * Tab descriptors for the WeldBooks contact panel. Every tab is backed by a
 * real endpoint:
 *
 *   overview    → `/accounting-contacts/:id`          (the contact record)
 *   exemptions  → `/exemption-certificates?partyId=`  (US sales tax only)
 *   history     → `/api/audit-logs?entityType=accounting_contact`
 */
export interface WeldbooksContactTab extends ObjectPanelTabDescriptor {
  id: 'overview' | 'exemptions' | 'history';
  defaultVisibleInPanel?: boolean;
  defaultVisibleInFullscreen?: boolean;
  required?: boolean;
}

export function getWeldbooksContactTabs(labels: {
  details: string;
  exemptions: string;
  history: string;
  /** US entity and the contact is (also) a customer: it can hold exemption certificates. */
  showExemptions: boolean;
}): WeldbooksContactTab[] {
  const tabs: WeldbooksContactTab[] = [
    {
      id: 'overview',
      label: labels.details,
      icon: LayoutGrid,
      required: true,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    },
  ];
  if (labels.showExemptions) {
    tabs.push({
      id: 'exemptions',
      label: labels.exemptions,
      icon: FileCheck2,
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
