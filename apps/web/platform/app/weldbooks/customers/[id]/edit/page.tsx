import { toast } from 'sonner';
import { useParams, useNavigate, Link } from '@tanstack/react-router';
import {
  useAccountingCustomer,
  useUpdateAccountingCustomer,
} from '@/hooks/queries/use-accounting-queries';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';
import { ContactForm, type ContactPayload } from '../../components/contact-form';

export default function EditContactPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const { data, isLoading } = useAccountingCustomer(id);
  const updateContact = useUpdateAccountingCustomer();
  const { t } = useI18n();
  const tc = t.accounting.contacts;

  const contact = data?.data;

  if (isLoading) return <PageLoader fullScreen={false} />;

  if (!contact) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{tc.contactNotFound}</p>
      </div>
    );
  }

  const onSubmit = async (payload: ContactPayload) => {
    try {
      await updateContact.mutateAsync({ id, data: { ...payload } });
      toast.success(tc.contactUpdated);
      navigate({ to: '/weldbooks/customers/$id', params: { id } });
    } catch (err) {
      toast.error(tc.updateFailed, {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/weldbooks/customers/$id" params={{ id }}>
          <Button variant="ghost" size="icon" aria-label={tc.cancel}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-semibold">{tc.editContact}</h1>
      </div>

      <ContactForm
        mode="edit"
        contact={contact}
        isPending={updateContact.isPending}
        onSubmit={onSubmit}
        onCancel={() => navigate({ to: '/weldbooks/customers/$id', params: { id } })}
      />
    </div>
  );
}
