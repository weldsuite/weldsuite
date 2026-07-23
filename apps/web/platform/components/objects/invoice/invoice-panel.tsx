import { useQuery } from '@tanstack/react-query';
import { Badge } from '@weldsuite/ui/components/badge';
import { useTranslations } from '@weldsuite/i18n/client';
import { accountingApi, type InvoiceDetail } from '@/lib/api/domains/weldbooks';
import {
  SimpleObjectPanel,
  formatPanelDate,
  formatPanelMoney,
  SectionHeader,
  LineItemList,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';

interface ApiResponse<T> {
  success?: boolean;
  data?: T;
}

function useInvoice(id: string) {
  return useQuery({
    queryKey: ['weldbooks', 'invoice', id],
    queryFn: () => accountingApi.getInvoice(id) as Promise<ApiResponse<InvoiceDetail>>,
    enabled: !!id,
  });
}

export function InvoicePanel(props: ObjectPanelComponentProps) {
  const t = useTranslations();
  const { id } = props;
  const { data, isLoading, error } = useInvoice(id);
  const invoice = data?.data;

  const title = invoice?.invoiceNumber
    ? t('sweep.entities.invoiceNumberTitle', { number: invoice.invoiceNumber })
    : t('sweep.entities.invoiceFallbackTitle');
  const subtitle = invoice?.contactName ?? invoice?.contactEmail ?? undefined;

  return (
    <SimpleObjectPanel
      {...props}
      objectType="invoice"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!invoice}
      title={invoice ? title : undefined}
      subtitle={subtitle ?? undefined}
      openHref={invoice ? `/weldbooks/invoices/${invoice.id}` : undefined}
      statusBadges={invoice && (
        <>
          <Badge variant="outline" className="capitalize">{invoice.status}</Badge>
          {invoice.type && invoice.type !== 'standard' && (
            <Badge variant="outline" className="capitalize">{invoice.type}</Badge>
          )}
        </>
      )}
      fields={
        invoice
          ? [
              { label: t('sweep.entities.fieldContact'), value: invoice.contactName },
              { label: t('sweep.entities.fieldEmail'), value: invoice.contactEmail },
              { label: t('sweep.entities.fieldReference'), value: invoice.reference },
              { label: t('sweep.entities.fieldIssueDate'), value: formatPanelDate(invoice.issueDate) },
              { label: t('sweep.entities.fieldDueDate'), value: formatPanelDate(invoice.dueDate) },
              { label: t('sweep.entities.fieldSubtotal'), value: formatPanelMoney(invoice.subtotal, invoice.currency) },
              { label: t('sweep.entities.fieldTax'), value: formatPanelMoney(invoice.taxTotal, invoice.currency) },
              { label: t('sweep.entities.fieldTotal'), value: formatPanelMoney(invoice.total, invoice.currency) },
              { label: t('sweep.entities.fieldPaid'), value: formatPanelMoney(invoice.amountPaid, invoice.currency) },
              { label: t('sweep.entities.fieldBalanceDue'), value: formatPanelMoney(invoice.balanceDue, invoice.currency) },
            ]
          : undefined
      }
      extras={
        invoice && (
          <>
            {invoice.items && invoice.items.length > 0 && (
              <>
                <SectionHeader>
                  {t('sweep.entities.lineItemsCount', { count: invoice.items.length })}
                </SectionHeader>
                <LineItemList
                  items={invoice.items}
                  getKey={(it) => it.id}
                  renderLeft={(it) => it.description}
                  renderRight={(it) => `${it.quantity ?? 1} × ${formatPanelMoney(it.unitPrice, invoice.currency) ?? ''}`}
                />
              </>
            )}
            {invoice.payments && invoice.payments.length > 0 && (
              <>
                <SectionHeader>
                  {t('sweep.entities.paymentsCount', { count: invoice.payments.length })}
                </SectionHeader>
                <LineItemList
                  items={invoice.payments as Array<{ id: string; paidAt?: string; date?: string; amount?: string }>}
                  getKey={(p) => p.id}
                  renderLeft={(p) => formatPanelDate(p.paidAt ?? p.date) ?? ''}
                  renderRight={(p) => formatPanelMoney(p.amount, invoice.currency) ?? ''}
                />
              </>
            )}
          </>
        )
      }
    />
  );
}
