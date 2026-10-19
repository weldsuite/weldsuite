/**
 * The files an invoice produces or was made from: the PDF (the invoice's
 * designed template, else the entity's default, else the built-in layout) and
 * the original documents it was created from.
 */

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslations } from '@weldsuite/i18n/client';
import { layoutInvoice } from '@weldsuite/books-domain/invoice-template/layout';
import { renderInvoicePdf } from '@weldsuite/books-domain/invoice-template/pdf';
import type { useAccountingEntity } from '@/hooks/queries/use-accounting-queries';
import { invoiceTemplatesQuery, useInvoiceTemplates } from '@/hooks/queries/use-invoice-template-queries';
import { useExemptionCertificates } from '@/hooks/queries/use-weldbooks-tax-preview';
import { accountingApi } from '@/lib/api/domains/weldbooks';
import { fiscalDocumentsApi } from '@/lib/api/domains/weldbooks-fiscal-documents';
import { salesTaxPreviewApi, type InvoiceWithTax } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import { useI18n } from '@/lib/i18n/provider';
import { brComplianceNotices, brPixFor } from '@/lib/weldbooks/br-invoice';
import { exemptCertificateIdsOf } from '@/lib/weldbooks/document-tax';
import { downloadPdf, generateInvoicePdf, type BrInvoicePdfExtras } from '@/lib/weldbooks/invoice-pdf';
import { buildInvoiceDocumentData } from '@/lib/weldbooks/invoice-template-data';
import { useCountryLabel } from '@/lib/weldbooks/use-country-label';
import { useJurisdictionLabels } from '@/lib/weldbooks/use-jurisdiction';
import { useInvoiceDocumentLabels } from '@/lib/weldbooks/use-invoice-template-labels';

/** The exemption certificates an invoice's tax rows refer to, with the numbers the notice and the PDF print. */
export function useInvoiceCertificates(invoice: InvoiceWithTax | undefined) {
  const certificateIds = useMemo(() => exemptCertificateIdsOf(invoice?.taxBreakdown), [invoice?.taxBreakdown]);
  const certificates = useExemptionCertificates(certificateIds);
  const certificateNumbers = certificateIds
    .map((certificateId) => certificates.get(certificateId)?.certificateNumber ?? '')
    .filter((number) => number !== '');
  return { certificateIds, certificates, certificateNumbers };
}

interface UseInvoiceDocumentsInput {
  invoice: InvoiceWithTax | undefined;
  entity: ReturnType<typeof useAccountingEntity>['data'];
  entityId: string | null;
  certificateIds: string[];
  certificates: ReturnType<typeof useExemptionCertificates>;
}

export function useInvoiceDocuments({
  invoice,
  entity,
  entityId,
  certificateIds,
  certificates,
}: Readonly<UseInvoiceDocumentsInput>) {
  const { t } = useI18n();
  const st = useTranslations();
  const ti = t.accounting.invoiceDetail;
  const { features } = useJurisdictionLabels();
  const documentLabels = useInvoiceDocumentLabels();
  const country = useCountryLabel();
  const queryClient = useQueryClient();
  const [downloading, setDownloading] = useState(false);
  const [openingAttachment, setOpeningAttachment] = useState<number | null>(null);

  // Warms the cache; the download waits for the list itself, so it never prints the built-in layout by accident.
  useInvoiceTemplates(entityId);

  // The invoice's designed template, else the entity's default; none prints the built-in layout.
  const resolveTemplate = async () => {
    if (!entityId) return null;
    const templates = await queryClient.fetchQuery({ ...invoiceTemplatesQuery(entityId), staleTime: 60_000 });
    return templates.find((tpl) => tpl.id === invoice?.templateId) ?? templates.find((tpl) => tpl.isDefault) ?? null;
  };

  /** Brazil: the Pix QR, the authorised NF-e / NFS-e and the regime's statements the PDF prints. */
  const brPdfExtras = async (): Promise<BrInvoicePdfExtras | undefined> => {
    if (!invoice || !features.brTaxReturn) return undefined;
    const documents = features.fiscalDocuments
      ? await fiscalDocumentsApi
          .list({ sourceType: 'invoice', sourceId: invoice.id, status: 'authorized' })
          .then((res) => res.data)
          .catch(() => [])
      : [];
    const authorized = documents[0];
    const kinds = t.weldbooksBr.fiscal.kinds as Record<string, string>;
    return {
      pix: brPixFor(invoice, entity),
      fiscalDocument: authorized
        ? { label: kinds[authorized.kind] ?? authorized.kind.toUpperCase(), number: authorized.number, accessKey: authorized.accessKey }
        : null,
      notices: brComplianceNotices(entity, {
        hasExport: Boolean(invoice.taxBreakdown?.some((row) => row.taxCategoryCode === 'export_goods')),
      }),
    };
  };

  /** The notice names the certificates; read the ones not loaded yet (a user without tax access just gets no number). */
  const loadCertificateNumbers = async (): Promise<string[]> => {
    const numbers = await Promise.all(
      certificateIds.map(
        async (certificateId) =>
          certificates.get(certificateId)?.certificateNumber ??
          (await salesTaxPreviewApi
            .getExemptionCertificate(certificateId)
            .then((res) => res.data.certificateNumber)
            .catch(() => null)),
      ),
    );
    return numbers.filter((number): number is string => Boolean(number));
  };

  const download = async () => {
    if (!invoice) return;
    setDownloading(true);
    try {
      const numbers = await loadCertificateNumbers();
      const pdfEntity = entity ?? { name: st('sweep.weldbooks.invoiceDetail.yourCompanyFallback') };
      const br = await brPdfExtras();
      const template = await resolveTemplate();
      const bytes = template
        ? await renderInvoicePdf(
            layoutInvoice(
              template.document,
              buildInvoiceDocumentData(invoice, pdfEntity, {
                pdfLabels: documentLabels.pdfLabels,
                labels: documentLabels.labels,
                formatDate: documentLabels.formatDate,
                countryName: country,
                certificateNumbers: numbers,
                br,
              }),
            ),
            { title: invoice.invoiceNumber ?? undefined },
          )
        : await generateInvoicePdf(invoice, pdfEntity, {
            labels: documentLabels.pdfLabels,
            formatDate: documentLabels.formatDate,
            countryName: country,
            certificateNumbers: numbers,
            br,
          });
      downloadPdf(bytes, (invoice.invoiceNumber || 'invoice') + '.pdf');
    } catch {
      toast.error(ti.failedToPdf);
    } finally {
      setDownloading(false);
    }
  };

  const openAttachment = async (index: number, fallbackName: string) => {
    if (!invoice) return;
    setOpeningAttachment(index);
    try {
      const { blob, filename } = await accountingApi.getInvoiceAttachment(invoice.id, index);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.download = filename || fallbackName;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error(ti.failedToOpenAttachment);
    } finally {
      setOpeningAttachment(null);
    }
  };

  return { downloading, download, openingAttachment, openAttachment };
}
