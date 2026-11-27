import { FileCheck2, FileText, History, LayoutGrid, Receipt } from 'lucide-react';
import type { ConfigurablePanelTab } from '@/components/objects/_shared/configurable-panel-tabs';

/**
 * Tab descriptors for the WeldBooks contact panel. Every tab is backed by a
 * real endpoint:
 *
 *   overview    → `/accounting-contacts/:id`          (the contact record)
 *   invoices    → `/invoices?contactId=`              (customers, and contacts that are both)
 *   bills       → `/bills?contactId=`                 (suppliers, and contacts that are both)
 *   exemptions  → `/exemption-certificates?partyId=`  (US sales tax only)
 *   history     → `/api/audit-logs?entityType=accounting_contact`
 */
export type WeldbooksContactTabId = 'overview' | 'invoices' | 'bills' | 'exemptions' | 'history';

export type WeldbooksContactTab = ConfigurablePanelTab<WeldbooksContactTabId>;

/** Which of the contact's documents the panel offers: a customer has invoices, a supplier bills, a contact that is both has both. */
export function contactDocumentTabs(role: string | null | undefined): { invoices: boolean; bills: boolean } {
  return { invoices: role !== 'supplier', bills: role !== 'customer' };
}

export function getWeldbooksContactTabs(labels: {
  details: string;
  invoices: string;
  bills: string;
  exemptions: string;
  history: string;
  /** The contact is a customer (or both): it has invoices. */
  showInvoices: boolean;
  /** The contact is a supplier (or both): it has bills. */
  showBills: boolean;
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
  if (labels.showInvoices) {
    tabs.push({
      id: 'invoices',
      label: labels.invoices,
      icon: Receipt,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    });
  }
  if (labels.showBills) {
    tabs.push({
      id: 'bills',
      label: labels.bills,
      icon: FileText,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    });
  }
  if (labels.showExemptions) {
    tabs.push({
      id: 'exemptions',
      label: labels.exemptions,
      icon: FileCheck2,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    });
  }
  // The audit trail is reachable from the side panel too, not only in fullscreen.
  tabs.push({
    id: 'history',
    label: labels.history,
    icon: History,
    defaultVisibleInPanel: true,
    defaultVisibleInFullscreen: true,
  });
  return tabs;
}
