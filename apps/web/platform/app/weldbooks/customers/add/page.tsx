import { useNavigate, Link } from '@tanstack/react-router';
import { Button } from '@weldsuite/ui/components/button';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { ContactForm, type ContactPayload } from '../components/contact-form';
import { PersonEmailConflictDialog } from '../components/person-email-conflict-dialog';
import { useCreateContact } from '../components/use-create-contact';

export default function AddContactPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const { submit, conflict, clearConflict, isPending } = useCreateContact({
    onCreated: () => navigate({ to: '/weldbooks/customers' }),
    onOpenExisting: (contactId) => navigate({ to: '/weldbooks/customers/$id', params: { id: contactId } }),
  });

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
        isPending={isPending}
        onSubmit={onSubmit}
        onCancel={() => navigate({ to: '/weldbooks/customers' })}
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
