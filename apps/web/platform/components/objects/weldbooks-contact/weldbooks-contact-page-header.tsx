/**
 * The header of the contact page (edition feature `books-contact-page`), under the name: who the
 * contact is (contact person, e-mail, payment terms, reminders), the actions (new invoice, new
 * quote, send statement, open in WeldCRM) and the four tiles.
 */

import { ExternalLink, FileText, Mail, Receipt, ScrollText, Send, User } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from '@weldsuite/ui/components/button';
import { useObjectPanel } from '@/components/object-panel';
import { useContactDefaults, useContactSummary } from '@/hooks/queries/use-weldbooks-contact-page-queries';
import { isQuotesAvailable } from '@/hooks/queries/use-weldbooks-sales-queries';
import type { Customer } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { contactDocumentTabs } from './weldbooks-contact-tabs';
import { ContactTiles, type ContactTileTarget } from './weldbooks-contact-tiles';

export type CrmRecord = { type: 'company' | 'person'; id: string };

/** A fact under the name: an icon, then the text. */
function Fact({ icon: Icon, children }: Readonly<{ icon?: typeof User; children: React.ReactNode }>) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {Icon ? <Icon className="size-3.5 flex-shrink-0" aria-hidden="true" /> : null}
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

export function ContactPageHeader({
  contact,
  crmRecord,
  canCreateInvoice,
  canCreateBill,
  canSeeTime,
  onOpenTile,
  onSendStatement,
}: Readonly<{
  contact: Customer;
  crmRecord: CrmRecord | null;
  canCreateInvoice: boolean;
  canCreateBill: boolean;
  canSeeTime: boolean;
  onOpenTile: (target: ContactTileTarget) => void;
  onSendStatement: () => void;
}>) {
  const { t } = useI18n();
  const copy = t.weldbooksContactPage;
  const { open: openPanel } = useObjectPanel();
  const summary = useContactSummary(contact.id);
  const defaults = useContactDefaults(contact.id);
  const { invoices: isCustomer, bills: isSupplier } = contactDocumentTabs(contact.role);
  const person = contact.contactPerson ?? null;
  const email = person?.email ?? contact.email ?? null;
  const terms = contact.paymentTermsDays;
  const archived = Boolean(contact.archivedAt);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-1 text-[13px] text-muted-foreground">
        {person ? (
          <Fact icon={User}>
            {copy.header.contactPerson}: {person.name}
          </Fact>
        ) : null}
        {email ? (
          <Fact icon={Mail}>
            <a href={`mailto:${email}`} className="hover:underline">
              {email}
            </a>
          </Fact>
        ) : null}
        {terms !== null && terms !== undefined ? <Fact>{copy.header.paysIn.replace('{days}', String(terms))}</Fact> : null}
        {defaults.data ? (
          <Fact>{defaults.data.remindersPaused ? copy.header.remindersPaused : copy.header.remindersOn}</Fact>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pt-3">
        {isCustomer && canCreateInvoice && !archived ? (
          <Button variant="outline" size="sm" asChild>
            <Link to="/weldbooks/invoices/add" search={{ contactId: contact.id }}>
              <Receipt className="mr-1 h-4 w-4" aria-hidden />
              {copy.actions.newInvoice}
            </Link>
          </Button>
        ) : null}
        {isCustomer && canCreateInvoice && !archived && isQuotesAvailable() ? (
          <Button variant="outline" size="sm" asChild>
            <Link to="/weldbooks/quotes/add" search={{ contactId: contact.id }}>
              <ScrollText className="mr-1 h-4 w-4" aria-hidden />
              {copy.actions.newQuote}
            </Link>
          </Button>
        ) : null}
        {isSupplier && canCreateBill && !archived ? (
          <Button variant="outline" size="sm" asChild>
            <Link to="/weldbooks/bills/add" search={{ contactId: contact.id }}>
              <FileText className="mr-1 h-4 w-4" aria-hidden />
              {copy.actions.newBill}
            </Link>
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={onSendStatement}>
          <Send className="mr-1 h-4 w-4" aria-hidden />
          {copy.actions.sendStatement}
        </Button>
        {crmRecord ? (
          <Button variant="ghost" size="sm" onClick={() => openPanel({ ...crmRecord, stack: true })}>
            <ExternalLink className="mr-1 h-4 w-4" aria-hidden />
            {copy.header.openInCrm}
          </Button>
        ) : null}
      </div>

      <ContactTiles
        contactId={contact.id}
        summary={summary.data}
        failed={summary.isError}
        showReceivable={isCustomer}
        showPayable={isSupplier}
        canSeeTime={canSeeTime}
        onOpen={onOpenTile}
      />
    </div>
  );
}
