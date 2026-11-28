import {
  ArrowLeftRight,
  FileCheck2,
  FileText,
  History,
  LayoutGrid,
  MessageSquare,
  Receipt,
  ScrollText,
  Wallet,
} from 'lucide-react';
import type { ConfigurablePanelTab } from '@/components/objects/_shared/configurable-panel-tabs';

/**
 * Tab descriptors for the WeldBooks contact panel. Every tab is backed by a
 * real endpoint:
 *
 *   overview    → `/accounting-contacts/:id`          (the contact record)
 *   invoices    → `/invoices?contactId=`              (customers, and contacts that are both)
 *   quotes      → `/accounting-quotes?contactId=`     (customers; Rust only, edition feature `books-quotes`)
 *   bills       → `/bills?contactId=`                 (suppliers, and contacts that are both)
 *   exemptions  → `/exemption-certificates?partyId=`  (US sales tax only)
 *   credit      → `/accounting-contacts/:id/credits`  (Rust only; shown while the contact has unapplied credit)
 *   history     → `/api/audit-logs?entityType=accounting_contact`
 *
 * With the contact page (edition feature `books-contact-page`) `overview` is the Overview (open items and the
 * timeline) and the old Details tab is `details`; `bankLines` (`/bank-transactions?contactId=`) and `chat` join them.
 */
export type WeldbooksContactTabId =
  | 'overview'
  | 'details'
  | 'invoices'
  | 'quotes'
  | 'bills'
  | 'bankLines'
  | 'credit'
  | 'exemptions'
  | 'chat'
  | 'history';

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
  /** Label of the Quotes tab. */
  quotes?: string;
  /** The edition has quotes (`books-quotes`) and the contact is a customer (or both). */
  showQuotes?: boolean;
  /** Label of the Credit tab. */
  credit?: string;
  /** The contact has credit left to apply (`books-bank-processing`). */
  showCredit?: boolean;
  /** The contact is a customer (or both): it has invoices. */
  showInvoices: boolean;
  /** The contact is a supplier (or both): it has bills. */
  showBills: boolean;
  /** US entity and the contact is (also) a customer: it can hold exemption certificates. */
  showExemptions: boolean;
  /** The contact page (`books-contact-page`): an Overview first, Bank lines and Chat, and Details as its own tab. */
  contactPage?: { overview: string; bankLines: string; chat: string };
}): WeldbooksContactTab[] {
  const page = labels.contactPage;
  const tabs: WeldbooksContactTab[] = [
    {
      id: 'overview',
      label: page ? page.overview : labels.details,
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
  if (labels.showQuotes && labels.quotes) {
    tabs.push({
      id: 'quotes',
      label: labels.quotes,
      icon: ScrollText,
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
  if (page) {
    tabs.push({
      id: 'bankLines',
      label: page.bankLines,
      icon: ArrowLeftRight,
      defaultVisibleInPanel: true,
      defaultVisibleInFullscreen: true,
    });
  }
  if (labels.showCredit && labels.credit) {
    tabs.push({
      id: 'credit',
      label: labels.credit,
      icon: Wallet,
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
  if (page) {
    tabs.push(
      {
        id: 'chat',
        label: page.chat,
        icon: MessageSquare,
        defaultVisibleInPanel: false,
        defaultVisibleInFullscreen: true,
      },
      {
        id: 'details',
        label: labels.details,
        icon: FileText,
        defaultVisibleInPanel: true,
        defaultVisibleInFullscreen: true,
      },
    );
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
