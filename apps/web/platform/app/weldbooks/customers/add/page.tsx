import { useState } from 'react';
import { toast } from 'sonner';
import { useNavigate, Link } from '@tanstack/react-router';
import { useCreateAccountingCustomer } from '@/hooks/queries/use-accounting-queries';
import { Button } from '@weldsuite/ui/components/button';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { ContactForm, type ContactPayload } from '../components/contact-form';
import {
  PersonEmailConflictDialog,
  existingPersonOf,
  type ExistingPerson,
} from '../components/person-email-conflict-dialog';

/** The contact a 409 points at: the WeldCRM record picked is already this customer or supplier. */
function existingContactId(err: unknown): string | null {
  const body = (err as { status?: number; body?: unknown } | null)?.body;
  const details = (body as { error?: { details?: { contactId?: unknown } } } | undefined)?.error?.details;
  return typeof details?.contactId === 'string' ? details.contactId : null;
}

export default function AddContactPage() {
  const navigate = useNavigate();
  const createContact = useCreateAccountingCustomer();
  const { t } = useI18n();
  const tc = t.accounting.contacts;

  // A CRM person already has this email: the user decides whether to link to them or create a separate contact.
  const [conflict, setConflict] = useState<{ person: ExistingPerson; payload: ContactPayload } | null>(null);

  const submit = async (payload: ContactPayload, choice: Record<string, unknown> = {}) => {
    try {
      await createContact.mutateAsync({ ...payload, ...choice });
      setConflict(null);
      toast.success(tc.contactCreated);
      navigate({ to: '/weldbooks/customers' });
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
          action: {
            label: tc.openExisting,
            onClick: () => navigate({ to: '/weldbooks/customers/$id', params: { id: contactId } }),
          },
        });
        return;
      }
      toast.error(tc.createFailed, {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const onSubmit = (payload: ContactPayload) => submit(payload);

  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/weldbooks/customers">
          <Button variant="ghost" size="icon" aria-label={tc.cancel}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-semibold">{tc.newContact}</h1>
      </div>

      <ContactForm
        mode="add"
        isPending={createContact.isPending}
        onSubmit={onSubmit}
        onCancel={() => navigate({ to: '/weldbooks/customers' })}
      />

      <PersonEmailConflictDialog
        person={conflict?.person ?? null}
        isPending={createContact.isPending}
        onLink={(person) => conflict && void submit(conflict.payload, { linkPersonId: person.id })}
        onCreateSeparate={() => conflict && void submit(conflict.payload, { createSeparatePerson: true })}
        onCancel={() => setConflict(null)}
      />
    </div>
  );
}
