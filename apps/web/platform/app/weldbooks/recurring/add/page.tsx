import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { RecurringInvoiceForm } from '../components/recurring-invoice-form';

export default function AddRecurringInvoicePage() {
  const { t } = useI18n();
  const router = useRouter();
  const trp = t.accounting.recurringPage;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{trp.addTitle}</h1>
      <RecurringInvoiceForm
        mode="add"
        onSaved={(id) => router.push(`/weldbooks/recurring/${id}`)}
        onCancel={() => router.push('/weldbooks/recurring')}
      />
    </div>
  );
}
