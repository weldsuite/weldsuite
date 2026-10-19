import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import type { InvoiceStatusDialog } from './use-invoice-workflow';

type InvoiceTexts = ReturnType<typeof useI18n>['t']['accounting']['invoiceDetail'];
type JurisdictionFeatures = ReturnType<typeof useJurisdictionLabels>['features'];

/** Why writing an invoice off matters: VAT relief, a sales tax deduction, or neither. */
function uncollectibleDescription(ti: InvoiceTexts, features: JurisdictionFeatures): string {
  if (features?.vatReturn) return ti.uncollectibleDescriptionVat;
  if (features?.salesTax) return ti.uncollectibleDescriptionSalesTax;
  return ti.uncollectibleDescription;
}

/** Confirms cancelling an invoice or writing it off as uncollectible. */
export function StatusChangeDialog({
  status,
  loading,
  onClose,
  onConfirm,
}: Readonly<{
  status: InvoiceStatusDialog;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceDetail;
  const { features } = useJurisdictionLabels();
  const writeOff = status === 'uncollectible';
  return (
    <ConfirmDialog
      open={status !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={writeOff ? ti.uncollectibleTitle : ti.cancelInvoiceTitle}
      description={writeOff ? uncollectibleDescription(ti, features) : ti.cancelInvoiceDescription}
      confirmLabel={writeOff ? ti.confirmUncollectible : ti.confirmCancel}
      cancelLabel={ti.keepInvoice}
      variant="destructive"
      loading={loading}
      onConfirm={onConfirm}
    />
  );
}
