import { useQuery } from '@tanstack/react-query';
import { Badge } from '@weldsuite/ui/components/badge';
import { useTranslations } from '@weldsuite/i18n/client';
import { accountingApi, type BillDetail } from '@/lib/api/domains/weldbooks';
import {
  SimpleObjectPanel,
  formatPanelDate,
  formatPanelMoney,
  SectionHeader,
  ProseBlock,
  LineItemList,
  type ObjectPanelComponentProps,
} from '@/components/objects/_shared/simple-object-panel';

interface ApiResponse<T> {
  success?: boolean;
  data?: T;
}

function useBill(id: string) {
  return useQuery({
    queryKey: ['weldbooks', 'bill', id],
    queryFn: () => accountingApi.getBill(id) as Promise<ApiResponse<BillDetail>>,
    enabled: !!id,
  });
}

export function BillPanel(props: ObjectPanelComponentProps) {
  const t = useTranslations();
  const { id } = props;
  const { data, isLoading, error } = useBill(id);
  const bill = data?.data;

  const title = bill?.billNumber
    ? t('sweep.entities.billNumberTitle', { number: bill.billNumber })
    : t('sweep.entities.billFallbackTitle');
  const subtitle = bill?.contactName ?? undefined;

  return (
    <SimpleObjectPanel
      {...props}
      objectType="bill"
      isLoading={isLoading}
      hasError={!!error}
      hasData={!!bill}
      title={bill ? title : undefined}
      subtitle={subtitle ?? undefined}
      openHref={bill ? `/weldbooks/bills/${bill.id}` : undefined}
      statusBadges={bill && (
        <>
          <Badge variant="outline" className="capitalize">{bill.status}</Badge>
          {bill.approvalStatus && bill.approvalStatus !== 'approved' && (
            <Badge variant="outline" className="capitalize">{bill.approvalStatus}</Badge>
          )}
        </>
      )}
      fields={
        bill
          ? [
              { label: t('sweep.entities.fieldSupplier'), value: bill.contactName },
              { label: t('sweep.entities.fieldExternalRef'), value: bill.externalReference },
              { label: t('sweep.entities.fieldIssueDate'), value: formatPanelDate(bill.issueDate) },
              { label: t('sweep.entities.fieldDueDate'), value: formatPanelDate(bill.dueDate) },
              { label: t('sweep.entities.fieldSubtotal'), value: formatPanelMoney(bill.subtotal, bill.currency) },
              { label: t('sweep.entities.fieldTax'), value: formatPanelMoney(bill.taxTotal, bill.currency) },
              { label: t('sweep.entities.fieldTotal'), value: formatPanelMoney(bill.total, bill.currency) },
              { label: t('sweep.entities.fieldPaid'), value: formatPanelMoney(bill.amountPaid, bill.currency) },
              { label: t('sweep.entities.fieldBalanceDue'), value: formatPanelMoney(bill.balanceDue, bill.currency) },
            ]
          : undefined
      }
      extras={
        bill && (
          <>
            {bill.items && bill.items.length > 0 && (
              <>
                <SectionHeader>
                  {t('sweep.entities.lineItemsCount', { count: bill.items.length })}
                </SectionHeader>
                <LineItemList
                  items={bill.items}
                  getKey={(it) => it.id}
                  renderLeft={(it) => it.description}
                  renderRight={(it) => `${it.quantity ?? 1} × ${formatPanelMoney(it.unitPrice, bill.currency) ?? ''}`}
                />
              </>
            )}
            {bill.notes && (
              <>
                <SectionHeader>{t('sweep.entities.fieldNotes')}</SectionHeader>
                <ProseBlock>{bill.notes}</ProseBlock>
              </>
            )}
          </>
        )
      }
    />
  );
}
