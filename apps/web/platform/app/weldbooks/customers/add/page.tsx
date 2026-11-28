import { useEffect, useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { useAtom } from 'jotai';
import { Button } from '@weldsuite/ui/components/button';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { withQuery } from '@/lib/with-query';
import { ContactForm, type ContactPayload } from '../components/contact-form';
import { contactPrefillAtom } from '../components/contact-prefill';
import { PersonEmailConflictDialog } from '../components/person-email-conflict-dialog';
import { useCreateContact } from '../components/use-create-contact';

/**
 * The full form for a new customer, or for a new supplier with `?role=supplier`.
 * Saving returns to that list with the new contact open in its side panel.
 */
export default function AddContactPage() {
  const router = useRouter();
  const search = useSearch({ strict: false }) as { role?: string };
  const role = search.role === 'supplier' ? 'supplier' : 'customer';
  // Back to the Contacts list, narrowed to the role the contact was added as.
  const listPath = '/weldbooks/contacts';
  const listQuery = `role=${role}`;
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const heading = role === 'supplier' ? t.accounting.suppliersPage.newSupplier : t.accounting.customersPage.newCustomer;
  const backText = role === 'supplier' ? tc.backToSuppliers : tc.backToCustomers;
  const openContact = (contactId: string) => router.push(withQuery(listPath, `${listQuery}&stack=weldbooks_contact:${contactId}`));
  const { submit, conflict, clearConflict, isPending } = useCreateContact({
    onCreated: (contactId) => (contactId ? openContact(contactId) : router.push(withQuery(listPath, listQuery))),
    onOpenExisting: openContact,
  });

  const onSubmit = (payload: ContactPayload) => submit(payload);

  // What the quick add dialog had typed, when "More details…" opened this form: taken once.
  const [handedOver, setHandedOver] = useAtom(contactPrefillAtom);
  const [prefill] = useState(handedOver);
  useEffect(() => {
    if (handedOver) setHandedOver(null);
  }, [handedOver, setHandedOver]);

  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link to={listPath} search={{ role }} aria-label={backText}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold">{heading}</h1>
      </div>

      <ContactForm
        mode="add"
        defaultRole={role}
        prefill={prefill ?? undefined}
        isPending={isPending}
        onSubmit={onSubmit}
        onCancel={() => router.push(withQuery(listPath, listQuery))}
      />

      <PersonEmailConflictDialog
        person={conflict?.person ?? null}
        isPending={isPending}
        onLink={(person) => conflict && void submit(conflict.payload, { linkPersonId: person.id })}
        onCreateSeparate={() => conflict && void submit(conflict.payload, { createSeparatePerson: true })}
        onCancel={clearConflict}
      />
    </div>
  );
}
