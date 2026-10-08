import { toast } from 'sonner';
import { useNavigate, Link } from '@tanstack/react-router';
import { useCreateAccountingCustomer } from '@/hooks/queries/use-accounting-queries';
import { Button } from '@weldsuite/ui/components/button';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { ContactForm, type ContactPayload } from '../components/contact-form';

export default function AddContactPage() {
  const navigate = useNavigate();
  const createContact = useCreateAccountingCustomer();
  const { t } = useI18n();
  const tc = t.accounting.contacts;

  const onSubmit = async (payload: ContactPayload) => {
    try {
      await createContact.mutateAsync({ ...payload });
      toast.success(tc.contactCreated);
      navigate({ to: '/weldbooks/customers' });
    } catch (err) {
      toast.error(tc.createFailed, {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

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
    </div>
  );
}
