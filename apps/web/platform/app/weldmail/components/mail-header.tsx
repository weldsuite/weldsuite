
import { useMemo } from 'react';
import { usePathname } from '@/lib/router';
import { BreadcrumbHeader, BreadcrumbSegment } from '@/components/breadcrumb-header';
import { useMailAccounts } from '@/hooks/queries/use-mail-queries';
import { SYSTEM_LABELS, type SystemLabelSlug } from '@/app/weldmail/lib/label-config';
import { useI18n } from '@/lib/i18n/provider';

interface MailHeaderProps {
  onWeldAgentToggle?: (isOpen: boolean) => void;
  onCalendarToggle?: (isOpen: boolean) => void;
  onNotificationsToggle?: (isOpen: boolean) => void;
  calendarOpen?: boolean;
}

function isId(part: string): boolean {
  // Match common ID patterns: msg_xxx, macc_xxx, or generic alphanum IDs 20+ chars
  return /^(msg_|macc_|mfld_|label_|thread_)/.test(part) || /^[a-zA-Z0-9_-]{20,}$/.test(part);
}

function capitalizeSegment(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');
}

// Label for a path part that follows an account ID (or "unified"): system label
// display name, or the capitalised user label. Null when the part is an ID.
function resolveLabelSegment(part: string): string | null {
  const labelConfig = SYSTEM_LABELS[part as SystemLabelSlug];
  if (labelConfig) return labelConfig.displayName;
  // User label — capitalize nicely
  if (!isId(part)) return capitalizeSegment(part);
  return null;
}

function resolveSegmentLabel(
  part: string,
  prevPart: string | null,
  staticSegments: Record<string, string>,
  accountEmailMap: Map<string, string>,
  messageLabel: string,
): string {
  // Check static segments first
  if (staticSegments[part]) return staticSegments[part];

  // Resolve mail account IDs to email addresses
  if (accountEmailMap.has(part)) return accountEmailMap.get(part)!;

  // Resolve label slugs to display names (when preceded by an account ID)
  if (prevPart && (accountEmailMap.has(prevPart) || prevPart === 'unified')) {
    const labelSegment = resolveLabelSegment(part);
    if (labelSegment !== null) return labelSegment;
  }

  // Skip IDs (message IDs, etc.) — show "Message" instead
  if (isId(part)) return messageLabel;

  // Default: capitalize
  return capitalizeSegment(part);
}

export function MailHeader({ onWeldAgentToggle, onCalendarToggle, onNotificationsToggle, calendarOpen }: Readonly<MailHeaderProps>) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { data: accountsData } = useMailAccounts();

  const STATIC_SEGMENTS: Record<string, string> = {
    ai: t.mail.header.ai,
    'smart-reply': t.mail.header.smartReply,
    summary: t.mail.header.summary,
    settings: t.mail.header.settings,
    accounts: t.mail.header.accounts,
    labels: t.mail.header.labels,
    domains: t.mail.header.domains,
    search: t.mail.header.search,
    inbox: t.mail.header.inbox,
    scheduled: t.mail.header.scheduled,
    snoozed: t.mail.header.snoozed,
    setup: t.mail.header.setup,
    compose: t.mail.header.compose,
    unified: t.mail.header.allAccounts,
  };

  // Build a lookup map from account ID to email address
  const accountEmailMap = useMemo(() => {
    const map = new Map<string, string>();
    const accounts = accountsData?.data || accountsData || [];
    if (Array.isArray(accounts)) {
      for (const account of accounts) {
        if (account.id && account.email) {
          map.set(account.id, account.email);
        }
      }
    }
    return map;
  }, [accountsData]);

  const segments: BreadcrumbSegment[] = [
    { label: t.mail.header.mail, href: '/weldmail' }
  ];

  // Build breadcrumbs from pathname
  const pathParts = pathname.split('/').filter(Boolean);
  for (let i = 1; i < pathParts.length; i++) {
    const part = pathParts[i];
    const prevPart = i > 1 ? pathParts[i - 1] : null;
    const href = '/' + pathParts.slice(0, i + 1).join('/');
    const label = resolveSegmentLabel(part, prevPart, STATIC_SEGMENTS, accountEmailMap, t.mail.header.message);
    segments.push({ label, href });
  }

  return (
    <BreadcrumbHeader
      segments={segments}
      showBackButton={true}
      onWeldAgentToggle={onWeldAgentToggle}
      onCalendarToggle={onCalendarToggle}
      onNotificationsToggle={onNotificationsToggle}
      calendarOpen={calendarOpen}
      moduleKey="mail"
    />
  );
}
