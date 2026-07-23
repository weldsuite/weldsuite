
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

export function MailHeader({ onWeldAgentToggle, onCalendarToggle, onNotificationsToggle, calendarOpen }: MailHeaderProps) {
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
  if (pathParts.length > 1) {
    for (let i = 1; i < pathParts.length; i++) {
      const part = pathParts[i];
      const prevPart = i > 1 ? pathParts[i - 1] : null;

      // Check static segments first
      if (STATIC_SEGMENTS[part]) {
        const href = '/' + pathParts.slice(0, i + 1).join('/');
        segments.push({ label: STATIC_SEGMENTS[part], href });
        continue;
      }

      // Resolve mail account IDs to email addresses
      if (accountEmailMap.has(part)) {
        const href = '/' + pathParts.slice(0, i + 1).join('/');
        segments.push({ label: accountEmailMap.get(part)!, href });
        continue;
      }

      // Resolve label slugs to display names (when preceded by an account ID)
      if (prevPart && (accountEmailMap.has(prevPart) || prevPart === 'unified')) {
        const labelConfig = SYSTEM_LABELS[part as SystemLabelSlug];
        if (labelConfig) {
          const href = '/' + pathParts.slice(0, i + 1).join('/');
          segments.push({ label: labelConfig.displayName, href });
          continue;
        }
        // User label — capitalize nicely
        if (!isId(part)) {
          const href = '/' + pathParts.slice(0, i + 1).join('/');
          segments.push({ label: part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' '), href });
          continue;
        }
      }

      // Skip IDs (message IDs, etc.) — show "Message" instead
      if (isId(part)) {
        const href = '/' + pathParts.slice(0, i + 1).join('/');
        segments.push({ label: t.mail.header.message, href });
        continue;
      }

      // Default: capitalize
      const label = part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, ' ');
      const href = '/' + pathParts.slice(0, i + 1).join('/');
      segments.push({ label, href });
    }
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
