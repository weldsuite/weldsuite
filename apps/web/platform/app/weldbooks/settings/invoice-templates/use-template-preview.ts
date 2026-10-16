import { useMemo, useRef } from 'react';
import type { InvoiceDocumentData } from '@weldsuite/books-domain/invoice-template/data';
import { layoutInvoice, type InvoiceLayout } from '@weldsuite/books-domain/invoice-template/layout';
import type { InvoiceTemplateDocument } from '@weldsuite/books-domain/invoice-template/schema';
import { useCountryLabel } from '@/app/weldbooks/invoices/[id]/invoice-detail-sections';
import { useI18n } from '@/lib/i18n/provider';
import type { InvoicePdfEntity } from '@/lib/weldbooks/invoice-pdf';
import { buildInvoiceDocumentData, sampleInvoice } from '@/lib/weldbooks/invoice-template-data';
import { useInvoiceDocumentLabels } from '@/lib/weldbooks/use-invoice-template-labels';
import { withSampleContent } from './designer/model/sample-entity';

/** An accounting entity row, possibly a partial one while the full entity loads. */
type PreviewEntity = (Partial<InvoicePdfEntity> & { id?: string }) | undefined;

/** The previous reference while the new value serialises the same: keeps memoised layouts from recomputing every render. */
function useStableValue<T>(value: T): T {
  const ref = useRef<{ json: string; value: T } | null>(null);
  const json = JSON.stringify(value);
  if (!ref.current || ref.current.json !== json) ref.current = { json, value };
  return ref.current.value;
}

/**
 * The sample invoice every preview of a template is laid out with: the
 * entity's own currency, wording and branding, with sample text where the
 * company has none. `rows` is the number of line items.
 */
export function usePreviewData(entity: PreviewEntity, rows: number): { data: InvoiceDocumentData; entity: InvoicePdfEntity } {
  const { t } = useI18n();
  const source = useInvoiceDocumentLabels();
  const countryName = useCountryLabel();
  const sample = t.accounting.invoiceTemplates.sample;

  // The label objects and the formatters are rebuilt every render: key them by what they print.
  const stableLabels = useStableValue({ pdfLabels: source.pdfLabels, labels: source.labels });
  const stableEntity = useStableValue(entity);
  const formatRef = useRef(source.formatDate);
  formatRef.current = source.formatDate;
  const countryRef = useRef(countryName);
  countryRef.current = countryName;
  const formatKey = source.formatDate('2026-03-04');
  const countryKey = countryName('NL');

  return useMemo(() => {
    const previewEntity = withSampleContent(stableEntity, sample);
    const invoice = {
      ...sampleInvoice(previewEntity, { rows, customerName: sample.customerName, descriptions: [...sample.descriptions] }),
      notes: sample.notes,
    };
    const data = buildInvoiceDocumentData(
      invoice,
      previewEntity,
      {
        ...stableLabels,
        formatDate: (value) => formatRef.current(value),
        countryName: (code) => countryRef.current(code),
      },
      { name: sample.customerName, email: 'accounts@example.com' },
    );
    return { data, entity: previewEntity };
    // formatKey and countryKey stand in for the formatter closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableEntity, rows, sample, stableLabels, formatKey, countryKey]);
}

/** The laid-out invoice of a template; `null` while the draft cannot be laid out (no line-items table). */
export function useTemplateLayout(document: InvoiceTemplateDocument | undefined, data: InvoiceDocumentData | undefined): InvoiceLayout | null {
  return useMemo(() => {
    if (!document || !data) return null;
    try {
      return layoutInvoice(document, data);
    } catch {
      return null;
    }
  }, [document, data]);
}
