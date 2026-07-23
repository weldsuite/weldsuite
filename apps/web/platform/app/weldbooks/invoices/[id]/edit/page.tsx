import { useParams } from '@tanstack/react-router';
import { PageLoader } from '@/components/page-loader';
import { useAccountingInvoice } from '@/hooks/queries/use-accounting-queries';
import { InvoiceForm } from '../../components/invoice-form';

export default function EditInvoicePage() {
  const { id } = useParams({ strict: false });
  const { data, isLoading } = useAccountingInvoice(id!);

  if (isLoading) return <PageLoader fullScreen={false} />;

  return <InvoiceForm mode="edit" invoice={data?.data} />;
}
