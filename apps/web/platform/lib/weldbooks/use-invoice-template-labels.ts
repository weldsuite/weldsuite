import { useI18n } from '@/lib/i18n/provider';
import { useDocumentTexts } from './use-document-texts';
import { useJurisdictionLabels } from './use-jurisdiction';
import { useWeldbooksFormat } from './use-weldbooks-format';
import type { InvoicePdfLabels } from './invoice-pdf';
import type { InvoiceTemplateDocumentLabels } from './invoice-template-data';

/**
 * Every label an invoice document prints, translated and in the entity's
 * jurisdiction's terms: the fixed PDF's labels and the template labels.
 */
export function useInvoiceDocumentLabels(): {
  pdfLabels: InvoicePdfLabels;
  labels: InvoiceTemplateDocumentLabels;
  formatDate: (value: string | null | undefined) => string;
} {
  const { t } = useI18n();
  const td = useDocumentTexts();
  const { labels } = useJurisdictionLabels();
  const { formatDate } = useWeldbooksFormat();
  return {
    pdfLabels: {
      ...t.accounting.invoicePdf,
      tax: labels.tax,
      taxId: labels.taxId,
      registrationId: labels.registrationId,
      creditNote: labels.creditNote.toUpperCase(),
      jurisdictionTax: td.pdf.jurisdictionTax,
      exempt: td.exempt,
      // India GST tax invoice
      placeOfSupply: t.weldbooksIn.gst.placeOfSupply,
      hsnSac: t.weldbooksIn.gst.hsnSac,
      outsideIndia: t.weldbooksIn.gst.placeOfSupplyOutside,
      // Brazil
      br: t.weldbooksBr.pdf,
    },
    labels: { ...t.accounting.invoiceTemplateDocument, creditNote: labels.creditNote },
    formatDate: (value) => formatDate(value, '-'),
  };
}
