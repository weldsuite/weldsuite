import { useState } from 'react';
import { toast } from 'sonner';
import { useCreateAccountingCustomer } from '@/hooks/queries/use-accounting-queries';
import { useI18n } from '@/lib/i18n/provider';
import type { ContactPayload } from './contact-form';
import { existingPersonOf, type ExistingPerson } from './person-email-conflict-dialog';

/** The contact a 409 points at: the WeldCRM record picked is already this customer or supplier. */
function existingContactId(err: unknown): string | null {
  const body = (err as { status?: number; body?: unknown } | null)?.body;
  const details = (body as { error?: { details?: { contactId?: unknown } } } | undefined)?.error?.details;
  return typeof details?.contactId === 'string' ? details.contactId : null;
}

/**
 * Creating a customer or supplier, shared by the full add page and the quick
 * add dialog: the create call, the "a person with this email already exists"
 * choice (`conflict`, answered with `submit(payload, { linkPersonId })` or
 * `{ createSeparatePerson: true }`), and the "already in the books" refusal,
 * whose toast opens the existing contact.
 */
export function useCreateContact({
  onCreated,
  onOpenExisting,
}: Readonly<{
  /** The new contact's id, when the server returned it. */
  onCreated: (contactId: string | null) => void;
  onOpenExisting: (contactId: string) => void;
}>) {
  const createContact = useCreateAccountingCustomer();
  const { t } = useI18n();
  const tc = t.accounting.contacts;

  // A CRM person already has this email: the user decides whether to link to them or create a separate contact.
  const [conflict, setConflict] = useState<{ person: ExistingPerson; payload: ContactPayload } | null>(null);

  const submit = async (payload: ContactPayload, choice: Record<string, unknown> = {}) => {
    try {
      const res = await createContact.mutateAsync({ ...payload, ...choice });
      setConflict(null);
      toast.success(tc.contactCreated);
      const created = (res as { data?: { id?: unknown } } | undefined)?.data?.id;
      onCreated(typeof created === 'string' ? created : null);
    } catch (err) {
      const person = Object.keys(choice).length === 0 ? existingPersonOf(err) : null;
      if (person) {
        setConflict({ person, payload });
        return;
      }
      setConflict(null);
      const contactId = existingContactId(err);
      if (contactId) {
        toast.error(tc.alreadyInBooks, {
          description: err instanceof Error ? err.message : undefined,
          action: { label: tc.openExisting, onClick: () => onOpenExisting(contactId) },
        });
        return;
      }
      toast.error(tc.createFailed, {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  return { submit, conflict, clearConflict: () => setConflict(null), isPending: createContact.isPending };
}
