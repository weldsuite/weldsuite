import { useNavigate, Link, getRouteApi } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCreateBill } from '@/hooks/queries/use-accounting-queries';
import { BillForm, type BillFormValues, type BillPrefill } from '../components/bill-form';
import { Button } from '@weldsuite/ui/components/button';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

const routeApi = getRouteApi('/weldbooks/bills/add/');

export default function AddBillPage() {
  const navigate = useNavigate();
  const createBill = useCreateBill();
  const search = routeApi.useSearch();
  const { t } = useI18n();
  const tb = t.accounting.billForm;

  const fromDocument = search.fromDocument;

  const prefillQuery = useQuery({
    queryKey: ['accounting', 'bills', 'from-document', fromDocument],
    queryFn: () => accountingApi.getBillFromDocument(fromDocument!),
    enabled: !!fromDocument,
  });

  const handleSubmit = (data: BillFormValues) => {
    const payload: Record<string, unknown> = { ...data };
    if (fromDocument) payload.sourceDocumentId = fromDocument;
    createBill.mutate(payload, {
      onSuccess: () => {
        navigate({ to: '/weldbooks/bills' });
      },
    });
  };

  if (fromDocument && prefillQuery.isLoading) return <PageLoader fullScreen={false} />;

  const prefill = prefillQuery.data?.data as BillPrefill | undefined;
  const confidence: number | undefined = prefill?.confidence?.overall;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/weldbooks/bills">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-semibold">{tb.newBill}</h1>
      </div>

      {prefill && (
        <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
          <Sparkles className="h-4 w-4 text-primary" />
          <span>
            {tb.prefilledFromOcr}
            {typeof confidence === 'number' ? ` ${tb.ocrConfidence.replace('{percent}', String(Math.round(confidence * 100)))}` : ''}
            {' '}{tb.verifyValues}
          </span>
        </div>
      )}

      <BillForm
        mode="add"
        prefill={prefill}
        onSubmit={handleSubmit}
        isSubmitting={createBill.isPending}
      />
    </div>
  );
}
