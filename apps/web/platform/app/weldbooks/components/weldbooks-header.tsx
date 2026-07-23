import { usePathname } from '@/lib/router';
import { BreadcrumbHeader, type BreadcrumbSegment } from '@/components/breadcrumb-header';
import { EntitySwitcher } from '@/components/accounting/entity-switcher';
import { useI18n } from '@/lib/i18n/provider';

interface WeldbooksHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
}

function isIdLike(segment: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
    /^[a-z]{1,5}_[a-z0-9]+$/i.test(segment) ||
    /^\d+$/.test(segment)
  );
}

export function WeldbooksHeader({
  onWeldAgentToggle,
  onCalendarToggle,
  onNotificationsToggle,
}: WeldbooksHeaderProps) {
  const pathname = usePathname();
  const { t } = useI18n();
  const th = t.accounting.header;

  // Map URL segments to translated labels. Anything not in this map falls back
  // to title-casing the URL segment ("aged-receivables" → "Aged receivables").
  const segmentLabels: Record<string, string> = {
    weldbooks: th.weldbooks,
    invoices: th.invoices,
    'credit-notes': th.creditNotes,
    bills: th.bills,
    recurring: th.recurring,
    contacts: th.contacts,
    accounts: th.accounts,
    journal: th.journal,
    vat: th.vat,
    banking: th.banking,
    transactions: th.transactions,
    reconciliation: th.reconciliation,
    rules: th.rules,
    import: th.import,
    documents: th.documents,
    customers: th.customers,
    suppliers: th.suppliers,
    entities: th.entities,
    reports: th.reports,
    'profit-loss': th.profitLoss,
    'balance-sheet': th.balanceSheet,
    'trial-balance': th.trialBalance,
    'aged-receivables': th.agedReceivables,
    'aged-payables': th.agedPayables,
    'cash-flow': th.cashFlow,
    'general-ledger': th.generalLedger,
    settings: th.settings,
    dashboard: th.dashboard,
    add: th.add,
    edit: th.edit,
  };

  function labelFor(segment: string): string {
    if (segmentLabels[segment]) return segmentLabels[segment];
    // Title-case, replace dashes with spaces
    return segment
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Build breadcrumbs from the URL — same pattern as CommerceHeader.
  const segments: BreadcrumbSegment[] = [
    { label: th.weldbooks, href: '/weldbooks' },
  ];

  const parts = pathname.split('/').filter(Boolean);
  // parts[0] === 'weldbooks'; start from index 1
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const href = '/' + parts.slice(0, i + 1).join('/');
    const isLast = i === parts.length - 1;
    const isId = isIdLike(part);

    // Skip an ID segment entirely if it's followed by more segments (e.g. the
    // entity id in /weldbooks/banking/ba_abc/transactions) — keep only the
    // human-readable segment names in the trail.
    if (isId && !isLast) continue;

    const label = isId ? labelFor(parts[i - 1] ?? part) : labelFor(part);

    if (isLast || isId) {
      segments.push({ label: isId ? th.detail : label });
    } else {
      segments.push({ label, href });
    }
  }

  return (
    <BreadcrumbHeader
      segments={segments}
      onWeldAgentToggle={onWeldAgentToggle}
      onCalendarToggle={onCalendarToggle}
      onNotificationsToggle={onNotificationsToggle}
      moduleKey="weldbooks"
      actions={<EntitySwitcher />}
    />
  );
}
