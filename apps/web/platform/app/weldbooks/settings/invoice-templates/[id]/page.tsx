import { Link } from '@tanstack/react-router';
import { AlertCircle, ArrowLeft, FileQuestion } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@/components/page-loader';
import { useAccountingEntity } from '@/hooks/queries/use-accounting-queries';
import { useInvoiceTemplate } from '@/hooks/queries/use-invoice-template-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useParams } from '@/lib/router';
import { InvoiceTemplateDesigner } from '../designer/designer';

/** 404 from the API: the template was deleted or never existed. */
function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 404;
}

/** `/weldbooks/settings/invoice-templates/:id`: the invoice designer for one template. */
export default function InvoiceTemplateDesignerPage() {
  const { t } = useI18n();
  const td = t.accounting.invoiceTemplates.designer;
  const { id } = useParams<{ id: string }>();
  const template = useInvoiceTemplate(id);
  const entity = useAccountingEntity(template.data?.entityId);

  if (template.isLoading || (template.data && entity.isLoading)) return <PageLoader fullScreen={false} />;

  if (template.isError || !template.data) {
    const missing = isNotFound(template.error);
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        {missing ? (
          <FileQuestion className="h-10 w-10 text-muted-foreground" aria-hidden />
        ) : (
          <AlertCircle className="h-10 w-10 text-destructive" aria-hidden />
        )}
        <h1 className="text-lg font-semibold">{missing ? td.notFoundTitle : td.loadError}</h1>
        {missing ? <p className="max-w-sm text-sm text-muted-foreground">{td.notFoundDescription}</p> : null}
        <div className="flex gap-2">
          {missing ? null : (
            <Button variant="outline" size="sm" onClick={() => void template.refetch()}>
              {td.retry}
            </Button>
          )}
          <Button variant="outline" size="sm" asChild>
            <Link to="/weldbooks/settings/invoice-templates">
              <ArrowLeft aria-hidden />
              {td.back}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return <InvoiceTemplateDesigner key={template.data.id} template={template.data} entity={entity.data} />;
}
