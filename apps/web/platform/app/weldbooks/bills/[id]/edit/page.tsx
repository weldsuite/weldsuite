import { Link, useParams, useNavigate } from '@tanstack/react-router';
import { PageLoader } from '@/components/page-loader';
import {
  useAccountingBill,
  useUpdateBill,
} from '@/hooks/queries/use-accounting-queries';
import { BillForm, type BillFormValues } from '../../components/bill-form';
import { Button } from '@weldsuite/ui/components/button';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';

export default function EditBillPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const { data, isLoading } = useAccountingBill(id);
  const updateBill = useUpdateBill();
  const { t } = useI18n();
  const tb = t.accounting.billForm;

  if (isLoading) return <PageLoader fullScreen={false} />;

  const bill = data?.data;
  if (!bill) {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">{tb.billNotFound}</p>
        <Link to="/weldbooks/bills">
          <Button variant="link" className="mt-2">{tb.backToBills}</Button>
        </Link>
      </div>
    );
  }

  const handleSubmit = (formData: BillFormValues) => {
    updateBill.mutate(
      { id, data: formData as unknown as Record<string, unknown> },
      {
        onSuccess: () => {
          navigate({ to: `/weldbooks/bills/${id}` as any });
        },
      },
    );
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link to={`/weldbooks/bills/${id}` as any}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-semibold">{tb.editBill.replace('{number}', bill.billNumber ?? '')}</h1>
      </div>

      <BillForm
        mode="edit"
        bill={bill}
        onSubmit={handleSubmit}
        isSubmitting={updateBill.isPending}
      />
    </div>
  );
}
