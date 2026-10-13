/**
 * Mailboxes & domains: the WeldHost domains connected to WeldReach, with their
 * DNS health, and the mailboxes created on them, with warmup progress, today's
 * sends against the current limit, and pause / resume / edit / delete. Creating
 * mailboxes costs money, so every write is gated on `reach_mailboxes:*`.
 */

import { useTranslations } from '@weldsuite/i18n/client';
import { DashboardPage, useReachBreadcrumbs } from '../components/page-kit';
import { useBillingReturn } from '../components/use-payment-method-setup';
import { DomainsSection } from './domains-section';
import { MailboxesSection } from './mailboxes-section';

export default function ReachMailboxesPage() {
  const t = useTranslations();
  useReachBreadcrumbs({ label: t('reach.nav.mailboxes') });
  // Back from Stripe after adding a card from the "New mailbox" dialog.
  useBillingReturn();

  return (
    <DashboardPage title={t('reach.mailboxes.title')} description={t('reach.mailboxes.description')}>
      <DomainsSection />
      <MailboxesSection />
    </DashboardPage>
  );
}
