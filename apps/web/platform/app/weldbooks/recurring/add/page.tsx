import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { RecurringInvoiceForm } from '../components/recurring-invoice-form';

export default function AddRecurringInvoicePage() {
  const { t } = useI18n();
  const router = useRouter();
  const trp = t.accounting.recurringPage;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button asChild variant="ghost" size="icon">
          <Link to="/weldbooks/recurring" aria-label={trp.backToRecurring}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold">{trp.addTitle}</h1>
      </div>
      <RecurringInvoiceForm
        mode="add"
        // The new template opens in its side panel on the list, like a new invoice.
        onSaved={(id) => router.push(`/weldbooks/recurring?stack=recurring_invoice:${id}`)}
        onCancel={() => router.push('/weldbooks/recurring')}
      />
    </div>
  );
}
